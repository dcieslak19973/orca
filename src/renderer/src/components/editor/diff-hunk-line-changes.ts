import type { DiffHunkRange } from '../../../../shared/git-hunk-patch'

/** Structural subset of Monaco's ILineChange; end 0 marks a pure insertion/deletion. */
export type DiffLineChange = {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

// Why: Monaco's "end 0" convention maps 1:1 onto unified-diff zero-count spans
// (`@@ -N,0 +M,K @@`), so no other translation is needed.
export function toDiffHunkRange(change: DiffLineChange): DiffHunkRange {
  return {
    oldStart: change.originalStartLineNumber,
    oldCount:
      change.originalEndLineNumber === 0
        ? 0
        : change.originalEndLineNumber - change.originalStartLineNumber + 1,
    newStart: change.modifiedStartLineNumber,
    newCount:
      change.modifiedEndLineNumber === 0
        ? 0
        : change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
  }
}

/** The change covering a modified-pane line; deletions anchor on the line they follow. */
export function findLineChangeForModifiedLine(
  changes: readonly DiffLineChange[],
  lineNumber: number
): DiffLineChange | null {
  for (const change of changes) {
    if (change.modifiedEndLineNumber === 0) {
      if (lineNumber === change.modifiedStartLineNumber) {
        return change
      }
      continue
    }
    if (
      lineNumber >= change.modifiedStartLineNumber &&
      lineNumber <= change.modifiedEndLineNumber
    ) {
      return change
    }
  }
  return null
}
