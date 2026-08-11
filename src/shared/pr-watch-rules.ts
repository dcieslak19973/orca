/**
 * Declarative PR watch rules + review-queue tier cascade (one evaluator, two modes).
 * Pure: percentile distributions are injected, never read from disk. See
 * docs/superpowers/specs/2026-08-07-pr-watch-rules-design.md.
 */

import type {
  EvaluateOptions,
  PRWatchConditions,
  PRWatchInput,
  PRWatchMatch,
  PRWatchRule,
  PRWatchTierRule,
  TierResult
} from './pr-watch-rules-types'

// 'no' beats 'pending' under AND (a definite miss can't become a match);
// 'match' beats 'pending' under OR.
type Verdict = 'match' | 'no' | 'pending'

const COMPARISON_RE = /^(>=|<=|>|<|==)\s*(p50|p75|p90|p95|\d+)$/
const CONVENTIONAL_RE = /^([a-z]+)(?:\(([a-z0-9/._-]+)\))?!?\s*:/i

// Rule regexes/globs are recompiled per PR by the backtest; memoize by source.
const regexCache = new Map<string, RegExp>()
const regexFor = (pattern: string): RegExp => {
  let re = regexCache.get(pattern)
  if (re === undefined) {
    re = new RegExp(pattern, 'i')
    regexCache.set(pattern, re)
  }
  return re
}

export function parseConventionalTitle(title: string): {
  type: string | null
  scope: string | null
} {
  const m = CONVENTIONAL_RE.exec(title)
  return { type: m?.[1]?.toLowerCase() ?? null, scope: m?.[2]?.toLowerCase() ?? null }
}

const globCache = new Map<string, RegExp>()
function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached !== undefined) {
    return cached
  }
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` also matches zero directories, so src/**/*.ts covers src/a.ts
        out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
        i += glob[i + 2] === '/' ? 2 : 1
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
    }
  }
  const re = new RegExp(`${out}$`)
  globCache.set(glob, re)
  return re
}

const eqFold = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const anyOf = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v])

function compare(
  spec: string,
  value: number | undefined,
  key: 'files' | 'churn' | 'authorMergedPRs',
  opts: EvaluateOptions
): Verdict {
  if (value === undefined) {
    return 'pending'
  }
  const m = COMPARISON_RE.exec(spec)!
  let bound: number
  if (m[2].startsWith('p')) {
    const resolved = opts.percentiles?.[key]?.[m[2] as 'p50']
    if (resolved === undefined) {
      return 'pending'
    }
    bound = resolved
  } else {
    bound = Number(m[2])
  }
  const ok =
    m[1] === '>='
      ? value >= bound
      : m[1] === '<='
        ? value <= bound
        : m[1] === '>'
          ? value > bound
          : m[1] === '<'
            ? value < bound
            : value === bound
  return ok ? 'match' : 'no'
}

function evaluateConditions(
  when: PRWatchConditions,
  input: PRWatchInput,
  opts: EvaluateOptions
): Verdict {
  const parsed = parseConventionalTitle(input.title)
  const verdicts: Verdict[] = []
  const bool = (ok: boolean): Verdict => (ok ? 'match' : 'no')
  const known = <T>(value: T | undefined, judge: (v: T) => Verdict): Verdict =>
    value === undefined ? 'pending' : judge(value)

  if (when.scope !== undefined) {
    verdicts.push(
      bool(parsed.scope !== null && anyOf(when.scope).some((s) => eqFold(s, parsed.scope!)))
    )
  }
  if (when.type !== undefined) {
    verdicts.push(
      bool(parsed.type !== null && anyOf(when.type).some((t) => eqFold(t, parsed.type!)))
    )
  }
  if (when.title !== undefined) {
    verdicts.push(bool(regexFor(when.title).test(input.title)))
  }
  if (when.branch !== undefined) {
    verdicts.push(known(input.branchName, (b) => bool(regexFor(when.branch!).test(b))))
  }
  if (when.labels !== undefined) {
    verdicts.push(
      known(input.labels, (ls) => bool(when.labels!.some((w) => ls.some((l) => eqFold(l, w)))))
    )
  }
  if (when.author !== undefined) {
    // null = no author (deleted account): a definite miss, not pending.
    verdicts.push(
      input.author === null
        ? 'no'
        : known(input.author, (a) => bool(when.author!.some((w) => eqFold(w, a))))
    )
  }
  if (when.paths !== undefined) {
    verdicts.push(
      known(input.paths, (ps) => {
        const regexes = when.paths!.map(globToRegExp)
        return bool(ps.some((p) => regexes.some((re) => re.test(p))))
      })
    )
  }
  if (when.draft !== undefined) {
    verdicts.push(known(input.draft, (d) => bool(d === when.draft)))
  }
  if (when.mergeable !== undefined) {
    verdicts.push(known(input.mergeable, (s) => bool(s === when.mergeable)))
  }
  for (const key of ['files', 'churn', 'authorMergedPRs'] as const) {
    if (when[key] !== undefined) {
      verdicts.push(compare(when[key]!, input[key], key, opts))
    }
  }
  if (when.any !== undefined) {
    const sub = when.any.map((group) => evaluateConditions(group, input, opts))
    verdicts.push(sub.includes('match') ? 'match' : sub.includes('pending') ? 'pending' : 'no')
  }

  if (verdicts.includes('no')) {
    return 'no'
  }
  return verdicts.includes('pending') ? 'pending' : 'match'
}

/** Chip mode: every rule reports independently. */
export function evaluateWatchRules(
  rules: readonly PRWatchRule[],
  input: PRWatchInput,
  opts: EvaluateOptions = {}
): PRWatchMatch[] {
  const out: PRWatchMatch[] = []
  for (const rule of rules) {
    const verdict = evaluateConditions(rule.when, input, opts)
    if (verdict !== 'no') {
      out.push({ rule: rule.name, note: rule.note, pending: verdict === 'pending' })
    }
  }
  return out
}

/**
 * Tier mode: ordered, first-match-wins, implicit catch-all (tier: null). A pending
 * rule stops the walk with a tentative assignment — absence of data must never let
 * an item fall through to a cheaper tier.
 */
export function classifyReviewQueueTier(
  tiers: readonly PRWatchTierRule[],
  input: PRWatchInput,
  opts: EvaluateOptions = {}
): TierResult {
  for (const tier of tiers) {
    const verdict = evaluateConditions(tier.when, input, opts)
    if (verdict !== 'no') {
      return { tier: tier.name, pending: verdict === 'pending' }
    }
  }
  return { tier: null, pending: false }
}

const RULE_KEYS = new Set(['name', 'when', 'note'])
const TIER_KEYS = new Set(['name', 'when', 'note', 'action', 'slot', 'batchBy'])
// Untrusted YAML keys: Set membership avoids the prototype-chain hits a plain
// object would report as valid (e.g. `constructor`, `toString`).
const CONDITION_KEYS = new Set([
  'scope',
  'type',
  'title',
  'labels',
  'author',
  'branch',
  'paths',
  'draft',
  'mergeable',
  'files',
  'churn',
  'authorMergedPRs',
  'any'
])

function validateConditions(when: unknown, where: string): asserts when is PRWatchConditions {
  if (!when || typeof when !== 'object' || Array.isArray(when)) {
    throw new Error(`${where}: "when" must be an object with at least one condition`)
  }
  const rec = when as Record<string, unknown>
  const keys = Object.keys(rec)
  if (keys.length === 0) {
    throw new Error(`${where}: "when" has no conditions; an empty rule is not match-everything`)
  }
  for (const key of keys) {
    if (!CONDITION_KEYS.has(key)) {
      throw new Error(`${where}: unknown condition "${key}"`)
    }
  }
  for (const key of ['title', 'branch'] as const) {
    const value = rec[key]
    if (value === undefined) {
      continue
    }
    // RegExp coerces: `title: 42` would silently compile as /42/ instead of failing.
    if (typeof value !== 'string') {
      throw new Error(`${where}: "${key}" must be a string`)
    }
    try {
      new RegExp(value)
    } catch {
      throw new Error(`${where}: "${key}" is not a valid regex`)
    }
  }
  for (const key of ['labels', 'author', 'paths'] as const) {
    const v = rec[key]
    if (v !== undefined && !(Array.isArray(v) && v.every((e) => typeof e === 'string'))) {
      throw new Error(`${where}: "${key}" must be an array of strings`)
    }
  }
  for (const key of ['scope', 'type'] as const) {
    const v = rec[key]
    if (
      v !== undefined &&
      typeof v !== 'string' &&
      !(Array.isArray(v) && v.every((e) => typeof e === 'string'))
    ) {
      throw new Error(`${where}: "${key}" must be a string or an array of strings`)
    }
  }
  if (rec.draft !== undefined && typeof rec.draft !== 'boolean') {
    throw new Error(`${where}: "draft" must be true or false`)
  }
  if (
    rec.mergeable !== undefined &&
    rec.mergeable !== 'conflicting' &&
    rec.mergeable !== 'mergeable' &&
    rec.mergeable !== 'unknown'
  ) {
    throw new Error(`${where}: "mergeable" must be conflicting, mergeable, or unknown`)
  }
  for (const key of ['files', 'churn', 'authorMergedPRs'] as const) {
    if (rec[key] !== undefined && !COMPARISON_RE.test(String(rec[key]))) {
      throw new Error(`${where}: "${key}" must be a comparison like ">=19" or ">=p90"`)
    }
  }
  if (rec.any !== undefined) {
    if (!Array.isArray(rec.any) || rec.any.length === 0) {
      throw new Error(`${where}: "any" must be a non-empty array of condition groups`)
    }
    rec.any.forEach((group, i) => validateConditions(group, `${where}.any[${i}]`))
  }
}

function validateRuleList(raw: unknown, allowedKeys: Set<string>, label: string): void {
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array of rules`)
  }
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const rule: unknown = raw[i]
    const where = `${label}[${i}]`
    if (!rule || typeof rule !== 'object' || !('name' in rule) || typeof rule.name !== 'string') {
      throw new Error(`${where}: every rule needs a string "name"`)
    }
    const name = rule.name
    if (seen.has(name)) {
      throw new Error(`${label}: duplicate rule name "${name}"`)
    }
    seen.add(name)
    for (const key of Object.keys(rule)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`${where} ("${name}"): unknown key "${key}"`)
      }
    }
    validateConditions('when' in rule ? rule.when : undefined, `${where} ("${name}")`)
  }
}

export function validateWatchRules(raw: unknown): PRWatchRule[] {
  validateRuleList(raw, RULE_KEYS, 'pr_watch')
  return raw as PRWatchRule[]
}

export function validateTierRules(raw: unknown): PRWatchTierRule[] {
  validateRuleList(raw, TIER_KEYS, 'review_queue.tiers')
  return raw as PRWatchTierRule[]
}
