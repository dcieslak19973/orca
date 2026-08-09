// Replays a PR watch-rules / review-queue config over local git history so a rule
// can be judged before it is trusted. Offline: git log is the only data source.
// Usage: node config/scripts/pr-watch-backtest.mjs [--rules <file.yaml>] [--window <commits>]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'

const repoRoot = join(import.meta.dirname, '..', '..')
// Node >=23 strips erasable types, letting the backtest share the real evaluator.
// pathToFileURL: Windows absolute paths are not valid ESM specifiers.
const { evaluateWatchRules, classifyReviewQueueTier, validateWatchRules, validateTierRules } =
  await import(pathToFileURL(join(repoRoot, 'src', 'shared', 'pr-watch-rules.ts')).href)

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : fallback
}
const rulesPath = argOf('--rules', join(repoRoot, 'config', 'pr-watch-rules.example.yaml'))
const windowSize = Number(argOf('--window', '8000'))

const config = parseYaml(readFileSync(rulesPath, 'utf8'))
const chipRules = config?.pr_watch ? validateWatchRules(config.pr_watch) : []
const tierRules = config?.review_queue?.tiers ? validateTierRules(config.review_queue.tiers) : []
if (chipRules.length === 0 && tierRules.length === 0) {
  console.error(`${rulesPath}: no pr_watch rules or review_queue.tiers found`)
  process.exit(1)
}

// --- history: one merged-PR record per squash-merge commit, plus revert labels ---
const log = execFileSync(
  'git',
  ['-C', repoRoot, 'log', `-${windowSize}`, '--numstat', '--date=short', '--format=@@@%an|%ad|%s'],
  { encoding: 'utf8', maxBuffer: 1 << 28 }
)

const commits = []
let cur = null
for (const line of log.split('\n')) {
  if (line.startsWith('@@@')) {
    if (cur) {
      commits.push(cur)
    }
    const [author, date, ...rest] = line.slice(3).split('|')
    cur = { author, date, subject: rest.join('|'), paths: [], churn: 0 }
    continue
  }
  const m = cur && /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
  if (!m) {
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

const trailingPR = (s) => Number(/\(#(\d+)\)\s*$/.exec(s)?.[1] ?? Number.NaN)
const norm = (s) =>
  s
    .replace(/\s*\(#\d+\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// Revert-target extraction: quoted-number, unquoted-number, and quoted-title forms.
const byTitle = new Map()
for (const c of commits) {
  const n = trailingPR(c.subject)
  if (!Number.isNaN(n) && !/^revert\b/i.test(c.subject)) {
    byTitle.set(norm(c.subject), n)
  }
}
const revertTargets = new Set()
for (const c of commits) {
  if (!/^revert\b/i.test(c.subject)) {
    continue
  }
  const quoted = /"([^"]+)"/.exec(c.subject)?.[1]
  const inQuote = quoted ? [...quoted.matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : []
  if (inQuote.length) {
    inQuote.forEach((t) => revertTargets.add(t))
    continue
  }
  const own = trailingPR(c.subject)
  const rest = [...c.subject.matchAll(/#(\d+)/g)].map((m) => Number(m[1])).filter((x) => x !== own)
  if (rest.length) {
    rest.forEach((t) => revertTargets.add(t))
  } else if (quoted && byTitle.has(norm(quoted))) {
    revertTargets.add(byTitle.get(norm(quoted)))
  }
}

const authorMerged = new Map()
const prs = []
for (const c of commits.toReversed()) {
  const n = trailingPR(c.subject)
  if (Number.isNaN(n) || /^revert\b/i.test(c.subject)) {
    continue
  }
  const prior = authorMerged.get(c.author) ?? 0
  authorMerged.set(c.author, prior + 1)
  prs.push({
    n,
    date: c.date,
    subject: c.subject,
    reverted: revertTargets.has(n),
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
console.log(
  `history: ${prs.length} merged PRs over ${months} months (window ${windowSize} commits)`
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
