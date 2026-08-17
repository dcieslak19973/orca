import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  authorShuffleNull,
  betweenAuthorSpread,
  buildFileTimeline,
  computeReworkMetrics,
  hasConventionalPrefix,
  isFixSubject,
  isRework,
  mulberry32,
  normalizeNumstatPath,
  ticketOf,
  timeDecayWeight
} from './pr-watch-backtest.mjs'

const HOUR_MS = 3600_000
const base = Date.parse('2026-01-01T00:00:00Z')

function pr(overrides) {
  return {
    author: 'alice',
    subject: 'feat(x): thing',
    ticket: null,
    paths: ['a.ts'],
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

describe('isRework', () => {
  it('excludes a same-author follow-up as stacked work', () => {
    expect(isRework(pr(), pr({ t: base + DAY_MS }))).toBe(false)
  })

  it('excludes a different author on the same ticket', () => {
    const first = pr({ ticket: 'STA-1' })
    const later = pr({ author: 'bob', ticket: 'STA-1', t: base + DAY_MS })
    expect(isRework(first, later)).toBe(false)
  })

  it('counts a different author with no shared ticket', () => {
    expect(isRework(pr(), pr({ author: 'bob', t: base + DAY_MS }))).toBe(true)
  })
})

describe('subject label helpers', () => {
  it('recognises conventional prefixes with and without scope', () => {
    expect(hasConventionalPrefix('fix: thing')).toBe(true)
    expect(hasConventionalPrefix('feat(terminal)!: thing')).toBe(true)
    expect(hasConventionalPrefix('Remove worktree deletion toasts')).toBe(false)
  })

  it('separates fix: from other conventional kinds', () => {
    expect(isFixSubject('fix(ssh): thing')).toBe(true)
    expect(isFixSubject('feat(ssh): thing')).toBe(false)
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

  it('scores lift high when a cold file is reworked immediately', () => {
    const first = pr({ paths: ['cold.ts'] })
    const second = pr({ author: 'bob', paths: ['cold.ts'], t: base + 2 * HOUR_MS })
    const m = computeReworkMetrics([first, second], opts()).get(first)
    expect(m.lift).toBeGreaterThan(0.9)
    expect(m.decay).toBeGreaterThan(0.9)
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

describe('betweenAuthorSpread', () => {
  it('ignores authors below the minimum sample', () => {
    const rows = [
      ...Array.from({ length: 25 }, () => ({ author: 'alice', lift: 0.4 })),
      { author: 'bob', lift: -0.4 }
    ]
    expect(betweenAuthorSpread(rows, 20).authors).toBe(1)
    expect(betweenAuthorSpread(rows, 20).spread).toBe(0)
  })

  it('grows as author means diverge', () => {
    const tight = [
      ...Array.from({ length: 25 }, () => ({ author: 'alice', lift: 0.1 })),
      ...Array.from({ length: 25 }, () => ({ author: 'bob', lift: 0.1 }))
    ]
    const wide = [
      ...Array.from({ length: 25 }, () => ({ author: 'alice', lift: 0.5 })),
      ...Array.from({ length: 25 }, () => ({ author: 'bob', lift: -0.5 }))
    ]
    expect(betweenAuthorSpread(tight, 20).spread).toBeCloseTo(0, 10)
    expect(betweenAuthorSpread(wide, 20).spread).toBeGreaterThan(0.4)
  })
})

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('authorShuffleNull', () => {
  // Why: the live null is "this is file heat, not authorship" — a heat-driven effect must not survive.
  it('fails to reject when lift tracks file heat rather than author', () => {
    const rows = []
    for (let i = 0; i < 60; i += 1) {
      const heat = i / 60
      rows.push({ author: i % 2 === 0 ? 'alice' : 'bob', lift: heat, expected: heat })
    }
    const result = authorShuffleNull(rows, { rounds: 200, minPRs: 20 })
    expect(result.authors).toBe(2)
    expect(result.pValue).toBeGreaterThan(0.05)
  })

  it('rejects when one author carries higher lift at equal file heat', () => {
    const rows = []
    for (let i = 0; i < 60; i += 1) {
      const alice = i % 2 === 0
      rows.push({ author: alice ? 'alice' : 'bob', lift: alice ? 0.5 : -0.5, expected: 0.5 })
    }
    const result = authorShuffleNull(rows, { rounds: 200, minPRs: 20 })
    expect(result.pValue).toBeLessThanOrEqual(0.05)
  })

  it('reports UNEVALUABLE shape when only one author clears the minimum', () => {
    const rows = Array.from({ length: 30 }, () => ({ author: 'alice', lift: 0.2, expected: 0.2 }))
    const result = authorShuffleNull(rows, { rounds: 50, minPRs: 20 })
    expect(result.authors).toBe(1)
    expect(result.pValue).toBe(1)
  })
})
