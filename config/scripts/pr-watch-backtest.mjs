// Replays a PR watch-rules / review-queue config over local git history so a rule
// can be judged before it is trusted. Offline: git log is the only data source.
// Usage: node config/scripts/pr-watch-backtest.mjs [--rules <file.yaml>] [--window <commits>] [--repo <path>]
//        [--horizon <days>] [--horizon2 <days>] [--half-life <hours>] [--stack-window <hours>]
//        [--null-rounds <n>] [--export <file.json>]
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { isTestPath } from '../../.github/scripts/pr-test-loc-table.mjs'
import {
  DAY_MS,
  DEFAULT_STACK_WINDOW_HOURS,
  areaOfPath,
  authorTypeOf,
  computeReworkMetrics,
  dominantArea,
  hasConventionalPrefix,
  mean,
  normalizeNumstatPath,
  scopeOf,
  ticketOf
} from './pr-rework-metrics.mjs'
import { dist, groupEffectLines, pct, pp } from './pr-rework-report.mjs'

const repoRoot = join(import.meta.dirname, '..', '..')
// Node >=23 strips erasable types, letting the backtest share the real evaluator.
// pathToFileURL: Windows absolute paths are not valid ESM specifiers.
const sharedUrl = (name) => pathToFileURL(join(repoRoot, 'src', 'shared', name)).href

export const norm = (s) =>
  s
    .replace(/\s*\([#!]\d+\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** One record per first-parent commit, with additions and deletions kept apart. */
export function parseNumstatLog(log) {
  const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/
  const commits = []
  let cur = null
  // Repeat sections belong to a merge's later parents: skip their numstat *and* body, or the
  // first-parent record absorbs a second diff of the same commit.
  let skipping = false
  for (const line of log.split('\n')) {
    if (line.startsWith('@@@')) {
      const [hash, author, date, iso, ...rest] = line.slice(3).split('|')
      const subject = rest.join('|')
      // Under -m git emits one diff section per merge parent (repeating the header);
      // --first-parent limits the walk, and the mainline diff is always first.
      if (cur && cur.hash === hash) {
        skipping = true
        continue
      }
      if (cur) {
        commits.push(cur)
      }
      skipping = false
      cur = { hash, author, date, iso, subject, body: [], paths: [], additions: 0, deletions: 0 }
      continue
    }
    if (!cur || skipping) {
      continue
    }
    const m = NUMSTAT_RE.exec(line)
    if (!m) {
      if (line.trim()) {
        cur.body.push(line.trim())
      }
      continue
    }
    cur.paths.push(normalizeNumstatPath(m[3]))
    if (m[1] !== '-') {
      cur.additions += Number(m[1])
    }
    if (m[2] !== '-') {
      cur.deletions += Number(m[2])
    }
  }
  if (cur) {
    commits.push(cur)
  }
  return commits
}

function readHistory(historyRepo, windowSize) {
  // --- history: one record per first-parent commit, sized against first parent so
  // merge-commit forges (Bitbucket, GitLab merge style) aggregate a whole PR. `-m`
  // keeps numstat on merges; squash repos are unaffected. Bodies are captured for
  // GitLab's "See merge request !N" trailers and for agent co-author trailers.
  // Why -w -M -C: whitespace-only churn and renames are not rework, and counting them
  // as such is the noisiest way to inflate the metric.
  return execFileSync(
    'git',
    [
      '-C',
      historyRepo,
      'log',
      `-${windowSize}`,
      '--first-parent',
      '-m',
      '--numstat',
      '-w',
      '-M',
      '-C',
      '--date=short',
      // %aI alongside %ad: the decay term needs hour resolution, the report wants a date.
      // %b on its own lines: the record parser folds any non-numstat line into the
      // body, which is where GitLab's "See merge request !N" trailer lives.
      '--format=@@@%H|%an|%ad|%aI|%s%n%b'
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28 }
  )
}

async function main() {
  const args = process.argv.slice(2)
  const argOf = (flag, fallback) => {
    const i = args.indexOf(flag)
    if (i === -1) {
      return fallback
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`${flag} requires a value`)
      process.exit(1)
    }
    return value
  }
  const number = (flag, fallback, { allowZero = false } = {}) => {
    const value = Number(argOf(flag, fallback))
    if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
      console.error(`${flag} must be a ${allowZero ? 'non-negative' : 'positive'} number`)
      process.exit(1)
    }
    return value
  }
  const { evaluateWatchRules, classifyReviewQueueTier, validateWatchRules, validateTierRules } =
    await import(sharedUrl('pr-watch-rules.ts'))
  const { identifyMergedPR, extractRevertTargets } = await import(
    sharedUrl('forge-merge-subject.ts')
  )

  const rulesPath = argOf('--rules', join(repoRoot, 'config', 'pr-watch-rules.example.yaml'))
  const windowSize = Number(argOf('--window', '8000'))
  if (!Number.isInteger(windowSize) || windowSize <= 0) {
    console.error('--window must be a positive integer')
    process.exit(1)
  }
  const historyRepo = argOf('--repo', repoRoot)
  const horizonDays = number('--horizon', '30')
  const horizon2Days = number('--horizon2', '90')
  const halfLifeHours = number('--half-life', '48')
  const stackWindowHours = number('--stack-window', String(DEFAULT_STACK_WINDOW_HOURS), {
    allowZero: true
  })
  const nullRounds = number('--null-rounds', '200', { allowZero: true })
  const exportPath = argOf('--export', null)
  const baseline = argOf('--baseline', 'span')
  if (baseline !== 'span' && baseline !== 'exposure') {
    console.error('--baseline must be span or exposure')
    process.exit(1)
  }

  const config = parseYaml(readFileSync(rulesPath, 'utf8'))
  const chipRules = config?.pr_watch ? validateWatchRules(config.pr_watch) : []
  const tierRules = config?.review_queue?.tiers ? validateTierRules(config.review_queue.tiers) : []
  if (chipRules.length === 0 && tierRules.length === 0) {
    console.error(`${rulesPath}: no pr_watch rules or review_queue.tiers found`)
    process.exit(1)
  }

  const commits = parseNumstatLog(readHistory(historyRepo, windowSize))

  // PR identity + revert labels via the shared forge-aware parser.
  const byTitle = new Map()
  for (const c of commits) {
    c.body = c.body.join('\n')
    c.pr = identifyMergedPR(c.subject, c.body)
    if (c.pr.number !== null && !/^revert\b/i.test(c.subject)) {
      byTitle.set(norm(c.subject), c.pr.number)
    }
  }
  const revertTargets = new Set()
  for (const c of commits) {
    const { targets, quotedTitle } = extractRevertTargets(c.subject, c.body)
    targets.forEach((t) => revertTargets.add(t))
    if (targets.length === 0 && quotedTitle && byTitle.has(norm(quotedTitle))) {
      revertTargets.add(byTitle.get(norm(quotedTitle)))
    }
  }

  const authorMerged = new Map()
  const prs = []
  const forgeCounts = new Map()
  let unidentified = 0
  for (const c of commits.toReversed()) {
    if (/^revert\b/i.test(c.subject)) {
      continue
    }
    if (c.pr.number === null) {
      unidentified += 1
      continue
    }
    forgeCounts.set(c.pr.forge, (forgeCounts.get(c.pr.forge) ?? 0) + 1)
    const prior = authorMerged.get(c.author) ?? 0
    authorMerged.set(c.author, prior + 1)
    prs.push({
      n: c.pr.number,
      date: c.date,
      t: Date.parse(c.iso),
      author: c.author,
      authorType: authorTypeOf(c.body),
      subject: c.subject,
      scope: scopeOf(c.subject),
      area: dominantArea(c.paths),
      ticket: ticketOf(c.subject),
      paths: c.paths,
      churn: c.additions + c.deletions,
      testFiles: c.paths.filter(isTestPath).length,
      breadth: new Set(c.paths.map(areaOfPath)).size,
      reverted: revertTargets.has(c.pr.number),
      input: {
        title: c.subject,
        author: c.author,
        paths: c.paths,
        files: c.paths.length,
        additions: c.additions,
        deletions: c.deletions,
        // Why keep churn: rules that genuinely want one magnitude still resolve, but the
        // split lets a deletion-heavy simplification stop sizing like an equal-sized rewrite.
        churn: c.additions + c.deletions,
        draft: false, // merged history: never draft, never conflicting
        mergeable: 'mergeable',
        authorMergedPRs: prior
      }
    })
  }

  const percentiles = {
    files: dist(prs.map((p) => p.input.files)),
    additions: dist(prs.map((p) => p.input.additions)),
    deletions: dist(prs.map((p) => p.input.deletions)),
    churn: dist(prs.map((p) => p.input.churn)),
    authorMergedPRs: dist(prs.map((p) => p.input.authorMergedPRs))
  }

  if (prs.length === 0) {
    console.error(
      `no merged PRs identified in the last ${windowSize} commits (unattributable merges: ${unidentified})`
    )
    process.exit(1)
  }
  const totalReverts = prs.filter((p) => p.reverted).length
  const months = ((new Date(prs.at(-1).date) - new Date(prs[0].date)) / 2.63e9).toFixed(1)
  const forgeSummary = [...forgeCounts.entries()].map(([f, n]) => `${f}:${n}`).join(' ')
  console.log(
    `history: ${prs.length} merged PRs over ${months} months (window ${windowSize} commits) · ${prs[0].date} … ${prs.at(-1).date}`
  )
  console.log(
    `merge subjects: ${forgeSummary || 'none identified'}${unidentified ? ` · unattributable merges excluded: ${unidentified}` : ''}`
  )
  console.log(
    `calibration: files p50=${percentiles.files.p50} p90=${percentiles.files.p90} · additions p50=${percentiles.additions.p50} p90=${percentiles.additions.p90} · deletions p50=${percentiles.deletions.p50} p90=${percentiles.deletions.p90} · churn p50=${percentiles.churn.p50} p90=${percentiles.churn.p90}`
  )
  const showReverts = totalReverts >= 20
  console.log(
    showReverts
      ? `revert labels: ${totalReverts}`
      : `revert labels: ${totalReverts} — below min-n 20, correlation column suppressed`
  )

  // --- label-free rework/lift, joined over the records already in memory (no second git pass)
  const times = prs.map((p) => p.t).filter((t) => Number.isFinite(t))
  const latestT = Math.max(...times)
  const spanDays = Math.max(1, (latestT - Math.min(...times)) / DAY_MS)
  const metricOpts = { halfLifeHours, spanDays, latestT, stackWindowHours, baseline }
  const metricsBy = {
    [horizonDays]: computeReworkMetrics(prs, { horizonDays, ...metricOpts }),
    [horizon2Days]: computeReworkMetrics(prs, { horizonDays: horizon2Days, ...metricOpts })
  }
  const primary = metricsBy[horizonDays]
  const scored = prs.filter((p) => !primary.get(p).censored)
  const censored = prs.length - scored.length
  const overall = (metrics, subset) => ({
    rework: mean(subset.map((p) => metrics.get(p).reworkRate)),
    expected: mean(subset.map((p) => metrics.get(p).expected)),
    lift: mean(subset.map((p) => metrics.get(p).lift)),
    decay: mean(subset.map((p) => metrics.get(p).decay)),
    decayLift: mean(subset.map((p) => metrics.get(p).decayLift)),
    containment: mean(subset.map((p) => metrics.get(p).containment)),
    asymmetry: mean(subset.map((p) => metrics.get(p).asymmetry))
  })
  console.log(`\n=== rework / lift (label-free) ===`)
  console.log(
    `scored ${scored.length} PRs · right-censored ${censored} merged inside the trailing ${horizonDays}d · baseline ${baseline} (span ${spanDays.toFixed(0)}d) · stacked-PR window ${stackWindowHours}h`
  )
  for (const h of [horizonDays, horizon2Days]) {
    const sub = prs.filter((p) => !metricsBy[h].get(p).censored)
    const o = overall(metricsBy[h], sub)
    console.log(
      `  @${String(h).padStart(3)}d  n=${String(sub.length).padStart(5)}  rework ${(o.rework * 100).toFixed(1)}%  expected ${(o.expected * 100).toFixed(1)}%  lift ${pp(o.lift)}  decay ${o.decay.toFixed(3)}  decay-lift ${pp(o.decayLift)}  containment ${o.containment.toFixed(3)}  asymmetry ${o.asymmetry.toFixed(3)}`
    )
  }

  // Why: a fix:-weighted view is only meaningful next to how often the label exists at all,
  // and coverage that varies by author type is differential error aligned with the comparison.
  const covered = prs.filter((p) => hasConventionalPrefix(p.subject)).length
  const coverage = covered / prs.length
  console.log(
    `label coverage: ${covered}/${prs.length} conventional-commit subjects (${pct(covered, prs.length)})`
  )
  const byType = new Map()
  for (const p of prs) {
    const row = byType.get(p.authorType) ?? { n: 0, ok: 0, scored: 0 }
    row.n += 1
    row.ok += hasConventionalPrefix(p.subject) ? 1 : 0
    row.scored += primary.get(p).censored ? 0 : 1
    byType.set(p.authorType, row)
  }
  console.log('  coverage by author type (agent = co-author trailer; untagged is not "human"):')
  for (const [type, r] of [...byType.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `    ${type.padEnd(12)} ${String(r.n).padStart(5)} PRs   conventional ${pct(r.ok, r.n).padStart(8)}   scored ${String(r.scored).padStart(5)}`
    )
  }
  const types = [...byType.values()]
  const coverageGap =
    types.length < 2 ? 0 : Math.abs(types[0].ok / types[0].n - types[1].ok / types[1].n)
  console.log(
    `  differential-discipline gap: ${(coverageGap * 100).toFixed(1)}pp between author types`
  )
  const showFixWeighted = coverage >= 0.6 && scored.length >= 20 && coverageGap <= 0.1
  if (showFixWeighted) {
    const fixShare = mean(scored.map((p) => primary.get(p).fixShare))
    console.log(
      `  secondary (label-dependent): ${(fixShare * 100).toFixed(1)}% of rework events are fix: subjects — coverage ${pct(covered, prs.length)}`
    )
  } else {
    console.log(
      `  secondary (label-dependent): SUPPRESSED — coverage ${pct(covered, prs.length)} (min 60%), n=${scored.length} (min 20), author-type gap ${(coverageGap * 100).toFixed(1)}pp (max 10.0pp)`
    )
  }

  // --- required null tests: every effect prints beside its shuffle control. Cells are
  // (merge month x file-heat quartile): agent share and repo-wide follow-up rate both rise
  // over the window, so a heat-only shuffle would let calendar drift look like authorship.
  const effectRows = (keyOf, metrics = primary) =>
    prs
      .filter((p) => !metrics.get(p).censored)
      .map((p) => ({
        group: keyOf(p),
        value: metrics.get(p).lift,
        stratum: metrics.get(p).expected,
        cell: p.date.slice(0, 7)
      }))
  const nullOpts = { rounds: nullRounds, minPRs: 20, strata: 4 }
  const effects = [
    [`by merge month (drift check)`, (p) => p.date.slice(0, 7), { ...nullOpts, cells: false }],
    [`by author`, (p) => p.author, nullOpts],
    [`by author type`, (p) => p.authorType, nullOpts],
    [
      `by title scope (label-dependent — ${pct(prs.filter((p) => p.scope).length, prs.length)} coverage)`,
      (p) => p.scope ?? '(none)',
      nullOpts
    ],
    [`by path area (label-free)`, (p) => p.area, nullOpts]
  ]
  for (const [label, keyOf, opts] of effects) {
    // Month cannot be its own shuffle cell: that would shuffle the effect away by construction.
    const rows = effectRows(keyOf).map((r) => (opts.cells === false ? { ...r, cell: '' } : r))
    for (const line of groupEffectLines(`lift@${horizonDays}d ${label}`, rows, opts)) {
      console.log(line)
    }
  }
  for (const line of groupEffectLines(
    `lift@${horizon2Days}d by author type`,
    effectRows((p) => p.authorType, metricsBy[horizon2Days]),
    nullOpts
  )) {
    console.log(line)
  }

  if (chipRules.length) {
    console.log(`\n=== pr_watch rules ===`)
    const header = `${'rule'.padEnd(24)}${'fires'.padStart(7)}   % of PRs${showReverts ? '   reverts caught' : ''}   rework@${horizonDays}d      lift`
    console.log(`${header}\n${'-'.repeat(header.length + 4)}`)
    for (const rule of chipRules) {
      const verdicts = prs.map((p) => evaluateWatchRules([rule], p.input, { percentiles })[0])
      const hits = prs.filter((_, i) => verdicts[i] && !verdicts[i].pending)
      const pendingCount = verdicts.filter((v) => v?.pending).length
      const caught = hits.filter((p) => p.reverted).length
      const scoredHits = hits.filter((p) => !primary.get(p).censored)
      let line = `${rule.name.slice(0, 23).padEnd(24)}${String(hits.length).padStart(7)}${pct(hits.length, prs.length).padStart(11)}`
      if (showReverts) {
        line += `   ${caught} / ${totalReverts}`
      }
      if (scoredHits.length >= 20) {
        const o = overall(primary, scoredHits)
        const reworkCell = `   ${(o.rework * 100).toFixed(0)}%`.padStart(13)
        const liftCell = `   ${pp(o.lift)}`.padStart(10)
        line += `${reworkCell}${liftCell}`
      } else {
        // Why: same min-n discipline as the revert column — small samples manufacture signal.
        line += `${'   n<20'.padStart(13)}        —`
      }
      console.log(line)
      if (hits.length === 0) {
        if (pendingCount === prs.length) {
          console.log('    UNEVALUABLE: needs data the backtest does not collect (labels/branch)')
          continue
        }
        console.log(
          prs.length >= 200
            ? '    DEAD: matched nothing across a large history — delete or fix it'
            : `    0 matches across ${prs.length} PRs / ${months} months — may just be a quiet area`
        )
      } else {
        if (hits.length >= 10 && hits.length / prs.length > 0.2) {
          console.log('    BROAD: matches over 20% of PRs — too wide to direct attention')
        }
        console.log(`    sample: ${hits.at(-1).subject.slice(0, 76)}`)
      }
    }
  }

  const tierOf = (p) => {
    const { tier, pending } = classifyReviewQueueTier(tierRules, p.input, { percentiles })
    return (tier ?? '(catch-all)') + (pending ? ' [pending]' : '')
  }
  if (tierRules.length) {
    console.log(`\n=== review_queue tiers (first-match) ===`)
    const counts = new Map()
    for (const p of prs) {
      const key = tierOf(p)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(
        `  ${name.padEnd(26)} ${String(n).padStart(6)}  ${pct(n, prs.length).padStart(8)}`
      )
    }
    console.log('  (drafts/conflicts never appear in merged history — T0 tiers only fire live)')
  }

  if (exportPath) {
    // Why export rather than re-parse: the review-residual analysis must join against exactly
    // the records scored here, or the two halves of the study drift apart.
    const rows = prs.map((p) => ({
      n: p.n,
      date: p.date,
      t: p.t,
      author: p.author,
      authorType: p.authorType,
      subject: p.subject,
      scope: p.scope,
      area: p.area,
      tier: tierRules.length ? tierOf(p) : null,
      files: p.input.files,
      additions: p.input.additions,
      deletions: p.input.deletions,
      testFiles: p.testFiles,
      breadth: p.breadth,
      reverted: p.reverted,
      metrics: Object.fromEntries([horizonDays, horizon2Days].map((h) => [h, metricsBy[h].get(p)]))
    }))
    writeFileSync(
      exportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          windowSize,
          horizons: [horizonDays, horizon2Days],
          halfLifeHours,
          stackWindowHours,
          baseline,
          spanDays,
          prs: rows
        },
        null,
        1
      )
    )
    console.log(`\nexported ${rows.length} PR records to ${exportPath}`)
  }
}

// Why: the metric helpers live in pr-rework-metrics.mjs, so importing this file must not
// shell out to git.
if (import.meta.main) {
  await main()
}
