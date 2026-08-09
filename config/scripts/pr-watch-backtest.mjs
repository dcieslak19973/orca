// Replays a PR watch-rules / review-queue config over local git history so a rule
// can be judged before it is trusted. Offline: git log is the only data source.
// Usage: node config/scripts/pr-watch-backtest.mjs [--rules <file.yaml>] [--window <commits>] [--repo <path>]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

const repoRoot = join(import.meta.dirname, '..', '..')
// Node >=23 strips erasable types, letting the backtest share the real evaluator.
// pathToFileURL: Windows absolute paths are not valid ESM specifiers.
const sharedUrl = (name) => pathToFileURL(join(repoRoot, 'src', 'shared', name)).href
const { evaluateWatchRules, classifyReviewQueueTier, validateWatchRules, validateTierRules } =
  await import(sharedUrl('pr-watch-rules.ts'))
const { identifyMergedPR, extractRevertTargets } = await import(sharedUrl('forge-merge-subject.ts'))

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}
const rulesPath = argOf('--rules', join(repoRoot, 'config', 'pr-watch-rules.example.yaml'))
const windowSize = Number(argOf('--window', '8000'))
const historyRepo = argOf('--repo', repoRoot)

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
    '--date=short',
    // %b on its own lines: the record parser folds any non-numstat line into the
    // body, which is where GitLab's "See merge request !N" trailer lives.
    '--format=@@@%an|%ad|%s%n%b'
  ],
  { encoding: 'utf8', maxBuffer: 1 << 28 }
)

const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/
const commits = []
let cur = null
for (const line of log.split('\n')) {
  if (line.startsWith('@@@')) {
    const [author, date, ...rest] = line.slice(3).split('|')
    const subject = rest.join('|')
    // Old git can emit one header per merge parent under -m; keep the
    // first-parent record and fold duplicates.
    if (cur && cur.author === author && cur.date === date && cur.subject === subject) {
      continue
    }
    if (cur) {
      commits.push(cur)
    }
    cur = { author, date, subject, body: [], paths: [], churn: 0 }
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
  cur.paths.push(m[3])
  if (m[1] !== '-') {
    cur.churn += Number(m[1])
  }
  if (m[2] !== '-') {
    cur.churn += Number(m[2])
  }
}
if (cur) {
  commits.push(cur)
}

const norm = (s) =>
  s
    .replace(/\s*\([#!]\d+\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

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
    subject: c.subject,
    reverted: revertTargets.has(c.pr.number),
    input: {
      title: c.subject,
      author: c.author,
      paths: c.paths,
      files: c.paths.length,
      churn: c.churn,
      draft: false, // merged history: never draft, never conflicting
      mergeable: 'mergeable',
      authorMergedPRs: prior
    }
  })
}

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
const percentiles = {
  files: dist(prs.map((p) => p.input.files)),
  churn: dist(prs.map((p) => p.input.churn))
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
  `calibration: files p50=${percentiles.files.p50} p90=${percentiles.files.p90} · churn p50=${percentiles.churn.p50} p90=${percentiles.churn.p90}`
)
const showReverts = totalReverts >= 20
console.log(
  showReverts
    ? `revert labels: ${totalReverts}`
    : `revert labels: ${totalReverts} — below min-n 20, correlation column suppressed`
)

if (chipRules.length) {
  console.log(`\n=== pr_watch rules ===`)
  const header = `${'rule'.padEnd(24)}${'fires'.padStart(7)}   % of PRs${showReverts ? '   reverts caught' : ''}`
  console.log(`${header}\n${'-'.repeat(header.length + 4)}`)
  for (const rule of chipRules) {
    const hits = prs.filter((p) =>
      evaluateWatchRules([rule], p.input, { percentiles }).some((m) => !m.pending)
    )
    const caught = hits.filter((p) => p.reverted).length
    let line = `${rule.name.slice(0, 23).padEnd(24)}${String(hits.length).padStart(7)}${pct(hits.length, prs.length).padStart(11)}`
    if (showReverts) {
      line += `   ${caught} / ${totalReverts}`
    }
    console.log(line)
    if (hits.length === 0) {
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
    console.log(`  ${name.padEnd(26)} ${String(n).padStart(6)}  ${pct(n, prs.length).padStart(8)}`)
  }
  console.log('  (drafts/conflicts never appear in merged history — T0 tiers only fire live)')
}
