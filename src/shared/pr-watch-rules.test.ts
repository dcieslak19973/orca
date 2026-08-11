import { describe, expect, it } from 'vitest'
import {
  classifyReviewQueueTier,
  evaluateWatchRules,
  parseConventionalTitle,
  validateTierRules,
  validateWatchRules
} from './pr-watch-rules'

const input = (over: Partial<Parameters<typeof evaluateWatchRules>[1]> = {}) => ({
  title: 'fix(terminal): stop repaint flicker',
  ...over
})

describe('parseConventionalTitle', () => {
  it('parses scoped, bare, and unprefixed titles', () => {
    expect(parseConventionalTitle('fix(terminal): x')).toEqual({ type: 'fix', scope: 'terminal' })
    expect(parseConventionalTitle('Feat(SSH): y')).toEqual({ type: 'feat', scope: 'ssh' })
    expect(parseConventionalTitle('docs: z')).toEqual({ type: 'docs', scope: null })
    expect(parseConventionalTitle('Add a thing')).toEqual({ type: null, scope: null })
    expect(parseConventionalTitle('feat(api)!: drop v1')).toEqual({ type: 'feat', scope: 'api' })
    expect(parseConventionalTitle('feat!: drop v1')).toEqual({ type: 'feat', scope: null })
  })
})

describe('evaluateWatchRules (chip mode)', () => {
  const rules = validateWatchRules([
    { name: 'Terminal', when: { scope: 'terminal' }, note: 'fragile' },
    { name: 'Wire', when: { paths: ['src/shared/rpc/**'] } },
    { name: 'Big fix', when: { type: ['fix', 'perf'], churn: '>=500' } }
  ])

  it('reports every matching rule, not just the first', () => {
    const matches = evaluateWatchRules(rules, input({ churn: 900 }))
    expect(matches.filter((m) => !m.pending).map((m) => m.rule)).toEqual(['Terminal', 'Big fix'])
  })

  it('carries the note through', () => {
    expect(evaluateWatchRules(rules, input())[0]).toMatchObject({
      rule: 'Terminal',
      note: 'fragile'
    })
  })

  it('ANDs conditions within a rule and ORs values within a list', () => {
    expect(
      evaluateWatchRules(rules, input({ title: 'perf(git): faster status', churn: 499, paths: [] }))
    ).toEqual([])
    expect(
      evaluateWatchRules(
        rules,
        input({ title: 'perf(git): faster status', churn: 500, paths: [] })
      ).map((m) => m.rule)
    ).toEqual(['Big fix'])
  })

  it('matches scope, type, labels, and author case-insensitively', () => {
    const r = validateWatchRules([
      { name: 'L', when: { labels: ['Needs-QA'] } },
      { name: 'A', when: { author: ['NWParker'] } }
    ])
    expect(
      evaluateWatchRules(r, input({ labels: ['needs-qa'], author: 'nwparker' })).map((m) => m.rule)
    ).toEqual(['L', 'A'])
  })

  it('is pending, not unmatched, when a paths rule sees paths undefined', () => {
    const m = evaluateWatchRules(rules, input({ title: 'feat(rpc): add opcode' }))
    expect(m).toEqual([{ rule: 'Wire', note: undefined, pending: true }])
  })

  it('does not match when paths were fetched and are empty', () => {
    expect(evaluateWatchRules(rules, input({ title: 'feat(rpc): add opcode', paths: [] }))).toEqual(
      []
    )
  })

  it('matches globs including ** and directory anchors', () => {
    const r = validateWatchRules([
      { name: 'G', when: { paths: ['src/main/**/*.test.ts', 'docs/*.md'] } }
    ])
    const hit = (p: string) =>
      evaluateWatchRules(r, input({ paths: [p] })).some((m) => m.rule === 'G' && !m.pending)
    expect(hit('src/main/git/status.test.ts')).toBe(true)
    expect(hit('docs/readme.md')).toBe(true)
    expect(hit('docs/nested/readme.md')).toBe(false)
    expect(hit('src/main.ts')).toBe(false)
  })

  it('matches title and branch by regex', () => {
    const r = validateWatchRules([
      { name: 'T', when: { title: 'revert|rollback' } },
      { name: 'B', when: { branch: '^release/' } }
    ])
    expect(
      evaluateWatchRules(r, input({ title: 'Rollback the cache', branchName: 'release/1.5' })).map(
        (m) => m.rule
      )
    ).toEqual(['T', 'B'])
  })

  it('resolves percentile tokens against an injected distribution', () => {
    const r = validateWatchRules([{ name: 'P', when: { files: '>=p90' } }])
    const dist = { files: { p50: 7, p75: 18, p90: 33 }, churn: { p50: 180, p75: 620, p90: 1500 } }
    expect(
      evaluateWatchRules(r, input({ files: 40 }), { percentiles: dist }).map((m) => m.rule)
    ).toEqual(['P'])
    expect(evaluateWatchRules(r, input({ files: 20 }), { percentiles: dist })).toEqual([])
  })

  it('is pending when a percentile token has no distribution to resolve against', () => {
    const r = validateWatchRules([{ name: 'P', when: { files: '>=p90' } }])
    expect(evaluateWatchRules(r, input({ files: 40 }))).toEqual([
      { rule: 'P', note: undefined, pending: true }
    ])
  })

  it('treats authorMergedPRs 0 as loaded-and-zero, undefined as pending', () => {
    const r = validateWatchRules([{ name: 'New', when: { authorMergedPRs: '==0' } }])
    expect(evaluateWatchRules(r, input({ authorMergedPRs: 0 })).map((m) => m.rule)).toEqual(['New'])
    expect(evaluateWatchRules(r, input({}))).toEqual([
      { rule: 'New', note: undefined, pending: true }
    ])
  })

  it('treats a null author as a definite miss, not pending', () => {
    const r = validateWatchRules([{ name: 'A', when: { author: ['nwparker'] } }])
    expect(evaluateWatchRules(r, input({ author: null }))).toEqual([])
    expect(evaluateWatchRules(r, input({}))).toEqual([
      { rule: 'A', note: undefined, pending: true }
    ])
  })
})

describe('validateWatchRules', () => {
  it('rejects unknown keys, duplicate names, empty when, bad globs, bad regexes', () => {
    expect(() => validateWatchRules([{ name: 'X', when: { bogus: 1 } }])).toThrow(/bogus/)
    expect(() =>
      validateWatchRules([
        { name: 'X', when: { scope: 'a' } },
        { name: 'X', when: { scope: 'b' } }
      ])
    ).toThrow(/duplicate/i)
    expect(() => validateWatchRules([{ name: 'X', when: {} }])).toThrow(/condition/i)
    expect(() => validateWatchRules([{ name: 'X', when: { title: '(' } }])).toThrow(/regex/i)
    expect(() => validateWatchRules([{ name: 'X', when: { files: 'p90' } }])).toThrow(/comparison/i)
  })

  it('rejects malformed condition value shapes', () => {
    expect(() => validateWatchRules([{ name: 'X', when: { labels: 'bug' } }])).toThrow(
      /array of strings/
    )
    expect(() => validateWatchRules([{ name: 'X', when: { paths: 'src/**' } }])).toThrow(
      /array of strings/
    )
    expect(() => validateWatchRules([{ name: 'X', when: { scope: [1] } }])).toThrow(
      /string or an array/
    )
    expect(() => validateWatchRules([{ name: 'X', when: { draft: 'yes' } }])).toThrow(
      /true or false/
    )
    expect(() => validateWatchRules([{ name: 'X', when: { mergeable: 'conflict' } }])).toThrow(
      /conflicting/
    )
  })

  it('rejects non-string regex conditions instead of coercing them', () => {
    for (const key of ['title', 'branch'] as const) {
      for (const bad of [42, null, {}, ['a']]) {
        expect(() => validateWatchRules([{ name: 'X', when: { [key]: bad } }])).toThrow(
          /must be a string/
        )
      }
    }
  })

  it('validates nested any groups and rejects mode-specific keys', () => {
    expect(() => validateWatchRules([{ name: 'X', when: { any: [] } }])).toThrow(/non-empty/)
    expect(() => validateWatchRules([{ name: 'X', when: { any: [{ bogus: 1 }] } }])).toThrow(
      /bogus/
    )
    expect(() => validateWatchRules([{ name: 'X', when: { scope: 'a' }, slot: 'deep' }])).toThrow(
      /unknown key/
    )
    expect(validateTierRules([{ name: 'X', when: { scope: 'a' }, slot: 'deep' }])).toHaveLength(1)
  })
})

describe('classifyReviewQueueTier (first-match mode)', () => {
  const tiers = validateTierRules([
    { name: 'Not reviewable', when: { any: [{ draft: true }, { mergeable: 'conflicting' }] } },
    {
      name: 'Deep',
      when: { any: [{ files: '>=19' }, { churn: '>=1500' }, { scope: 'terminal' }] }
    },
    { name: 'New contributor', when: { authorMergedPRs: '==0' } },
    { name: 'Fast', when: { files: '<=7', churn: '<=400', type: ['fix', 'test', 'docs'] } }
  ])

  it('takes the first matching tier and stops', () => {
    expect(classifyReviewQueueTier(tiers, input({ draft: true, files: 50, churn: 9000 }))).toEqual({
      tier: 'Not reviewable',
      pending: false
    })
  })

  it('ORs any: groups', () => {
    expect(
      classifyReviewQueueTier(
        tiers,
        input({
          title: 'feat(git): x',
          files: 3,
          churn: 2000,
          authorMergedPRs: 5,
          draft: false,
          mergeable: 'mergeable'
        })
      )
    ).toEqual({ tier: 'Deep', pending: false })
  })

  it('falls through to the implicit catch-all', () => {
    expect(
      classifyReviewQueueTier(
        tiers,
        input({
          title: 'feat(git): x',
          files: 10,
          churn: 600,
          authorMergedPRs: 12,
          draft: false,
          mergeable: 'mergeable'
        })
      )
    ).toEqual({ tier: null, pending: false })
  })

  it('stops at a pending rule instead of unsafely falling past it', () => {
    // files unknown: the Deep tier cannot be ruled out, so classification is
    // tentatively Deep with pending — never silently Fast.
    expect(
      classifyReviewQueueTier(
        tiers,
        input({
          title: 'fix(git): x',
          churn: 120,
          authorMergedPRs: 3,
          draft: false,
          mergeable: 'mergeable'
        })
      )
    ).toEqual({ tier: 'Deep', pending: true })
  })

  it('classifies the fast tier for a small scoped fix from a known author', () => {
    expect(
      classifyReviewQueueTier(
        tiers,
        input({
          title: 'fix(git): x',
          files: 3,
          churn: 120,
          authorMergedPRs: 3,
          draft: false,
          mergeable: 'mergeable'
        })
      )
    ).toEqual({ tier: 'Fast', pending: false })
  })
})
