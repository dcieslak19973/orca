/**
 * Shared types for the PR watch-rules evaluator and its load-time validator.
 * Split out so both modules import these via `import type` (erased at runtime),
 * keeping each source file under its line budget with no cross-module value import.
 */

export type PRWatchInput = {
  title: string
  labels?: string[]
  author?: string | null
  branchName?: string
  /** undefined = not fetched yet; [] = fetched and genuinely empty */
  paths?: string[]
  draft?: boolean
  mergeable?: 'conflicting' | 'mergeable' | 'unknown'
  files?: number
  churn?: number
  /** undefined = not loaded; 0 = loaded, author has no merged PRs */
  authorMergedPRs?: number
}

export type PRWatchConditions = {
  scope?: string | string[]
  type?: string | string[]
  title?: string
  labels?: string[]
  author?: string[]
  branch?: string
  paths?: string[]
  draft?: boolean
  mergeable?: 'conflicting' | 'mergeable' | 'unknown'
  files?: string
  churn?: string
  authorMergedPRs?: string
  /** ORed condition groups, ANDed with any sibling conditions. */
  any?: PRWatchConditions[]
}

export type PRWatchRule = { name: string; when: PRWatchConditions; note?: string }
export type PRWatchTierRule = PRWatchRule & {
  action?: 'bounce'
  slot?: 'deep'
  batchBy?: 'author'
}

export type PRWatchMatch = { rule: string; note?: string; pending: boolean }

export type PercentileDistribution = Partial<
  Record<
    'files' | 'churn' | 'authorMergedPRs',
    Partial<Record<'p50' | 'p75' | 'p90' | 'p95', number>>
  >
>
export type EvaluateOptions = { percentiles?: PercentileDistribution }

export type TierResult = { tier: string | null; pending: boolean }
