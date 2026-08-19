import { describe, expect, it } from 'vitest'
import {
  humanReviewersOf,
  olsFit,
  predict,
  rSquared,
  reviewerDemean,
  spearman
} from './pr-review-residual.mjs'
import { summarizeReviews } from './pr-review-timeline.mjs'

describe('olsFit', () => {
  it('recovers the generating coefficients of a noiseless fit', () => {
    const rows = Array.from({ length: 40 }, (_, i) => [1, i, (i % 7) - 3])
    const y = rows.map(([, a, b]) => 2 + 0.5 * a - 1.25 * b)
    const beta = olsFit(rows, y)

    expect(beta[0]).toBeCloseTo(2, 6)
    expect(beta[1]).toBeCloseTo(0.5, 6)
    expect(beta[2]).toBeCloseTo(-1.25, 6)
    expect(rSquared(rows, y, beta)).toBeCloseTo(1, 10)
  })

  it('leaves the unexplained part in the residual', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [1, i])
    const y = rows.map(([, a], i) => a + (i === 0 ? 10 : 0))
    const beta = olsFit(rows, y)

    expect(y[0] - predict(rows[0], beta)).toBeGreaterThan(5)
    expect(rSquared(rows, y, beta)).toBeLessThan(1)
  })
})

describe('spearman', () => {
  it('is 1 for a monotone but non-linear relation', () => {
    const xs = [1, 2, 3, 4, 5]
    expect(
      spearman(
        xs,
        xs.map((x) => x ** 3)
      )
    ).toBeCloseTo(1, 10)
  })

  it('is negative when the ranks invert', () => {
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10)
  })
})

describe('reviewerDemean', () => {
  // Why: without this, "excess friction" is partly "this reviewer always asks for changes".
  it('removes a strict reviewer offset and pools rare reviewers', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => ({ reviewer: 'strict', residual: 1 })),
      ...Array.from({ length: 10 }, () => ({ reviewer: 'lenient', residual: -1 })),
      { reviewer: 'rare1', residual: 0.5 },
      { reviewer: 'rare2', residual: -0.5 }
    ]
    const out = reviewerDemean(rows, { minPRs: 10 })

    expect(out[0].eps).toBeCloseTo(0, 10)
    expect(out[10].eps).toBeCloseTo(0, 10)
    expect(out.at(-1).reviewerCell).toBe('(other)')
    expect(out.at(-2).eps).toBeCloseTo(0.5, 10)
  })
})

describe('humanReviewersOf', () => {
  // Why: none of the AI reviewers in this repo carry a [bot] login suffix.
  it('treats every AI reviewer as non-human regardless of login suffix', () => {
    expect(
      humanReviewersOf({
        reviewers: [
          'coderabbitai',
          'greptile-apps',
          'pullfrog',
          'copilot-pull-request-reviewer',
          'dependabot[bot]',
          'nwparker'
        ]
      })
    ).toEqual(['nwparker'])
  })

  it('reports no human reviewer for a bot-only review', () => {
    expect(humanReviewersOf({ reviewers: ['coderabbitai'] })).toEqual([])
    expect(humanReviewersOf({})).toEqual([])
  })
})

describe('summarizeReviews', () => {
  it('counts a round per changes-requested review and collects distinct reviewers', () => {
    const summary = summarizeReviews({
      number: 7,
      createdAt: '2026-05-01T00:00:00Z',
      mergedAt: '2026-05-01T06:00:00Z',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      author: { login: 'alice' },
      reviews: {
        totalCount: 3,
        nodes: [
          {
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-05-01T02:00:00Z',
            author: { login: 'bob' }
          },
          {
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-05-01T03:00:00Z',
            author: { login: 'bob' }
          },
          { state: 'APPROVED', submittedAt: '2026-05-01T05:00:00Z', author: { login: 'carol' } }
        ]
      },
      reviewThreads: { totalCount: 9 },
      comments: { totalCount: 2 },
      commits: { totalCount: 4 }
    })

    expect(summary).toMatchObject({
      rounds: 3,
      changesRequested: 2,
      approvals: 1,
      reviewers: ['bob', 'carol'],
      threads: 9,
      hoursOpen: 6
    })
    expect(summary.firstReviewAt).toBe('2026-05-01T02:00:00Z')
  })

  it('reports a never-reviewed PR as zero rounds of evidence', () => {
    const summary = summarizeReviews({
      number: 8,
      createdAt: '2026-05-01T00:00:00Z',
      mergedAt: '2026-05-01T00:10:00Z',
      reviews: { totalCount: 0, nodes: [] },
      reviewThreads: { totalCount: 0 },
      comments: { totalCount: 0 },
      commits: { totalCount: 1 }
    })

    expect(summary).toMatchObject({ reviews: 0, threads: 0, reviewers: [], rounds: 1 })
    expect(summary.author).toBeNull()
  })
})
