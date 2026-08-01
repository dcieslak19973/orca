import { describe, expect, it } from 'vitest'
import { findLineChangeForModifiedLine, toDiffHunkRange } from './diff-hunk-line-changes'

const modification = {
  originalStartLineNumber: 5,
  originalEndLineNumber: 6,
  modifiedStartLineNumber: 5,
  modifiedEndLineNumber: 7
}
const insertion = {
  originalStartLineNumber: 10,
  originalEndLineNumber: 0,
  modifiedStartLineNumber: 12,
  modifiedEndLineNumber: 13
}
const deletion = {
  originalStartLineNumber: 20,
  originalEndLineNumber: 21,
  modifiedStartLineNumber: 18,
  modifiedEndLineNumber: 0
}

describe('toDiffHunkRange', () => {
  it('maps modifications, insertions, and deletions onto unified-diff spans', () => {
    expect(toDiffHunkRange(modification)).toEqual({
      oldStart: 5,
      oldCount: 2,
      newStart: 5,
      newCount: 3
    })
    expect(toDiffHunkRange(insertion)).toEqual({
      oldStart: 10,
      oldCount: 0,
      newStart: 12,
      newCount: 2
    })
    expect(toDiffHunkRange(deletion)).toEqual({
      oldStart: 20,
      oldCount: 2,
      newStart: 18,
      newCount: 0
    })
  })
})

describe('findLineChangeForModifiedLine', () => {
  const changes = [modification, insertion, deletion]

  it('matches lines inside a change span', () => {
    expect(findLineChangeForModifiedLine(changes, 5)).toBe(modification)
    expect(findLineChangeForModifiedLine(changes, 7)).toBe(modification)
    expect(findLineChangeForModifiedLine(changes, 13)).toBe(insertion)
  })

  it('anchors deletions on the modified line they follow', () => {
    expect(findLineChangeForModifiedLine(changes, 18)).toBe(deletion)
  })

  it('returns null for unchanged lines', () => {
    expect(findLineChangeForModifiedLine(changes, 8)).toBeNull()
    expect(findLineChangeForModifiedLine(changes, 40)).toBeNull()
  })
})
