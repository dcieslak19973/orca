// Review-time residual conditional on PR size: fit review effort from structural size only,
// then ask whether the *excess* predicts downstream rework. Offline — reads the backtest
// export and the cached review timeline, never the network.
// Usage: node config/scripts/pr-review-residual.mjs --prs <export.json> --reviews <cache.jsonl>
//        [--effort rounds|reviewers|threads] [--null-rounds 200]
import { readFileSync } from 'node:fs'
import { mean, meanWithError } from './pr-rework-metrics.mjs'
import { groupEffectLines, pct, pp, quintileLines } from './pr-rework-report.mjs'

const log1p = (x) => Math.log(1 + Math.max(0, x))

/** Solve (X'X)b = X'y by Gaussian elimination with partial pivoting. */
export function olsFit(rows, y) {
  const k = rows[0].length
  const xtx = Array.from({ length: k }, () => new Float64Array(k + 1))
  for (let i = 0; i < rows.length; i += 1) {
    const xi = rows[i]
    for (let a = 0; a < k; a += 1) {
      for (let b = 0; b < k; b += 1) {
        xtx[a][b] += xi[a] * xi[b]
      }
      xtx[a][k] += xi[a] * y[i]
    }
  }
  for (let col = 0; col < k; col += 1) {
    let pivot = col
    for (let r = col + 1; r < k; r += 1) {
      if (Math.abs(xtx[r][col]) > Math.abs(xtx[pivot][col])) {
        pivot = r
      }
    }
    ;[xtx[col], xtx[pivot]] = [xtx[pivot], xtx[col]]
    const d = xtx[col][col]
    if (Math.abs(d) < 1e-12) {
      continue
    }
    for (let c = col; c <= k; c += 1) {
      xtx[col][c] /= d
    }
    for (let r = 0; r < k; r += 1) {
      if (r === col) {
        continue
      }
      const f = xtx[r][col]
      for (let c = col; c <= k; c += 1) {
        xtx[r][c] -= f * xtx[col][c]
      }
    }
  }
  return Array.from({ length: k }, (_, i) => xtx[i][k])
}

export const predict = (x, beta) => x.reduce((a, v, i) => a + v * beta[i], 0)

export function rSquared(rows, y, beta) {
  const ybar = mean(y)
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < rows.length; i += 1) {
    ssRes += (y[i] - predict(rows[i], beta)) ** 2
    ssTot += (y[i] - ybar) ** 2
  }
  return ssTot === 0 ? 0 : 1 - ssRes / ssTot
}

const rankOf = (values) => {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
  const ranks = Array.from({ length: values.length })
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) {
      j += 1
    }
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) {
      ranks[idx[k][1]] = r
    }
    i = j + 1
  }
  return ranks
}

export function spearman(xs, ys) {
  const rx = rankOf(xs)
  const ry = rankOf(ys)
  const mx = mean(rx)
  const my = mean(ry)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my)
    dx += (rx[i] - mx) ** 2
    dy += (ry[i] - my) ** 2
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy)
}

const FEATURES = [
  'const',
  'log(1+files)',
  'log(1+additions)',
  'log(1+deletions)',
  'breadth',
  'testRatio'
]

const designRow = (pr) => [
  1,
  log1p(pr.files),
  log1p(pr.additions),
  log1p(pr.deletions),
  pr.breadth,
  pr.files > 0 ? pr.testFiles / pr.files : 0
]

// Why: AI review bots review nearly everything here, and none of them carry a [bot] suffix
// on their login. Treating one as "the reviewer" would define away the human judgement the
// metric claims to instrument.
const BOT_REVIEWER_RE =
  /\[bot\]$|^(coderabbitai|greptile|pullfrog|github-actions|dependabot|copilot)/i

export const humanReviewersOf = (review) =>
  (review.reviewers ?? []).filter((login) => !BOT_REVIEWER_RE.test(login))

export function effortValue(review, key) {
  if (key === 'reviewers') {
    return humanReviewersOf(review).length
  }
  if (key === 'threads') {
    return review.threads
  }
  if (key === 'reviews') {
    return review.reviews
  }
  return review.rounds
}

/**
 * Subtract each primary reviewer's mean residual — a reviewer fixed effect.
 *
 * Why: reviewer identity is the largest confound. Without it, "this PR consumed excess
 * review" is partly "this reviewer always asks for changes".
 */
export function reviewerDemean(rows, { minPRs = 10 } = {}) {
  const counts = new Map()
  for (const r of rows) {
    counts.set(r.reviewer, (counts.get(r.reviewer) ?? 0) + 1)
  }
  const cellOf = (r) => (counts.get(r.reviewer) >= minPRs ? r.reviewer : '(other)')
  const sums = new Map()
  for (const r of rows) {
    const key = cellOf(r)
    const acc = sums.get(key) ?? { n: 0, total: 0 }
    acc.n += 1
    acc.total += r.residual
    sums.set(key, acc)
  }
  return rows.map((r) => {
    const acc = sums.get(cellOf(r))
    return { ...r, reviewerCell: cellOf(r), eps: r.residual - acc.total / acc.n }
  })
}

function main() {
  const args = process.argv.slice(2)
  const argOf = (flag, fallback) => {
    const i = args.indexOf(flag)
    return i === -1 ? fallback : args[i + 1]
  }
  const prsPath = argOf('--prs', null)
  const reviewsPath = argOf('--reviews', null)
  if (!prsPath || !reviewsPath) {
    console.error('--prs <export.json> and --reviews <cache.jsonl> are required')
    process.exit(2)
  }
  const effortKey = argOf('--effort', 'rounds')
  const nullRounds = Number(argOf('--null-rounds', '200'))
  // Disclosed post-hoc variant: an LLM bot reviews most PRs here, so the claim "a human
  // slowed down on this diff" can only be tested on the PRs a human actually reviewed.
  const humanOnly = args.includes('--human-only')

  const exported = JSON.parse(readFileSync(prsPath, 'utf8'))
  const reviews = new Map()
  for (const line of readFileSync(reviewsPath, 'utf8').split('\n')) {
    if (line.trim()) {
      const r = JSON.parse(line)
      reviews.set(r.number, r)
    }
  }
  const [h1, h2] = exported.horizons
  console.log(
    `export: ${exported.prs.length} PRs, horizons ${h1}d/${h2}d, baseline ${exported.baseline ?? 'span'} · review cache: ${reviews.size} PRs`
  )

  const joined = exported.prs.filter((p) => reviews.has(p.n))
  console.log(
    `join: ${joined.length}/${exported.prs.length} matched (${pct(joined.length, exported.prs.length)})`
  )
  const byType = new Map()
  for (const p of exported.prs) {
    const acc = byType.get(p.authorType) ?? { n: 0, matched: 0 }
    acc.n += 1
    acc.matched += reviews.has(p.n) ? 1 : 0
    byType.set(p.authorType, acc)
  }
  console.log('  join coverage by author type (differential-coverage check):')
  for (const [type, acc] of byType) {
    console.log(
      `    ${type.padEnd(10)} ${String(acc.n).padStart(5)} PRs   matched ${pct(acc.matched, acc.n)}`
    )
  }

  // Pre-registered exclusions: censored, empty, and never-reviewed PRs.
  const scored = joined.filter((p) => !p.metrics[h1].censored && p.files > 0)
  const reviewed = scored.filter((p) => {
    const r = reviews.get(p.n)
    if (humanOnly) {
      return humanReviewersOf(r).length > 0
    }
    return r.reviews > 0 || r.threads > 0
  })
  const unreviewed = scored.length - reviewed.length
  console.log(
    `analysed ${reviewed.length} PRs${humanOnly ? ' (human-reviewed only)' : ''} · excluded ${unreviewed} without ${humanOnly ? 'a human review' : 'any review'} (${pct(unreviewed, scored.length)}) as censored · ${joined.length - scored.length} censored/empty`
  )

  // Why: the pre-registered preference order only holds if the chosen measure actually
  // varies. A constant effort measure produces quintiles that are pure sort order.
  console.log('\n=== review effort measures (choose the first with real spread) ===')
  for (const key of ['rounds', 'reviewers', 'threads', 'reviews']) {
    const values = reviewed.map((p) => effortValue(reviews.get(p.n), key))
    const s = meanWithError(values)
    const sd = Math.sqrt(s.se ** 2 * s.n)
    const zero = values.filter((v) => v === 0).length
    console.log(
      `  ${key.padEnd(10)} mean ${s.mean.toFixed(2)}  sd ${sd.toFixed(2)}  zero ${pct(zero, values.length)}  max ${Math.max(...values)}`
    )
  }
  const humanReviewed = reviewed.filter((p) => humanReviewersOf(reviews.get(p.n)).length > 0)
  console.log(
    `  human-reviewed: ${humanReviewed.length}/${reviewed.length} (${pct(humanReviewed.length, reviewed.length)}) — the rest are bot-only reviews`
  )

  const effortOf = (r) => effortValue(r, effortKey)
  const design = reviewed.map(designRow)
  const y = reviewed.map((p) => log1p(effortOf(reviews.get(p.n))))
  const beta = olsFit(design, y)
  console.log(`\n=== null model: log(1+${effortKey}) ~ structural size only ===`)
  FEATURES.forEach((name, i) => console.log(`  ${name.padEnd(20)} ${beta[i].toFixed(4)}`))
  console.log(`  R² = ${rSquared(design, y, beta).toFixed(4)}   n = ${reviewed.length}`)
  console.log(
    `  spearman(files, ${effortKey}) = ${spearman(
      reviewed.map((p) => p.files),
      reviewed.map((p) => effortOf(reviews.get(p.n)))
    ).toFixed(3)} · spearman(additions, ${effortKey}) = ${spearman(
      reviewed.map((p) => p.additions),
      reviewed.map((p) => effortOf(reviews.get(p.n)))
    ).toFixed(3)}`
  )

  const withResidual = reviewed.map((p, i) => {
    const r = reviews.get(p.n)
    return {
      pr: p,
      reviewer: humanReviewersOf(r)[0] ?? r.reviewers[0] ?? '(none)',
      residual: y[i] - predict(design[i], beta)
    }
  })
  const rows = reviewerDemean(withResidual)

  // Reviewer-assignment independence: if agent PRs route to different reviewers, the
  // residual carries the treatment and the metric manufactures an effect.
  for (const line of groupEffectLines(
    'agent share by primary reviewer (assignment independence)',
    rows
      .filter((r) => r.reviewerCell !== '(other)')
      .map((r) => ({
        group: r.reviewerCell,
        value: r.pr.authorType === 'agent' ? 1 : 0,
        stratum: r.pr.metrics[h1].expected,
        cell: r.pr.date.slice(0, 7)
      })),
    { rounds: nullRounds, minPRs: 20 }
  )) {
    console.log(line)
  }

  for (const h of [h1, h2]) {
    const usable = rows.filter((r) => !r.pr.metrics[h].censored)
    const table = usable.map((r) => ({
      predictor: r.eps,
      value: r.pr.metrics[h].lift,
      stratum: r.pr.metrics[h].expected,
      cell: r.pr.date.slice(0, 7)
    }))
    for (const line of quintileLines(
      `rework lift@${h}d by excess-review-friction quintile (n=${usable.length}, effort=${effortKey})`,
      table,
      { rounds: nullRounds, minPRs: 20 }
    )) {
      console.log(line)
    }
    // Second shuffle variant from the pre-registration: hold the reviewer fixed too.
    for (const line of quintileLines(
      `  … same, shuffled within (reviewer × file-heat) cells`,
      usable.map((r, i) => ({ ...table[i], cell: r.reviewerCell })),
      { rounds: nullRounds, minPRs: 20 }
    )) {
      console.log(line)
    }
    console.log(
      `  spearman(eps, lift@${h}d) = ${spearman(
        usable.map((r) => r.eps),
        usable.map((r) => r.pr.metrics[h].lift)
      ).toFixed(3)}`
    )
  }

  const epsByType = new Map()
  for (const r of rows) {
    const acc = epsByType.get(r.pr.authorType) ?? []
    acc.push(r.eps)
    epsByType.set(r.pr.authorType, acc)
  }
  console.log('\n=== excess review friction by author type (descriptive, never a predictor) ===')
  for (const [type, values] of epsByType) {
    const s = meanWithError(values)
    console.log(
      `  ${type.padEnd(10)} n=${String(s.n).padStart(5)}  eps ${s.mean.toFixed(4)} ± ${s.se.toFixed(4)}`
    )
  }
  console.log(
    `\nunreviewed (censored, reported separately): ${unreviewed} PRs · mean lift@${h1}d ${pp(
      mean(
        scored
          .filter((p) => {
            const r = reviews.get(p.n)
            return r.reviews === 0 && r.threads === 0
          })
          .map((p) => p.metrics[h1].lift)
      )
    )}`
  )
}

if (import.meta.main) {
  main()
}
