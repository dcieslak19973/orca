import { describe, expect, it } from 'vitest'
import { norm, parseNumstatLog } from './pr-watch-backtest.mjs'

const log = [
  '@@@abc|Alice|2026-01-02|2026-01-02T10:00:00Z|feat(x): add a thing (#10)',
  'Co-authored-by: Orca <help@stably.ai>',
  '12\t3\tsrc/main/a.ts',
  '0\t40\tsrc/main/b.ts',
  '-\t-\tassets/logo.png',
  '@@@def|Bob|2026-01-03|2026-01-03T10:00:00Z|fix(y): repair (#11)',
  '4\t4\tsrc/{old => new}/c.ts',
  ''
].join('\n')

describe('parseNumstatLog', () => {
  it('keeps additions and deletions apart and folds the body', () => {
    const [first, second] = parseNumstatLog(log)

    expect(first).toMatchObject({
      hash: 'abc',
      author: 'Alice',
      subject: 'feat(x): add a thing (#10)',
      additions: 12,
      deletions: 43,
      paths: ['src/main/a.ts', 'src/main/b.ts', 'assets/logo.png']
    })
    expect(first.body).toEqual(['Co-authored-by: Orca <help@stably.ai>'])
    expect(second).toMatchObject({ hash: 'def', additions: 4, deletions: 4 })
  })

  it('normalises renames so a file keeps one history', () => {
    expect(parseNumstatLog(log)[1].paths).toEqual(['src/new/c.ts'])
  })

  // Why: -m repeats the header per merge parent; only the first-parent section may count.
  it('folds repeated headers for the same commit', () => {
    const repeated = [
      '@@@abc|Alice|2026-01-02|2026-01-02T10:00:00Z|feat: x (#10)',
      '5\t1\ta.ts',
      '@@@abc|Alice|2026-01-02|2026-01-02T10:00:00Z|feat: x (#10)',
      '900\t900\tb.ts'
    ].join('\n')
    const commits = parseNumstatLog(repeated)

    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ additions: 5, deletions: 1, paths: ['a.ts'] })
  })
})

describe('norm', () => {
  it('strips the forge suffix so a revert can be matched to its subject', () => {
    expect(norm('fix(terminal): stop flicker (#14982)')).toBe('fix terminal stop flicker')
    expect(norm('fix(terminal): stop flicker (!42)')).toBe('fix terminal stop flicker')
  })
})
