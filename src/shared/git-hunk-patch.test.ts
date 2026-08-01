import { describe, expect, it } from 'vitest'
import {
  buildPatchForHunks,
  parseSingleFileUnifiedDiff,
  selectHunksForRange
} from './git-hunk-patch'

const MULTI_HUNK_PATCH = [
  'diff --git a/src/example.ts b/src/example.ts',
  'index 1111111..2222222 100644',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -2,1 +2,1 @@ function one() {',
  '-  return 1',
  '+  return 100',
  '@@ -7,0 +8,2 @@ function two() {',
  '+  // inserted',
  '+  console.log("two")',
  '@@ -12,2 +14,0 @@ function three() {',
  '-  // removed',
  '-  console.log("three")',
  ''
].join('\n')

describe('parseSingleFileUnifiedDiff', () => {
  it('parses header lines and hunks with old/new spans', () => {
    const parsed = parseSingleFileUnifiedDiff(MULTI_HUNK_PATCH)
    expect(parsed).not.toBeNull()
    expect(parsed?.headerLines).toEqual([
      'diff --git a/src/example.ts b/src/example.ts',
      'index 1111111..2222222 100644',
      '--- a/src/example.ts',
      '+++ b/src/example.ts'
    ])
    expect(parsed?.hunks).toHaveLength(3)
    expect(parsed?.hunks[0]).toMatchObject({ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 })
    expect(parsed?.hunks[1]).toMatchObject({ oldStart: 7, oldCount: 0, newStart: 8, newCount: 2 })
    expect(parsed?.hunks[2]).toMatchObject({ oldStart: 12, oldCount: 2, newStart: 14, newCount: 0 })
    expect(parsed?.isRename).toBe(false)
    expect(parsed?.isBinary).toBe(false)
  })

  it('defaults omitted counts to 1 and keeps no-newline markers in the hunk body', () => {
    const parsed = parseSingleFileUnifiedDiff(
      [
        '--- a/note.txt',
        '+++ b/note.txt',
        '@@ -1 +1 @@',
        '-old',
        '\\ No newline at end of file',
        '+new',
        '\\ No newline at end of file',
        ''
      ].join('\n')
    )
    expect(parsed?.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 })
    expect(parsed?.hunks[0].lines).toEqual([
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file'
    ])
  })

  it('flags renames and binary patches and rejects multi-file patches', () => {
    const rename = parseSingleFileUnifiedDiff(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 95%',
        'rename from old.ts',
        'rename to new.ts',
        ''
      ].join('\n')
    )
    expect(rename?.isRename).toBe(true)

    const binary = parseSingleFileUnifiedDiff(
      ['diff --git a/img.png b/img.png', 'Binary files a/img.png and b/img.png differ', ''].join(
        '\n'
      )
    )
    expect(binary?.isBinary).toBe(true)

    const multi = parseSingleFileUnifiedDiff(
      ['diff --git a/a.ts b/a.ts', 'diff --git a/b.ts b/b.ts', ''].join('\n')
    )
    expect(multi).toBeNull()
  })
})

describe('selectHunksForRange', () => {
  const hunks = parseSingleFileUnifiedDiff(MULTI_HUNK_PATCH)?.hunks ?? []

  it('selects the modification hunk covering the requested lines', () => {
    const selected = selectHunksForRange(hunks, {
      oldStart: 2,
      oldCount: 1,
      newStart: 2,
      newCount: 1
    })
    expect(selected).toHaveLength(1)
    expect(selected[0].oldStart).toBe(2)
  })

  it('matches pure insertions by their insertion point without spilling into neighbors', () => {
    const selected = selectHunksForRange(hunks, {
      oldStart: 7,
      oldCount: 0,
      newStart: 8,
      newCount: 2
    })
    expect(selected).toHaveLength(1)
    expect(selected[0].newStart).toBe(8)
  })

  it('matches pure deletions and returns empty when nothing intersects', () => {
    expect(
      selectHunksForRange(hunks, { oldStart: 12, oldCount: 2, newStart: 14, newCount: 0 })
    ).toHaveLength(1)
    expect(
      selectHunksForRange(hunks, { oldStart: 40, oldCount: 3, newStart: 40, newCount: 3 })
    ).toHaveLength(0)
  })
})

describe('buildPatchForHunks', () => {
  it('preserves hunk order when rebuilding from several selected hunks', () => {
    const parsed = parseSingleFileUnifiedDiff(MULTI_HUNK_PATCH)
    if (!parsed) {
      throw new Error('expected parsed patch')
    }
    // Why: git apply consumes this output directly, and it rejects hunks that are not in
    // ascending order — so the reconstruction must not reorder what selection returned.
    const rebuilt = buildPatchForHunks(parsed, [parsed.hunks[0], parsed.hunks[2]])
    expect(rebuilt.split('\n').filter((line) => line.startsWith('@@'))).toEqual([
      '@@ -2,1 +2,1 @@ function one() {',
      '@@ -12,2 +14,0 @@ function three() {'
    ])
    expect(rebuilt).toContain('-  return 1')
    expect(rebuilt).toContain('+  return 100')
    expect(rebuilt).toContain('-  console.log("three")')
    expect(rebuilt).not.toContain('// inserted')
  })

  it('rebuilds a verbatim patch from the header and the selected hunk', () => {
    const parsed = parseSingleFileUnifiedDiff(MULTI_HUNK_PATCH)
    if (!parsed) {
      throw new Error('expected parsed patch')
    }
    const rebuilt = buildPatchForHunks(parsed, [parsed.hunks[1]])
    expect(rebuilt).toBe(
      [
        'diff --git a/src/example.ts b/src/example.ts',
        'index 1111111..2222222 100644',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -7,0 +8,2 @@ function two() {',
        '+  // inserted',
        '+  console.log("two")',
        ''
      ].join('\n')
    )
  })
})
