/**
 * Forge-aware parsing of merge-commit subjects: which PR/MR a merged commit
 * belongs to, and which PR/MR a revert commit undoes. Titles are the one
 * artifact every forge shares, so this is the portability seam for anything
 * that replays PR history from a bare clone (see the backtest harness).
 */

export type MergedPRIdentity = {
  number: number | null
  forge: 'github' | 'gitlab' | 'bitbucket' | null
}

// Order matters: Bitbucket's `(pull request #N)` must win before a bare
// trailing `#N)` could be misread, and explicit references beat body trailers.
const SUBJECT_FORMS: { re: RegExp; forge: MergedPRIdentity['forge'] }[] = [
  { re: /\(!(\d+)\)\s*$/, forge: 'gitlab' },
  { re: /\(pull request #(\d+)\)\s*$/i, forge: 'bitbucket' },
  { re: /\(#(\d+)\)\s*$/, forge: 'github' },
  { re: /^Merge pull request #(\d+)/i, forge: 'github' }
]
const GITLAB_BODY_RE = /See merge request (?:[\w./-]+)?!(\d+)/i
const GITLAB_REVERT_BODY_RE = /This reverts merge request !(\d+)/i

export function identifyMergedPR(subject: string, body?: string): MergedPRIdentity {
  for (const { re, forge } of SUBJECT_FORMS) {
    const m = re.exec(subject)
    if (m) {
      return { number: Number(m[1]), forge }
    }
  }
  const fromBody = body ? GITLAB_BODY_RE.exec(body) : null
  if (fromBody) {
    return { number: Number(fromBody[1]), forge: 'gitlab' }
  }
  return { number: null, forge: null }
}

export type RevertTargets = {
  targets: number[]
  /** The quoted original title, for callers that resolve paraphrased reverts by title match. */
  quotedTitle: string | null
}

export function extractRevertTargets(subject: string, body?: string): RevertTargets {
  if (!/^revert\b/i.test(subject)) {
    return { targets: [], quotedTitle: null }
  }
  const quotedTitle = /"([^"]+)"/.exec(subject)?.[1] ?? null

  // Numbers inside the quotes name the reverted PR; the revert's own trailing
  // number must never count as a target.
  const inQuote = quotedTitle
    ? [...quotedTitle.matchAll(/[#!](\d+)/g)].map((m) => Number(m[1]))
    : []
  if (inQuote.length) {
    return { targets: inQuote, quotedTitle }
  }

  const own = identifyMergedPR(subject).number
  const unquoted = [...subject.matchAll(/[#!](\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n !== own)
  if (unquoted.length) {
    return { targets: unquoted, quotedTitle }
  }

  const fromBody = body ? GITLAB_REVERT_BODY_RE.exec(body) : null
  return { targets: fromBody ? [Number(fromBody[1])] : [], quotedTitle }
}
