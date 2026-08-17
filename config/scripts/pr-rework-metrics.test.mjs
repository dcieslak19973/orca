import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  areaOfPath,
  authorTypeOf,
  betweenGroupSpread,
  buildFileTimeline,
  computeReworkMetrics,
  dominantArea,
  expectedDecayWeight,
  groupShuffleNull,
  hasConventionalPrefix,
  isFixSubject,
  isRework,
  meanWithError,
  mulberry32,
  normalizeNumstatPath,
  repairSignature,
  scopeOf,
  ticketOf,
  timeDecayWeight
} from './pr-rework-metrics.mjs'

const HOUR_MS = 3600_000
const base = Date.parse('2026-01-01T00:00:00Z')

function pr(overrides) {
  return {
    author: 'alice',
    subject: 'feat(x): thing',
    ticket: null,
    paths: ['a.ts'],
    churn: 100,
    t: base,
    ...overrides
  }
}

// Baseline span/latest chosen so nothing is right-censored unless a test wants it.
const opts = (extra = {}) => ({
  horizonDays: 30,
  halfLifeHours: 48,
  spanDays: 365,
  latestT: base + 400 * DAY_MS,
  ...extra
})

describe('normalizeNumstatPath', () => {
  it('collapses a braced rename to the new path', () => {
    expect(normalizeNumstatPath('src/{old => new}/file.ts')).toBe('src/new/file.ts')
  })

  it('collapses an arrow rename to the new path', () => {
    expect(normalizeNumstatPath('old/file.ts => new/file.ts')).toBe('new/file.ts')
  })

  it('drops an emptied brace segment without leaving a double slash', () => {
    expect(normalizeNumstatPath('src/{legacy => }/file.ts')).toBe('src/file.ts')
  })

  it('leaves an ordinary path untouched', () => {
    expect(normalizeNumstatPath('src/main/index.ts')).toBe('src/main/index.ts')
  })
})

describe('timeDecayWeight', () => {
  it('weights a same-hour repair far above a months-later edit', () => {
    const soon = timeDecayWeight(6 * HOUR_MS, 48 * HOUR_MS)
    const later = timeDecayWeight(90 * DAY_MS, 48 * HOUR_MS)
    expect(soon).toBeGreaterThan(0.9)
    expect(later).toBeLessThan(0.01)
    expect(soon).toBeGreaterThan(later * 50)
  })

  it('halves at exactly one half-life', () => {
    expect(timeDecayWeight(48 * HOUR_MS, 48 * HOUR_MS)).toBeCloseTo(0.5, 10)
  })
})

describe('expectedDecayWeight', () => {
  it('is zero for a file nobody else touches', () => {
    expect(expectedDecayWeight(0, 30, 2)).toBe(0)
  })

  // Why: the closed form replaces a simulation, so it must match one.
  it('matches a Monte Carlo draw of the first follow-up', () => {
    const lambda = 0.25
    const horizon = 30
    const halfLife = 2
    const rand = mulberry32(7)
    let total = 0
    const draws = 200_000
    for (let i = 0; i < draws; i += 1) {
      const t = -Math.log(1 - rand()) / lambda
      total += t <= horizon ? 2 ** (-t / halfLife) : 0
    }
    expect(expectedDecayWeight(lambda, horizon, halfLife)).toBeCloseTo(total / draws, 2)
  })

  it('rises with file heat', () => {
    expect(expectedDecayWeight(1, 30, 2)).toBeGreaterThan(expectedDecayWeight(0.05, 30, 2))
  })
})

describe('isRework', () => {
  it('excludes a same-author follow-up inside the stacking window', () => {
    expect(isRework(pr(), pr({ t: base + DAY_MS }))).toBe(false)
  })

  // Why: a blanket same-author exclusion removes more candidate reworkers from prolific
  // authors than from rare ones, which is measurement error aligned with the comparison.
  it('counts a same-author follow-up long after the stacking window', () => {
    expect(isRework(pr(), pr({ t: base + 20 * DAY_MS }))).toBe(true)
  })

  it('excludes a different author on the same ticket at any distance', () => {
    const first = pr({ ticket: 'STA-1' })
    const later = pr({ author: 'bob', ticket: 'STA-1', t: base + 40 * DAY_MS })
    expect(isRework(first, later)).toBe(false)
  })

  it('counts a different author with no shared ticket', () => {
    expect(isRework(pr(), pr({ author: 'bob', t: base + DAY_MS }))).toBe(true)
  })
})

describe('repairSignature', () => {
  it('reads a surgical return to the same code as contained and asymmetric', () => {
    const first = { pathSet: new Set(['a.ts', 'b.ts', 'c.ts']), churn: 400 }
    const later = { paths: ['a.ts'], churn: 3 }
    const sig = repairSignature(first, later)
    expect(sig.containment).toBe(1)
    expect(sig.asymmetry).toBeGreaterThan(0.98)
  })

  it('reads a repo-wide sweep as uncontained and symmetric', () => {
    const first = { pathSet: new Set(['a.ts']), churn: 100 }
    const later = { paths: ['a.ts', 'x.ts', 'y.ts', 'z.ts'], churn: 100 }
    const sig = repairSignature(first, later)
    expect(sig.containment).toBe(0.25)
    expect(sig.asymmetry).toBe(0.5)
  })
})

describe('area and label helpers', () => {
  it('derives a two-level area under the known source roots', () => {
    expect(areaOfPath('src/main/terminal/pty.ts')).toBe('main/terminal')
    expect(areaOfPath('src/renderer/src/components/Task.tsx')).toBe('components/Task.tsx')
    expect(areaOfPath('README.md')).toBe('(root)')
  })

  it('takes the modal area of a PR', () => {
    expect(dominantArea(['src/main/git/a.ts', 'src/main/git/b.ts', 'src/shared/c.ts'])).toBe(
      'main/git'
    )
  })

  it('marks an agent co-author trailer and does not claim the rest are human', () => {
    expect(authorTypeOf('Co-authored-by: Orca <help@stably.ai>')).toBe('agent')
    expect(authorTypeOf('Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>')).toBe('agent')
    expect(authorTypeOf('Reviewed-by: Someone')).toBe('untagged')
    expect(authorTypeOf(undefined)).toBe('untagged')
  })

  it('recognises conventional prefixes, fix: and scopes', () => {
    expect(hasConventionalPrefix('fix: thing')).toBe(true)
    expect(hasConventionalPrefix('feat(terminal)!: thing')).toBe(true)
    expect(hasConventionalPrefix('Remove worktree deletion toasts')).toBe(false)
    expect(isFixSubject('fix(ssh): thing')).toBe(true)
    expect(isFixSubject('feat(ssh): thing')).toBe(false)
    expect(scopeOf('feat(Terminal)!: x')).toBe('terminal')
    expect(scopeOf('chore: x')).toBeNull()
  })

  it('extracts an STA ticket case-insensitively', () => {
    expect(ticketOf('fix(x): thing (STA-4276)')).toBe('STA-4276')
    expect(ticketOf('fix(x): sta-99 lowercase')).toBe('STA-99')
    expect(ticketOf('fix(x): no ticket')).toBeNull()
  })
})

describe('buildFileTimeline', () => {
  it('indexes each path once per PR and orders entries by time', () => {
    const late = pr({ t: base + 2 * DAY_MS, paths: ['a.ts'] })
    const early = pr({ t: base, paths: ['a.ts', 'a.ts', 'b.ts'] })
    const timeline = buildFileTimeline([late, early])
    expect(timeline.get('a.ts')).toEqual([early, late])
    expect(timeline.get('b.ts')).toEqual([early])
  })
})

describe('computeReworkMetrics', () => {
  it('counts a later different-author touch as rework', () => {
    const first = pr()
    const second = pr({ author: 'bob', t: base + 3 * DAY_MS })
    const m = computeReworkMetrics([first, second], opts()).get(first)
    expect(m.reworkRate).toBe(1)
    expect(m.censored).toBe(false)
  })

  it('does not count a touch beyond the horizon', () => {
    const first = pr()
    const second = pr({ author: 'bob', t: base + 45 * DAY_MS })
    expect(computeReworkMetrics([first, second], opts()).get(first).reworkRate).toBe(0)
  })

  it('does not count the PR stacked behind it', () => {
    const first = pr()
    const second = pr({ t: base + DAY_MS })
    expect(computeReworkMetrics([first, second], opts()).get(first).reworkRate).toBe(0)
  })

  // Why: the whole point of lift — a hot file must not score as rework just for being hot.
  it('subtracts a hot file baseline so lift stays near zero', () => {
    const others = Array.from({ length: 60 }, (_, i) =>
      pr({ author: `dev${i}`, t: base + (i + 1) * 6 * DAY_MS })
    )
    const first = pr()
    const m = computeReworkMetrics([first, ...others], opts({ spanDays: 360 })).get(first)
    expect(m.reworkRate).toBe(1)
    expect(m.expected).toBeGreaterThan(0.9)
    expect(Math.abs(m.lift)).toBeLessThan(0.1)
  })

  // Why: the binary rate saturates on a busy repo; the decay-weighted rate must not, and it
  // needs the same baseline subtraction or it just re-reads heat.
  it('separates a fast repair from slow evolution after baseline subtraction', () => {
    const fast = pr({ paths: ['fast.ts'] })
    const slow = pr({ paths: ['slow.ts'] })
    const metrics = computeReworkMetrics(
      [
        fast,
        slow,
        pr({ author: 'bob', paths: ['fast.ts'], t: base + 2 * HOUR_MS }),
        pr({ author: 'bob', paths: ['slow.ts'], t: base + 25 * DAY_MS })
      ],
      opts()
    )
    expect(metrics.get(fast).reworkRate).toBe(metrics.get(slow).reworkRate)
    expect(metrics.get(fast).decayLift).toBeGreaterThan(0.9)
    expect(metrics.get(slow).decayLift).toBeLessThan(0.05)
  })

  it('scores containment and asymmetry of the first follow-up', () => {
    const first = pr({ paths: ['a.ts', 'b.ts'], churn: 400 })
    const surgical = pr({ author: 'bob', paths: ['a.ts'], churn: 4, t: base + HOUR_MS })
    const sweep = pr({
      author: 'carol',
      paths: ['b.ts', 'x.ts', 'y.ts', 'z.ts'],
      churn: 400,
      t: base + HOUR_MS
    })
    const m = computeReworkMetrics([first, surgical, sweep], opts()).get(first)
    expect(m.events).toBe(2)
    expect(m.containment).toBeCloseTo((1 + 0.25) / 2, 10)
    expect(m.asymmetry).toBeCloseTo((400 / 404 + 0.5) / 2, 10)
  })

  it('censors PRs merged inside the trailing horizon instead of scoring them clean', () => {
    const recent = pr({ t: base + 395 * DAY_MS })
    const m = computeReworkMetrics([recent], opts()).get(recent)
    expect(m.censored).toBe(true)
    expect(m.lift).toBe(0)
  })

  it('averages partial rework across a multi-file PR', () => {
    const first = pr({ paths: ['a.ts', 'b.ts'] })
    const second = pr({ author: 'bob', paths: ['a.ts'], t: base + DAY_MS })
    expect(computeReworkMetrics([first, second], opts()).get(first).reworkRate).toBe(0.5)
  })

  it('reports the fix: share of rework events without letting it drive lift', () => {
    const first = pr({ paths: ['a.ts', 'b.ts'] })
    const fixer = pr({
      author: 'bob',
      subject: 'fix(a): repair',
      paths: ['a.ts'],
      t: base + DAY_MS
    })
    const featurer = pr({
      author: 'carol',
      subject: 'feat(b): extend',
      paths: ['b.ts'],
      t: base + DAY_MS
    })
    const m = computeReworkMetrics([first, fixer, featurer], opts()).get(first)
    expect(m.reworkRate).toBe(1)
    expect(m.fixShare).toBe(0.5)
  })
})

describe('meanWithError', () => {
  it('reports the standard error of the mean', () => {
    const s = meanWithError([1, 2, 3, 4])
    expect(s.mean).toBe(2.5)
    expect(s.se).toBeCloseTo(Math.sqrt(5 / 3 / 4), 10)
  })

  it('has no error to report for a single observation', () => {
    expect(meanWithError([7])).toEqual({ n: 1, mean: 7, se: 0 })
  })
})

describe('betweenGroupSpread', () => {
  it('ignores groups below the minimum sample', () => {
    const rows = [
      ...Array.from({ length: 25 }, () => ({ group: 'alice', value: 0.4 })),
      { group: 'bob', value: -0.4 }
    ]
    expect(betweenGroupSpread(rows, 20).groups).toBe(1)
    expect(betweenGroupSpread(rows, 20).spread).toBe(0)
  })

  it('grows as group means diverge', () => {
    const tight = [
      ...Array.from({ length: 25 }, () => ({ group: 'alice', value: 0.1 })),
      ...Array.from({ length: 25 }, () => ({ group: 'bob', value: 0.1 }))
    ]
    const wide = [
      ...Array.from({ length: 25 }, () => ({ group: 'alice', value: 0.5 })),
      ...Array.from({ length: 25 }, () => ({ group: 'bob', value: -0.5 }))
    ]
    expect(betweenGroupSpread(tight, 20).spread).toBeCloseTo(0, 10)
    expect(betweenGroupSpread(wide, 20).spread).toBeGreaterThan(0.4)
  })
})

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('groupShuffleNull', () => {
  // Why: the live null is "this is file heat, not authorship" — a heat-driven effect must not survive.
  it('fails to reject when the value tracks file heat rather than the group', () => {
    const rows = []
    for (let i = 0; i < 60; i += 1) {
      const heat = i / 60
      rows.push({ group: i % 2 === 0 ? 'alice' : 'bob', value: heat, stratum: heat })
    }
    const result = groupShuffleNull(rows, { rounds: 200, minPRs: 20 })
    expect(result.groups).toBe(2)
    expect(result.pValue).toBeGreaterThan(0.05)
  })

  it('rejects when one group carries higher lift at equal file heat', () => {
    const rows = []
    for (let i = 0; i < 60; i += 1) {
      const alice = i % 2 === 0
      rows.push({ group: alice ? 'alice' : 'bob', value: alice ? 0.5 : -0.5, stratum: 0.5 })
    }
    expect(groupShuffleNull(rows, { rounds: 200, minPRs: 20 }).pValue).toBeLessThanOrEqual(0.05)
  })

  it('reports UNEVALUABLE shape when only one group clears the minimum', () => {
    const rows = Array.from({ length: 30 }, () => ({ group: 'alice', value: 0.2, stratum: 0.2 }))
    const result = groupShuffleNull(rows, { rounds: 50, minPRs: 20 })
    expect(result.groups).toBe(1)
    expect(result.pValue).toBe(1)
  })

  it('reports zero rounds when the shuffle is switched off', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      group: i % 2 ? 'a' : 'b',
      value: i / 60,
      stratum: i / 60
    }))
    expect(groupShuffleNull(rows, { rounds: 0, minPRs: 20 }).rounds).toBe(0)
  })
})

describe('exposure-adjusted baseline', () => {
  // Why: a file first seen late in the window has its rate divided by the whole span, which
  // understates it and inflates the lift of every PR that touches a young file.
  it('raises the baseline for a file that only exists late in the window', () => {
    const young = pr({ paths: ['young.ts'], t: base + 300 * DAY_MS })
    const follow = pr({ author: 'bob', paths: ['young.ts'], t: base + 310 * DAY_MS })
    const args = { ...opts(), spanDays: 365 }
    const span = computeReworkMetrics([young, follow], args).get(young)
    const exposure = computeReworkMetrics([young, follow], {
      ...args,
      baseline: 'exposure'
    }).get(young)

    expect(span.reworkRate).toBe(exposure.reworkRate)
    // 1 touch over the file's 100 observed days, not over the 365-day window.
    expect(exposure.expected).toBeCloseTo(1 - Math.exp(-0.3), 6)
    expect(span.expected).toBeCloseTo(1 - Math.exp(-30 / 365), 6)
    expect(exposure.lift).toBeLessThan(span.lift)
  })
})
