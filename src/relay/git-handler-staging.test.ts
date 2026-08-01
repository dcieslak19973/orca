/**
 * Tests for GitHandler commit and staging operations.
 *
 * Why: split from git-handler.test.ts to stay under the oxlint max-lines (300) limit.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import {
  createMockDispatcher,
  gitInit,
  gitCommit,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'
import { normalizeGitFileText } from './git-handler-test-harness'

const PATHSPEC_SELECTED_FILE = '[k]eep.log'
const PATHSPEC_MATCHING_FILE = 'keep.log'
const PATHSPEC_MUTATION_CASES = [
  {
    mode: 'single-file',
    stageMethod: 'git.stage',
    unstageMethod: 'git.unstage',
    selection: { filePath: PATHSPEC_SELECTED_FILE }
  },
  {
    mode: 'bulk',
    stageMethod: 'git.bulkStage',
    unstageMethod: 'git.bulkUnstage',
    selection: { filePaths: [PATHSPEC_SELECTED_FILE] }
  }
] as const

function createPathspecCollisionChanges(dir: string): void {
  gitInit(dir)
  writeFileSync(path.join(dir, PATHSPEC_SELECTED_FILE), 'selected')
  writeFileSync(path.join(dir, PATHSPEC_MATCHING_FILE), 'matching')
  gitCommit(dir, 'initial')
  writeFileSync(path.join(dir, PATHSPEC_SELECTED_FILE), 'selected modified')
  writeFileSync(path.join(dir, PATHSPEC_MATCHING_FILE), 'matching modified')
}

describe('GitHandler — commit & staging', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-staging-'))
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    // eslint-disable-next-line no-new
    new GitHandler(dispatcher as unknown as RelayDispatcher, ctx)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('commit', () => {
    it('commits staged changes and returns success', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'file.txt'), 'content')
      gitCommit(tmpDir, 'initial')
      writeFileSync(path.join(tmpDir, 'file.txt'), 'changed')
      execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir, stdio: 'pipe' })

      const result = (await dispatcher.callRequest('git.commit', {
        worktreePath: tmpDir,
        message: 'feat: relay commit'
      })) as { success: boolean; error?: string }

      expect(result).toEqual({ success: true })
      const latestMessage = execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      }).trim()
      expect(latestMessage).toBe('feat: relay commit')
    })

    // Why: covers the error-extraction path in commitChangesRelay
    // (git-handler-worktree-ops.ts). Running `git commit` with nothing staged
    // exits non-zero and writes a "nothing to commit" message; we assert the
    // relay surfaces a non-empty error string so the UI can display it.
    it('returns a non-empty error when the commit fails', async () => {
      gitInit(tmpDir)

      const result = (await dispatcher.callRequest('git.commit', {
        worktreePath: tmpDir,
        message: 'no changes'
      })) as { success: boolean; error?: string }

      expect(result.success).toBe(false)
      expect(typeof result.error).toBe('string')
      expect((result.error ?? '').length).toBeGreaterThan(0)
      // Why: exact phrasing can vary across git versions, so match the
      // stable substring "nothing" rather than the full "nothing to commit".
      expect((result.error ?? '').toLowerCase()).toContain('nothing')
    })
  })

  describe('stage and unstage', () => {
    it.each(PATHSPEC_MUTATION_CASES)(
      'treats $mode stage paths with Git glob characters as literals',
      async ({ stageMethod, selection }) => {
        createPathspecCollisionChanges(tmpDir)

        await dispatcher.callRequest(stageMethod, { worktreePath: tmpDir, ...selection })

        const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        })
        expect(output.trim()).toBe(PATHSPEC_SELECTED_FILE)
      }
    )

    it.each(PATHSPEC_MUTATION_CASES)(
      'treats $mode unstage paths with Git glob characters as literals',
      async ({ unstageMethod, selection }) => {
        createPathspecCollisionChanges(tmpDir)
        execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' })

        await dispatcher.callRequest(unstageMethod, { worktreePath: tmpDir, ...selection })

        const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: tmpDir,
          encoding: 'utf-8'
        })
        expect(output.trim()).toBe(PATHSPEC_MATCHING_FILE)
      }
    )

    it('stages multiple files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'b')
      gitCommit(tmpDir, 'initial')

      writeFileSync(path.join(tmpDir, 'a.txt'), 'a-modified')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'b-modified')

      await dispatcher.callRequest('git.bulkStage', {
        worktreePath: tmpDir,
        filePaths: ['a.txt', 'b.txt']
      })

      const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      })
      expect(output).toContain('a.txt')
      expect(output).toContain('b.txt')
    })

    it('unstages multiple files', async () => {
      gitInit(tmpDir)
      writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'b')
      gitCommit(tmpDir, 'initial')

      writeFileSync(path.join(tmpDir, 'a.txt'), 'changed')
      writeFileSync(path.join(tmpDir, 'b.txt'), 'changed')
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' })

      await dispatcher.callRequest('git.bulkUnstage', {
        worktreePath: tmpDir,
        filePaths: ['a.txt', 'b.txt']
      })

      const output = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: tmpDir,
        encoding: 'utf-8'
      })
      expect(output.trim()).toBe('')
    })
  })

  describe('stage and unstage hunks', () => {
    const numberedLines = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `line${String(i + 1).padStart(2, '0')}`)

    function writeLines(filePath: string, lines: string[], trailingNewline = true): void {
      writeFileSync(filePath, lines.join('\n') + (trailingNewline ? '\n' : ''))
    }

    function indexContent(cwd: string, filePath: string): string {
      return normalizeGitFileText(
        execFileSync('git', ['show', `:${filePath}`], { cwd, encoding: 'utf-8' })
      )
    }

    it('stages only the hunk matching the requested range', async () => {
      gitInit(tmpDir)
      const filePath = path.join(tmpDir, 'code.txt')
      const lines = numberedLines(30)
      writeLines(filePath, lines)
      gitCommit(tmpDir, 'initial')
      const modified = [...lines]
      modified[4] = 'changed05'
      modified[19] = 'changed20'
      writeLines(filePath, modified)

      await dispatcher.callRequest('git.stageHunk', {
        worktreePath: tmpDir,
        filePath: 'code.txt',
        range: { oldStart: 20, oldCount: 1, newStart: 20, newCount: 1 }
      })

      const staged = [...lines]
      staged[19] = 'changed20'
      expect(indexContent(tmpDir, 'code.txt')).toBe(`${staged.join('\n')}\n`)
      const unstagedDiff = execFileSync('git', ['diff'], { cwd: tmpDir, encoding: 'utf-8' })
      expect(unstagedDiff).toContain('changed05')
      expect(unstagedDiff).not.toContain('changed20')
    })

    it('unstages only the hunk matching the requested range', async () => {
      gitInit(tmpDir)
      const filePath = path.join(tmpDir, 'code.txt')
      const lines = numberedLines(30)
      writeLines(filePath, lines)
      gitCommit(tmpDir, 'initial')
      const modified = [...lines]
      modified[4] = 'changed05'
      modified[19] = 'changed20'
      writeLines(filePath, modified)
      execFileSync('git', ['add', 'code.txt'], { cwd: tmpDir, stdio: 'pipe' })

      await dispatcher.callRequest('git.unstageHunk', {
        worktreePath: tmpDir,
        filePath: 'code.txt',
        range: { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }
      })

      const staged = [...lines]
      staged[19] = 'changed20'
      expect(indexContent(tmpDir, 'code.txt')).toBe(`${staged.join('\n')}\n`)
      const unstagedDiff = execFileSync('git', ['diff'], { cwd: tmpDir, encoding: 'utf-8' })
      expect(unstagedDiff).toContain('changed05')
    })

    it('stages an insertion hunk and an EOF hunk of a file without trailing newline', async () => {
      gitInit(tmpDir)
      const filePath = path.join(tmpDir, 'code.txt')
      const lines = numberedLines(10)
      writeLines(filePath, lines, false)
      gitCommit(tmpDir, 'initial')
      const modified = [...lines]
      modified[9] = 'changedEnd'
      modified.splice(3, 0, 'insertedA', 'insertedB')
      writeLines(filePath, modified, false)

      // Insertion after old line 3 -> new lines 4-5.
      await dispatcher.callRequest('git.stageHunk', {
        worktreePath: tmpDir,
        filePath: 'code.txt',
        range: { oldStart: 3, oldCount: 0, newStart: 4, newCount: 2 }
      })
      const afterInsert = [...lines]
      afterInsert.splice(3, 0, 'insertedA', 'insertedB')
      expect(indexContent(tmpDir, 'code.txt')).toBe(afterInsert.join('\n'))

      // EOF modification on a file with no trailing newline (old line 10, new line 12).
      await dispatcher.callRequest('git.stageHunk', {
        worktreePath: tmpDir,
        filePath: 'code.txt',
        range: { oldStart: 10, oldCount: 1, newStart: 12, newCount: 1 }
      })
      expect(indexContent(tmpDir, 'code.txt')).toBe(modified.join('\n'))
      const unstagedDiff = execFileSync('git', ['diff'], { cwd: tmpDir, encoding: 'utf-8' })
      expect(unstagedDiff.trim()).toBe('')
    })

    it('rejects a range that no longer matches any hunk', async () => {
      gitInit(tmpDir)
      const filePath = path.join(tmpDir, 'code.txt')
      writeLines(filePath, numberedLines(5))
      gitCommit(tmpDir, 'initial')
      const modified = numberedLines(5)
      modified[0] = 'changed01'
      writeLines(filePath, modified)

      await expect(
        dispatcher.callRequest('git.stageHunk', {
          worktreePath: tmpDir,
          filePath: 'code.txt',
          range: { oldStart: 40, oldCount: 1, newStart: 40, newCount: 1 }
        })
      ).rejects.toThrow(/no longer matches/)
    })

    it('applies concurrent same-file stage requests without corrupting the index', async () => {
      gitInit(tmpDir)
      const filePath = path.join(tmpDir, 'code.txt')
      const lines = numberedLines(30)
      writeLines(filePath, lines)
      gitCommit(tmpDir, 'initial')
      // Why: two pure insertions, the shape most exposed to a stale apply — a modification hunk
      // self-corrects because git apply offset-searches for its `-` line. This asserts the end
      // state of overlapping requests; it does not by itself prove the serialization, since git
      // apply also recovers here on its own. KeyedMutationQueue carries the ordering contract.
      const modified = [...lines]
      modified.splice(25, 0, 'insertedC', 'insertedD')
      modified.splice(3, 0, 'insertedA', 'insertedB')
      writeLines(filePath, modified)

      await Promise.all([
        dispatcher.callRequest('git.stageHunk', {
          worktreePath: tmpDir,
          filePath: 'code.txt',
          range: { oldStart: 3, oldCount: 0, newStart: 4, newCount: 2 }
        }),
        dispatcher.callRequest('git.stageHunk', {
          worktreePath: tmpDir,
          filePath: 'code.txt',
          range: { oldStart: 25, oldCount: 0, newStart: 28, newCount: 2 }
        })
      ])

      expect(indexContent(tmpDir, 'code.txt')).toBe(`${modified.join('\n')}\n`)
      const unstagedDiff = execFileSync('git', ['diff'], { cwd: tmpDir, encoding: 'utf-8' })
      expect(unstagedDiff.trim()).toBe('')
    })
  })
})
