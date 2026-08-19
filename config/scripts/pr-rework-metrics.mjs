// Label-free rework/lift metric: "did a later PR change this PR's code", scored against
// each file's own baseline rate. Pure functions over records the backtest already holds;
// no git pass, no API call. See docs/pr-metric-improvements-brief.md.

export const DAY_MS = 86_400_000
const LN2 = Math.LN2

export const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

/** Standard error of the mean — every reported effect needs its uncertainty next to it. */
export function meanWithError(xs) {
  const n = xs.length
  if (n === 0) {
    return { n: 0, mean: 0, se: 0 }
  }
  const m = mean(xs)
  if (n === 1) {
    return { n, mean: m, se: 0 }
  }
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)
  return { n, mean: m, se: Math.sqrt(variance / n) }
}

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

/**
 * Expected decay weight of the *first* follow-up under a Poisson file rate.
 *
 * Why closed form: the decay-weighted rate needs the same per-file baseline the binary rate
 * gets, or it re-reads file heat. First-event time is Exp(lambda) truncated at the horizon, so
 * E[2^(-t/H)] = lambda/(lambda+k) * (1 - e^-(lambda+k)T) with k = ln2/H. No simulation.
 */
export function expectedDecayWeight(lambdaPerDay, horizonDays, halfLifeDays) {
  if (lambdaPerDay <= 0 || horizonDays <= 0) {
    return 0
  }
  const k = LN2 / halfLifeDays
  const rate = lambdaPerDay + k
  return (lambdaPerDay / rate) * (1 - Math.exp(-rate * horizonDays))
}

export const DEFAULT_STACK_WINDOW_HOURS = 72

/**
 * Is `later` rework of `pr`, or the same work continuing?
 *
 * Why a window and not a blanket same-author exclusion: excluding an author's own follow-ups
 * forever removes a larger share of candidate reworkers for prolific authors than for rare
 * ones — measurement error aligned with the author comparison. Stacked PRs land within days,
 * so a short window covers the continuation case without that bias. Ticket lineage is the
 * branch-lineage proxy available in squash history and is excluded at any distance.
 */
export function isRework(pr, later, stackWindowMs = DEFAULT_STACK_WINDOW_HOURS * 3600_000) {
  if (pr.ticket && later.ticket && pr.ticket === later.ticket) {
    return false
  }
  return !(later.author === pr.author && Math.abs(later.t - pr.t) <= stackWindowMs)
}

export const ticketOf = (subject) => /\b(STA-\d+)\b/i.exec(subject)?.[1]?.toUpperCase() ?? null

export const hasConventionalPrefix = (subject) =>
  /^\s*(feat|fix|perf|refactor|chore|docs|test|style|build|ci|revert)\s*(\([^)]*\))?\s*!?:/i.test(
    subject
  )

export const isFixSubject = (subject) => /^\s*fix\s*(\([^)]*\))?\s*!?:/i.test(subject)

export const scopeOf = (subject) =>
  /^\s*[a-z]+\(([a-z0-9/._-]+)\)!?\s*:/i.exec(subject)?.[1]?.toLowerCase() ?? null

const AREA_PREFIXES = ['src/renderer/src/', 'src/', 'config/', '.github/']

/** Label-free counterpart to the title scope: the two directory levels that carry meaning. */
export function areaOfPath(path) {
  const prefix = AREA_PREFIXES.find((p) => path.startsWith(p))
  const rest = prefix ? path.slice(prefix.length) : path
  const parts = rest.split('/')
  if (parts.length <= 1) {
    return prefix ? prefix.replace(/\/$/, '') : '(root)'
  }
  return parts.slice(0, 2).join('/')
}

/** Modal area over a PR's files: where the change actually lives, no title needed. */
export function dominantArea(paths) {
  const counts = new Map()
  for (const path of paths) {
    const area = areaOfPath(path)
    counts.set(area, (counts.get(area) ?? 0) + 1)
  }
  let best = null
  let bestN = 0
  for (const [area, n] of counts) {
    if (n > bestN) {
      best = area
      bestN = n
    }
  }
  return best ?? '(none)'
}

// Why: agents are declared by a co-author trailer, not by the git author, so the treatment
// variable is trailer-present vs absent. Absence is not proof of a human — that asymmetry is
// exactly why coverage is reported next to every author-type split.
const AGENT_TRAILER_RE =
  /co-authored-by:\s*(orca|claude|codex|cursor|devin|copilot|gemini|openai|chatgpt)/i

export const authorTypeOf = (body) => (AGENT_TRAILER_RE.test(body ?? '') ? 'agent' : 'untagged')

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

const churnOf = (pr) => (Number.isFinite(pr.churn) ? pr.churn : 0)

/**
 * Repair signature of one follow-up, label-free.
 *
 * containment: share of the follow-up's files that this PR had touched. 1.0 = surgical return
 * to exactly this code; low = a sweep that happened to include it.
 * asymmetry: this PR's size as a share of the pair. High = a small follow-up to a big change,
 * which is what a repair looks like; ~0.5 = two comparable changes, i.e. evolution.
 */
export function repairSignature(pr, later) {
  const laterPaths = new Set(later.paths)
  let shared = 0
  for (const path of laterPaths) {
    if (pr.pathSet.has(path)) {
      shared += 1
    }
  }
  const total = churnOf(pr) + churnOf(later)
  return {
    containment: laterPaths.size === 0 ? 0 : shared / laterPaths.size,
    asymmetry: total === 0 ? 0.5 : churnOf(pr) / total
  }
}

const emptyMetrics = (censored) => ({
  censored,
  reworkRate: 0,
  expected: 0,
  lift: 0,
  decay: 0,
  decayExpected: 0,
  decayLift: 0,
  containment: 0,
  asymmetry: 0,
  events: 0,
  fixShare: 0
})

/**
 * Per-PR rework over a horizon, with a per-file baseline subtracted.
 *
 * Why lift, not the raw rate: hot files churn regardless of authorship, so an unnormalized
 * rate just rediscovers which files are hot (#13066's own warning about thin signal). Both the
 * binary rate and the decay-weighted rate get their own closed-form baseline.
 *
 * baseline: 'span' divides each file's touch count by the whole window, which understates the
 * rate of files that only appear late and so inflates their lift. 'exposure' divides by the
 * days since the file was first seen. 'span' is the default because it is the specification
 * the metric shipped with; 'exposure' is the declared sensitivity check.
 */
export function computeReworkMetrics(
  prs,
  {
    horizonDays,
    halfLifeHours,
    spanDays,
    latestT,
    stackWindowHours = DEFAULT_STACK_WINDOW_HOURS,
    baseline = 'span'
  }
) {
  const horizonMs = horizonDays * DAY_MS
  const halfLifeMs = halfLifeHours * 3600_000
  const halfLifeDays = halfLifeHours / 24
  const stackWindowMs = stackWindowHours * 3600_000
  const timeline = buildFileTimeline(prs)
  const exposureDays = new Map()
  for (const [path, entries] of timeline) {
    const observed = (latestT - entries[0].t) / DAY_MS
    exposureDays.set(path, Math.max(1, Math.min(spanDays, observed)))
  }
  for (const pr of prs) {
    pr.pathSet = new Set(pr.paths)
  }
  // Why: PRs merged inside the trailing horizon have not had time to be reworked; scoring
  // them as clean would bias every rate downward exactly where the data is freshest.
  const censorBefore = latestT - horizonMs
  const out = new Map()
  for (const pr of prs) {
    if (pr.t > censorBefore) {
      out.set(pr, emptyMetrics(true))
      continue
    }
    const paths = [...pr.pathSet]
    if (paths.length === 0) {
      out.set(pr, emptyMetrics(false))
      continue
    }
    let touched = 0
    let expectedSum = 0
    let decaySum = 0
    let decayExpectedSum = 0
    let containmentSum = 0
    let asymmetrySum = 0
    let fixTouched = 0
    for (const path of paths) {
      const entries = timeline.get(path) ?? []
      let first = null
      let othersEver = 0
      for (const other of entries) {
        if (other === pr || !isRework(pr, other, stackWindowMs)) {
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
      const denomDays = baseline === 'exposure' ? exposureDays.get(path) : spanDays
      const lambdaPerDay = denomDays > 0 ? othersEver / denomDays : 0
      expectedSum += 1 - Math.exp(-lambdaPerDay * horizonDays)
      decayExpectedSum += expectedDecayWeight(lambdaPerDay, horizonDays, halfLifeDays)
      if (first) {
        touched += 1
        decaySum += timeDecayWeight(first.t - pr.t, halfLifeMs)
        const sig = repairSignature(pr, first)
        containmentSum += sig.containment
        asymmetrySum += sig.asymmetry
        if (isFixSubject(first.subject)) {
          fixTouched += 1
        }
      }
    }
    const n = paths.length
    const reworkRate = touched / n
    const expected = expectedSum / n
    const decay = decaySum / n
    const decayExpected = decayExpectedSum / n
    out.set(pr, {
      censored: false,
      reworkRate,
      expected,
      lift: reworkRate - expected,
      decay,
      decayExpected,
      decayLift: decay - decayExpected,
      containment: touched === 0 ? 0 : containmentSum / touched,
      asymmetry: touched === 0 ? 0 : asymmetrySum / touched,
      events: touched,
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

export const shuffleInPlace = (xs, rand) => {
  for (let i = xs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    ;[xs[i], xs[j]] = [xs[j], xs[i]]
  }
  return xs
}

/**
 * Split rows into shuffle cells: equal-count strata of a continuous key, nested inside the
 * categorical `cell` when rows carry one.
 *
 * Why nest: file heat is not the only thing that moves with a group label. Agent share rises
 * over the window, and so does repo-wide follow-up rate, so a heat-only shuffle would let
 * calendar drift masquerade as an authorship effect.
 */
export function strataOf(rows, keyOf, count) {
  const byCell = new Map()
  for (const row of rows) {
    const key = row.cell ?? ''
    let bucket = byCell.get(key)
    if (!bucket) {
      bucket = []
      byCell.set(key, bucket)
    }
    bucket.push(row)
  }
  const buckets = []
  for (const cell of byCell.values()) {
    const sorted = [...cell].sort((a, b) => keyOf(a) - keyOf(b))
    const per = Math.max(1, Math.ceil(sorted.length / count))
    for (let i = 0; i < sorted.length; i += per) {
      buckets.push(sorted.slice(i, i + per))
    }
  }
  return buckets
}

// Why: weighted between-group spread of lift is the thing a "some authors ship reworkable
// code" claim rests on; if a label shuffle reproduces it, the metric is reading file heat.
export function betweenGroupSpread(rows, minPRs) {
  const byGroup = new Map()
  for (const r of rows) {
    let bucket = byGroup.get(r.group)
    if (!bucket) {
      bucket = []
      byGroup.set(r.group, bucket)
    }
    bucket.push(r.value)
  }
  const kept = [...byGroup.values()].filter((v) => v.length >= minPRs)
  if (kept.length < 2) {
    return { spread: 0, groups: kept.length }
  }
  const means = kept.map((v) => mean(v))
  const grand = mean(means)
  return { spread: Math.sqrt(mean(means.map((m) => (m - grand) ** 2))), groups: kept.length }
}

const percentileOf = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]

/**
 * Group-label shuffle null test.
 *
 * Why: the live null hypothesis is "rework reflects file heat and feature area, not
 * authorship". Shuffling labels *within* file-heat strata holds heat fixed, so anything left
 * is the label. Labels are permuted over fixed values — the standard permutation test; it does
 * not re-derive the stacked-PR exclusion, which is stated in the report.
 */
export function groupShuffleNull(rows, { rounds = 200, strata = 4, minPRs = 20, seed = 20260816 }) {
  const observed = betweenGroupSpread(rows, minPRs)
  if (observed.groups < 2 || rows.length === 0 || rounds <= 0) {
    return { ...observed, nullMean: 0, nullP95: 0, pValue: 1, rounds: 0 }
  }
  const buckets = strataOf(rows, (r) => r.stratum, strata)
  const rand = mulberry32(seed)
  const nulls = []
  for (let r = 0; r < rounds; r += 1) {
    const shuffled = []
    for (const bucket of buckets) {
      const groups = shuffleInPlace(
        bucket.map((x) => x.group),
        rand
      )
      bucket.forEach((row, i) => shuffled.push({ group: groups[i], value: row.value }))
    }
    nulls.push(betweenGroupSpread(shuffled, minPRs).spread)
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
