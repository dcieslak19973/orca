/**
 * Parse and re-slice single-file unified diffs so one hunk can be staged or
 * unstaged via `git apply --cached`. Hunks are kept verbatim (header + body,
 * including "\ No newline at end of file" markers) so the applied patch is
 * exactly what `git diff -U0` produced — no re-synthesis, no EOL guessing.
 */

export type ParsedDiffHunk = {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Body lines, verbatim, including trailing "\ No newline at end of file" markers. */
  lines: string[]
}

export type ParsedFilePatch = {
  /** Lines from "diff --git" through "+++", reused verbatim when rebuilding. */
  headerLines: string[]
  hunks: ParsedDiffHunk[]
  isRename: boolean
  isBinary: boolean
}

/** Old/new line span of one diff change; count 0 marks a pure insertion/deletion point. */
export type DiffHunkRange = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

export const GIT_HUNK_STALE_MESSAGE =
  'The selected hunk no longer matches this file. Refresh the diff and try again.'
export const GIT_HUNK_RENAME_UNSUPPORTED_MESSAGE =
  'Hunk staging is not available for renamed files. Stage the whole file instead.'
export const GIT_HUNK_BINARY_UNSUPPORTED_MESSAGE = 'Hunk staging is not available for binary files.'

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseSingleFileUnifiedDiff(patchText: string): ParsedFilePatch | null {
  const rawLines = patchText.split('\n')
  if (rawLines.at(-1) === '') {
    rawLines.pop()
  }
  if (rawLines.length === 0) {
    return null
  }
  const fileHeaderCount = rawLines.filter((line) => line.startsWith('diff --git ')).length
  if (fileHeaderCount > 1) {
    return null
  }

  const headerLines: string[] = []
  const hunks: ParsedDiffHunk[] = []
  let isRename = false
  let isBinary = false
  let current: ParsedDiffHunk | null = null

  for (const line of rawLines) {
    const hunkMatch = HUNK_HEADER_PATTERN.exec(line)
    if (hunkMatch) {
      current = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: []
      }
      hunks.push(current)
      continue
    }
    if (current) {
      current.lines.push(line)
      continue
    }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      isRename = true
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      isBinary = true
    }
    headerLines.push(line)
  }

  return { headerLines, hunks, isRename, isBinary }
}

// Why: a zero-count span is the point between start and start+1; the half-line
// offset makes insertion points intersect only the hunk they belong to.
function spanBounds(start: number, count: number): { from: number; to: number } {
  return count === 0
    ? { from: start + 0.5, to: start + 0.5 }
    : { from: start, to: start + count - 1 }
}

function spansIntersect(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from <= b.to && b.from <= a.to
}

/** Hunks whose old- or new-side span intersects the requested range. */
export function selectHunksForRange(
  hunks: readonly ParsedDiffHunk[],
  range: DiffHunkRange
): ParsedDiffHunk[] {
  const oldRange = spanBounds(range.oldStart, range.oldCount)
  const newRange = spanBounds(range.newStart, range.newCount)
  return hunks.filter(
    (hunk) =>
      spansIntersect(spanBounds(hunk.oldStart, hunk.oldCount), oldRange) ||
      spansIntersect(spanBounds(hunk.newStart, hunk.newCount), newRange)
  )
}

/** Rebuild an applicable patch from the file header plus a subset of its hunks, verbatim. */
export function buildPatchForHunks(
  patch: ParsedFilePatch,
  hunks: readonly ParsedDiffHunk[]
): string {
  const lines = [...patch.headerLines]
  for (const hunk of hunks) {
    lines.push(hunk.header, ...hunk.lines)
  }
  return `${lines.join('\n')}\n`
}
