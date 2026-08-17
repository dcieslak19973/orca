// Replays a PR watch-rules / review-queue config over local git history so a rule
// can be judged before it is trusted. Offline: git log is the only data source.
// Usage: node config/scripts/pr-watch-backtest.mjs [--rules <file.yaml>] [--window <commits>] [--repo <path>]
//        [--horizon <days>] [--horizon2 <days>] [--half-life <hours>] [--null-rounds <n>]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

const repoRoot = join(import.meta.dirname, '..', '..')
// Node >=23 strips erasable types, letting the backtest share the real evaluator.
// pathToFileURL: Windows absolute paths are not valid ESM specifiers.
const sharedUrl = (name) => pathToFileURL(join(repoRoot, 'src', 'shared', name)).href

export const DAY_MS = 86_400_000

const pct = (x, n) => `${((x / n) * 100).toFixed(2)}%`
const percentileOf = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
const dist = (values) => {
  const s = [...values].sort((a, b) => a - b)
  return {
    p50: percentileOf(s, 0.5),
    p75: percentileOf(s, 0.75),
    p90: percentileOf(s, 0.9),
    p95: percentileOf(s, 0.95)
  }
}
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const pp = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`

export const norm = (s) =>
  s
    .replace(/\s*\([#!]\d+\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// Why: -M/-C rewrite renames as "a/{b => c}/d.ts" or "a => b"; both name one file, and
// leaving them raw splits a renamed file's history into two never-rejoined buckets.
export function normalizeNumstatPath(raw) {
  const brace = /^(.*)\{(.*?)\s*=>\s*(.*?)\}(.*)$/.exec(raw)
  if (brace) {
    return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, '/').replace(/^\//, '')
  }
  const arrow = /^(.+?)\s+=>\s+(.+)$/.exec(raw)
  return (arrow ? arrow[2] : raw).trim()
}

// Why: a same-file edit six hours later is overwhelmingly a repair; at ninety days it is
// ordinary evolution. Halving weight per half-life is the label-free stand-in for "was it a fix".
export function timeDecayWeight(deltaMs, halfLifeMs) {
  if (deltaMs <= 0) {
    return 1
  }
  return 2 ** (-deltaMs / halfLifeMs)
}

// Why: stacked PRs legitimately revisit their own lines, so same-author and same-ticket
// follow-ups are continuation, not rework, and must not count against the first PR.
export function isRework(pr, later) {
  if (later.author === pr.author) {
    return false
  }
  return !(pr.ticket && later.ticket && pr.ticket === later.ticket)
}

export const ticketOf = (subject) => /\b(STA-\d+)\b/i.exec(subject)?.[1]?.toUpperCase() ?? null

export const hasConventionalPrefix = (subject) =>
  /^\s*(feat|fix|perf|refactor|chore|docs|test|style|build|ci|revert)\s*(\([^)]*\))?\s*!?:/i.test(
    subject
  )

export const isFixSubject = (subject) => /^\s*fix\s*(\([^)]*\))?\s*!?:/i.test(subject)

// Why: one pass over the PRs keyed by file, so every horizon is a lookup rather than a rescan.
export function buildFileTimeline(prs) {
  const timeline = new Map()
  for (const pr of prs) {
    for (const path of new Set(pr.paths)) {
      let entries = timeline.get(path)
      if (!entries) {
        entries = []
        timeline.set(path, entries)
      }
      entries.push(pr)
    }
  }
  for (const entries of timeline.values()) {
    entries.sort((a, b) => a.t - b.t)
  }
  return timeline
}

/**
 * Per-PR rework over a horizon, with a per-file baseline subtracted.
 *
 * Why lift, not the raw rate: hot files churn regardless of authorship, so an unnormalized
 * rate just rediscovers which files are hot (#13066's own warning about thin signal).
 */
export function computeReworkMetrics(prs, { horizonDays, halfLifeHours, spanDays, latestT }) {
  const horizonMs = horizonDays * DAY_MS
  const halfLifeMs = halfLifeHours * 3600_000
  const timeline = buildFileTimeline(prs)
  // Why: PRs merged inside the trailing horizon have not had time to be reworked; scoring
  // them as clean would bias every rate downward exactly where the data is freshest.
  const censorBefore = latestT - horizonMs
  const out = new Map()
  for (const pr of prs) {
    if (pr.t > censorBefore) {
      out.set(pr, { censored: true, reworkRate: 0, expected: 0, lift: 0, decay: 0, fixShare: 0 })
      continue
    }
    const paths = [...new Set(pr.paths)]
    if (paths.length === 0) {
      out.set(pr, { censored: false, reworkRate: 0, expected: 0, lift: 0, decay: 0, fixShare: 0 })
      continue
    }
    let touched = 0
    let expectedSum = 0
    let decaySum = 0
    let fixTouched = 0
    for (const path of paths) {
      const entries = timeline.get(path) ?? []
      let first = null
      let othersEver = 0
      for (const other of entries) {
        if (other === pr || !isRework(pr, other)) {
          continue
        }
        othersEver += 1
        if (other.t > pr.t && other.t - pr.t <= horizonMs && first === null) {
          first = other
        }
      }
      // Why: baseline is P(this file is touched at least once by another author in a window
      // of the horizon), Poisson from the file's own rate. A linear rate*horizon pegs at 1.0
      // for any file touched >4x in the span, which flattens lift to noise on a busy repo.
      const lambdaPerDay = spanDays > 0 ? othersEver / spanDays : 0
      expectedSum += 1 - Math.exp(-lambdaPerDay * horizonDays)
      if (first) {
        touched += 1
        decaySum += timeDecayWeight(first.t - pr.t, halfLifeMs)
        if (isFixSubject(first.subject)) {
          fixTouched += 1
        }
      }
    }
    const reworkRate = touched / paths.length
    const expected = expectedSum / paths.length
    out.set(pr, {
      censored: false,
      reworkRate,
      expected,
      lift: reworkRate - expected,
      decay: decaySum / paths.length,
      fixShare: touched === 0 ? 0 : fixTouched / touched
    })
  }
  return out
}

// Why: deterministic shuffles keep the null test reproducible across runs and machines.
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shuffleInPlace = (xs, rand) => {
  for (let i = xs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[xs[i], xs[j]] = [xs[j], xs[i]]
  }
  return xs
}

// Why: weighted between-author spread of lift is the thing a "some authors ship reworkable
// code" claim rests on; if a label shuffle reproduces it, the metric is reading file heat.
export function betweenAuthorSpread(rows, minPRs) {
  const byAuthor = new Map()
  for (const r of rows) {
    let bucket = byAuthor.get(r.author)
    if (!bucket) {
      bucket = []
      byAuthor.set(r.author, bucket)
    }
    bucket.push(r.lift)
  }
  const kept = [...byAuthor.values()].filter((v) => v.length >= minPRs)
  if (kept.length < 2) {
    return { spread: 0, authors: kept.length }
  }
  const means = kept.map((v) => mean(v))
  const grand = mean(means)
  const spread = Math.sqrt(mean(means.map((m) => (m - grand) ** 2)))
  return { spread, authors: kept.length }
}

/**
 * Author-shuffle null test.
 *
 * Why: the live null hypothesis is "rework reflects file heat and feature area, not
 * authorship". Shuffling authors *within* file-heat strata holds heat fixed, so anything
 * left is authorship. Labels are permuted over fixed lift values — the standard permutation
 * test; it does not re-derive the same-author exclusion, which is stated in the report.
 */
export function authorShuffleNull(
  rows,
  { rounds = 200, strata = 4, minPRs = 20, seed = 20260816 }
) {
  const observed = betweenAuthorSpread(rows, minPRs)
  if (observed.authors < 2 || rows.length === 0) {
    return { ...observed, nullMean: 0, nullP95: 0, pValue: 1, rounds: 0 }
  }
  const sorted = [...rows].sort((a, b) => a.expected - b.expected)
  const perStratum = Math.max(1, Math.ceil(sorted.length / strata))
  const buckets = []
  for (let i = 0; i < sorted.length; i += perStratum) {
    buckets.push(sorted.slice(i, i + perStratum))
  }
  const rand = mulberry32(seed)
  const nulls = []
  for (let r = 0; r < rounds; r += 1) {
    const shuffled = []
    for (const bucket of buckets) {
      const authors = shuffleInPlace(
        bucket.map((x) => x.author),
        rand
      )
      bucket.forEach((row, i) => shuffled.push({ author: authors[i], lift: row.lift }))
    }
    nulls.push(betweenAuthorSpread(shuffled, minPRs).spread)
  }
  nulls.sort((a, b) => a - b)
  const atOrAbove = nulls.filter((v) => v >= observed.spread).length
  return {
    ...observed,
    nullMean: mean(nulls),
    nullP95: percentileOf(nulls, 0.95),
    pValue: (atOrAbove + 1) / (rounds + 1),
    rounds
  }
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
  const positiveNumber = (flag, fallback) => {
    const value = Number(argOf(flag, fallback))
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`${flag} must be a positive number`)
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
  const horizonDays = positiveNumber('--horizon', '30')
  const horizon2Days = positiveNumber('--horizon2', '90')
  const halfLifeHours = positiveNumber('--half-life', '48')
  const nullRounds = positiveNumber('--null-rounds', '200')

  const config = parseYaml(readFileSync(rulesPath, 'utf8'))
  const chipRules = config?.pr_watch ? validateWatchRules(config.pr_watch) : []
  const tierRules = config?.review_queue?.tiers ? validateTierRules(config.review_queue.tiers) : []
  if (chipRules.length === 0 && tierRules.length === 0) {
    console.error(`${rulesPath}: no pr_watch rules or review_queue.tiers found`)
    process.exit(1)
  }

  // --- history: one record per first-parent commit, sized against first parent so
  // merge-commit forges (Bitbucket, GitLab merge style) aggregate a whole PR. `-m`
  // keeps numstat on merges; squash repos are unaffected. Bodies are captured for
  // GitLab's "See merge request !N" trailers.
  // Why -w -M -C: whitespace-only churn and renames are not rework, and counting them
  // as such is the noisiest way to inflate the metric.
  const log = execFileSync(
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

  const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/
  const commits = []
  let cur = null
  for (const line of log.split('\n')) {
    if (line.startsWith('@@@')) {
      const [hash, author, date, iso, ...rest] = line.slice(3).split('|')
      const subject = rest.join('|')
      // Under -m git emits one diff section per merge parent (repeating the header);
      // --first-parent limits the walk, and the mainline diff is always first. Fold
      // repeat headers by commit hash, keeping that first (first-parent) section.
      if (cur && cur.hash === hash) {
        continue
      }
      if (cur) {
        commits.push(cur)
      }
      cur = { hash, author, date, iso, subject, body: [], paths: [], additions: 0, deletions: 0 }
      continue
    }
    if (!cur) {
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
      subject: c.subject,
      ticket: ticketOf(c.subject),
      paths: c.paths,
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
    `history: ${prs.length} merged PRs over ${months} months (window ${windowSize} commits)`
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
  const metricsBy = {
    [horizonDays]: computeReworkMetrics(prs, { horizonDays, halfLifeHours, spanDays, latestT }),
    [horizon2Days]: computeReworkMetrics(prs, {
      horizonDays: horizon2Days,
      halfLifeHours,
      spanDays,
      latestT
    })
  }
  const primary = metricsBy[horizonDays]
  const scored = prs.filter((p) => !primary.get(p).censored)
  const censored = prs.length - scored.length
  const overall = (metrics, subset) => ({
    rework: mean(subset.map((p) => metrics.get(p).reworkRate)),
    expected: mean(subset.map((p) => metrics.get(p).expected)),
    lift: mean(subset.map((p) => metrics.get(p).lift)),
    decay: mean(subset.map((p) => metrics.get(p).decay))
  })
  console.log(`\n=== rework / lift (label-free) ===`)
  console.log(
    `scored ${scored.length} PRs · right-censored ${censored} merged inside the trailing ${horizonDays}d · baseline span ${spanDays.toFixed(0)}d`
  )
  for (const h of [horizonDays, horizon2Days]) {
    const sub = prs.filter((p) => !metricsBy[h].get(p).censored)
    const o = overall(metricsBy[h], sub)
    console.log(
      `  @${String(h).padStart(3)}d  n=${String(sub.length).padStart(5)}  rework ${(o.rework * 100).toFixed(1)}%  expected ${(o.expected * 100).toFixed(1)}%  lift ${pp(o.lift)}  decay ${o.decay.toFixed(3)}`
    )
  }

  // Why: a fix:-weighted view is only meaningful next to how often the label exists at all,
  // and coverage that varies by author is differential error aligned with the comparison.
  const covered = prs.filter((p) => hasConventionalPrefix(p.subject)).length
  const coverage = covered / prs.length
  console.log(
    `label coverage: ${covered}/${prs.length} conventional-commit subjects (${pct(covered, prs.length)})`
  )
  const byAuthorCoverage = new Map()
  for (const p of prs) {
    const row = byAuthorCoverage.get(p.author) ?? { n: 0, ok: 0 }
    row.n += 1
    row.ok += hasConventionalPrefix(p.subject) ? 1 : 0
    byAuthorCoverage.set(p.author, row)
  }
  const topAuthors = [...byAuthorCoverage.entries()]
    .filter(([, r]) => r.n >= 20)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 8)
  if (topAuthors.length) {
    console.log('  coverage by author (n>=20; spread here means the fix: column is biased):')
    for (const [author, r] of topAuthors) {
      console.log(
        `    ${author.slice(0, 22).padEnd(24)} ${String(r.n).padStart(5)} PRs   ${pct(r.ok, r.n).padStart(8)}`
      )
    }
  }
  const showFixWeighted = coverage >= 0.6 && scored.length >= 20
  if (showFixWeighted) {
    const fixShare = mean(scored.map((p) => primary.get(p).fixShare))
    console.log(
      `  secondary (label-dependent): ${(fixShare * 100).toFixed(1)}% of rework events are fix: subjects — coverage ${pct(covered, prs.length)}`
    )
  } else {
    console.log(
      `  secondary (label-dependent): suppressed — coverage ${pct(covered, prs.length)} below min 60% or n<20`
    )
  }

  // --- required null test
  const rows = scored.map((p) => ({
    author: p.author,
    lift: primary.get(p).lift,
    expected: primary.get(p).expected
  }))
  const nul = authorShuffleNull(rows, { rounds: nullRounds })
  console.log(`\n=== author-shuffle null test (${nul.rounds} rounds, within file-heat strata) ===`)
  if (nul.authors < 2) {
    console.log('  UNEVALUABLE: fewer than 2 authors with >=20 scored PRs')
  } else {
    console.log(
      `  between-author lift spread: observed ${pp(nul.spread)} · null mean ${pp(nul.nullMean)} · null p95 ${pp(nul.nullP95)} · p=${nul.pValue.toFixed(3)}`
    )
    console.log(
      nul.pValue <= 0.05
        ? '  SURVIVES: authorship still separates after holding file heat fixed'
        : '  NULL NOT REJECTED: this is measuring hot files and feature area, not authorship — report it as such'
    )
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

  if (tierRules.length) {
    console.log(`\n=== review_queue tiers (first-match) ===`)
    const counts = new Map()
    for (const p of prs) {
      const { tier, pending } = classifyReviewQueueTier(tierRules, p.input, { percentiles })
      const key = (tier ?? '(catch-all)') + (pending ? ' [pending]' : '')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(
        `  ${name.padEnd(26)} ${String(n).padStart(6)}  ${pct(n, prs.length).padStart(8)}`
      )
    }
    console.log('  (drafts/conflicts never appear in merged history — T0 tiers only fire live)')
  }
}

// Why: the metric helpers above are unit-tested, so importing this file must not shell out to git.
if (import.meta.main) {
  await main()
}
