// Report formatting for the rework/lift metric. Pure: every function returns lines so the
// tables are unit-testable and every effect is printed next to its shuffle control.

import { groupShuffleNull, mean, meanWithError } from './pr-rework-metrics.mjs'

export const pct = (x, n) => (n === 0 ? '—' : `${((x / n) * 100).toFixed(2)}%`)
export const pp = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`

export const percentileOf = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]

export const dist = (values) => {
  const s = [...values].sort((a, b) => a - b)
  return {
    p50: percentileOf(s, 0.5),
    p75: percentileOf(s, 0.75),
    p90: percentileOf(s, 0.9),
    p95: percentileOf(s, 0.95)
  }
}

const groupBy = (rows) => {
  const byGroup = new Map()
  for (const r of rows) {
    let bucket = byGroup.get(r.group)
    if (!bucket) {
      bucket = []
      byGroup.set(r.group, bucket)
    }
    bucket.push(r.value)
  }
  return byGroup
}

/**
 * One effect table plus the shuffle control that decides whether to believe it.
 *
 * The shuffle permutes group labels within file-heat strata, so a surviving spread cannot be
 * explained by "these groups touch hotter files". Groups below minPRs are listed but excluded
 * from the spread — the same min-n discipline the revert column uses.
 */
export function groupEffectLines(
  title,
  rows,
  { rounds = 200, minPRs = 20, strata = 4, limit = 12 } = {}
) {
  const lines = [`\n=== ${title} ===`]
  const byGroup = groupBy(rows)
  const ordered = [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)
  lines.push(`  ${'group'.padEnd(26)}${'n'.padStart(7)}${'mean'.padStart(10)}${'±se'.padStart(9)}`)
  for (const [group, values] of ordered.slice(0, limit)) {
    const s = meanWithError(values)
    const flag = s.n < minPRs ? '  (n<min, excluded from spread)' : ''
    lines.push(
      `  ${String(group).slice(0, 25).padEnd(26)}${String(s.n).padStart(7)}${pp(s.mean).padStart(10)}${pp(s.se).padStart(9)}${flag}`
    )
  }
  if (ordered.length > limit) {
    const rest = ordered.slice(limit)
    const restRows = rest.reduce((a, [, v]) => a + v.length, 0)
    lines.push(`  … ${rest.length} smaller groups (${restRows} PRs) not shown`)
  }
  const kept = ordered.filter(([, v]) => v.length >= minPRs)
  if (kept.length === 2) {
    const [a, b] = kept
    const sa = meanWithError(a[1])
    const sb = meanWithError(b[1])
    const diff = sa.mean - sb.mean
    const se = Math.sqrt(sa.se ** 2 + sb.se ** 2)
    lines.push(
      `  difference ${a[0]} − ${b[0]}: ${pp(diff)} ± ${pp(se)} (95% CI ${pp(diff - 1.96 * se)} … ${pp(diff + 1.96 * se)})`
    )
  }
  const nul = groupShuffleNull(rows, { rounds, minPRs, strata })
  if (nul.groups < 2) {
    lines.push(`  UNEVALUABLE: fewer than 2 groups with >=${minPRs} scored PRs`)
    return lines
  }
  lines.push(
    `  between-group spread: observed ${pp(nul.spread)} · shuffle null mean ${pp(nul.nullMean)} · null p95 ${pp(nul.nullP95)} · p=${nul.pValue.toFixed(3)} (${nul.rounds} rounds)`
  )
  lines.push(
    nul.pValue <= 0.05
      ? '  SURVIVES the within-stratum shuffle: the grouping still separates with file heat held fixed'
      : '  NULL NOT REJECTED: the shuffle reproduces this spread — it is file heat and feature area, not the grouping'
  )
  return lines
}

/**
 * Quintile table of `value` against a continuous predictor, with the shuffle control.
 *
 * Cut points come from the predictor's own distribution, fixed before any value is read.
 */
export function quintileLines(title, rows, { rounds = 200, strata = 4, minPRs = 20 } = {}) {
  const sorted = [...rows].sort((a, b) => a.predictor - b.predictor)
  const lines = [`\n=== ${title} ===`]
  if (sorted.length < 5) {
    lines.push('  UNEVALUABLE: fewer than 5 rows')
    return lines
  }
  const cuts = [0.2, 0.4, 0.6, 0.8].map((p) =>
    percentileOf(
      sorted.map((r) => r.predictor),
      p
    )
  )
  const quintileOf = (x) => {
    let q = 0
    while (q < 4 && x > cuts[q]) {
      q += 1
    }
    return q + 1
  }
  const labelled = sorted.map((r) => ({ ...r, group: `Q${quintileOf(r.predictor)}` }))
  lines.push(`  cut points (predictor): ${cuts.map((c) => c.toFixed(3)).join(' | ')}`)
  lines.push(
    `  ${'quintile'.padEnd(10)}${'n'.padStart(7)}${'predictor'.padStart(12)}${'mean'.padStart(10)}${'±se'.padStart(9)}`
  )
  for (let q = 1; q <= 5; q += 1) {
    const bucket = labelled.filter((r) => r.group === `Q${q}`)
    const s = meanWithError(bucket.map((r) => r.value))
    const p = mean(bucket.map((r) => r.predictor))
    lines.push(
      `  ${`Q${q}`.padEnd(10)}${String(s.n).padStart(7)}${p.toFixed(3).padStart(12)}${pp(s.mean).padStart(10)}${pp(s.se).padStart(9)}`
    )
  }
  const q1 = meanWithError(labelled.filter((r) => r.group === 'Q1').map((r) => r.value))
  const q5 = meanWithError(labelled.filter((r) => r.group === 'Q5').map((r) => r.value))
  const diff = q5.mean - q1.mean
  const se = Math.sqrt(q1.se ** 2 + q5.se ** 2)
  lines.push(
    `  Q5 − Q1: ${pp(diff)} ± ${pp(se)} (95% CI ${pp(diff - 1.96 * se)} … ${pp(diff + 1.96 * se)})`
  )
  const nul = groupShuffleNull(labelled, { rounds, minPRs, strata })
  lines.push(
    `  between-quintile spread: observed ${pp(nul.spread)} · shuffle null mean ${pp(nul.nullMean)} · null p95 ${pp(nul.nullP95)} · p=${nul.pValue.toFixed(3)} (${nul.rounds} rounds)`
  )
  lines.push(
    nul.pValue <= 0.05
      ? '  SURVIVES the within-stratum shuffle'
      : '  NULL NOT REJECTED: the quintile ordering carries no information the shuffle cannot reproduce'
  )
  return lines
}
