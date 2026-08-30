import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import { bulkPathspecCommands, literalPathspec } from './git-pathspec'
import {
  GIT_HUNK_BINARY_UNSUPPORTED_MESSAGE,
  GIT_HUNK_RENAME_UNSUPPORTED_MESSAGE,
  GIT_HUNK_STALE_MESSAGE,
  buildPatchForHunks,
  parseSingleFileUnifiedDiff,
  selectHunksForRange,
  type DiffHunkRange
} from '../../../shared/git-hunk-patch'
import { KeyedMutationQueue } from '../../../shared/keyed-mutation-queue'

/**
 * Stage a file.
 */
export async function stageFile(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  try {
    await gitExecFileAsync(
      ['add', '--', literalPathspec(filePath, options)],
      gitOptionsForWorktree(worktreePath, options)
    )
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Unstage a file.
 */
export async function unstageFile(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  try {
    await gitExecFileAsync(['restore', '--staged', '--', literalPathspec(filePath, options)], {
      ...gitOptionsForWorktree(worktreePath, options)
    })
  } finally {
    invalidateGitReadCaches()
  }
}

// Why: the applied patch is git's own -U0 output for the matched hunks, verbatim —
// re-synthesizing hunks would have to re-solve EOL and no-newline-at-EOF edge cases.
async function applyHunkRangeToIndex(
  worktreePath: string,
  filePath: string,
  range: DiffHunkRange,
  reverse: boolean,
  options: GitRuntimeOptions
): Promise<void> {
  const diffResult = await gitExecFileAsync(
    [
      'diff',
      ...(reverse ? ['--cached'] : []),
      '-U0',
      '--no-color',
      '--no-ext-diff',
      '--',
      literalPathspec(filePath, options)
    ],
    gitOptionsForWorktree(worktreePath, options)
  )
  const parsed = parseSingleFileUnifiedDiff(diffResult.stdout)
  if (!parsed || parsed.hunks.length === 0) {
    throw new Error(GIT_HUNK_STALE_MESSAGE)
  }
  if (parsed.isRename) {
    throw new Error(GIT_HUNK_RENAME_UNSUPPORTED_MESSAGE)
  }
  if (parsed.isBinary) {
    throw new Error(GIT_HUNK_BINARY_UNSUPPORTED_MESSAGE)
  }
  const selected = selectHunksForRange(parsed.hunks, range)
  if (selected.length === 0) {
    throw new Error(GIT_HUNK_STALE_MESSAGE)
  }
  await gitExecFileAsync(
    ['apply', '--cached', '--unidiff-zero', ...(reverse ? ['--reverse'] : []), '-'],
    {
      ...gitOptionsForWorktree(worktreePath, options),
      stdin: buildPatchForHunks(parsed, selected)
    }
  )
}

// Why: applying a hunk is read-diff-then-apply. Two overlapping requests for the same file would
// let the second build its patch from a pre-apply diff and then apply it at line numbers the first
// already invalidated — and `--unidiff-zero` has no context for git to reject that on. Serialize
// per worktree+file; different files still apply concurrently.
const hunkApplyQueue = new KeyedMutationQueue()

function hunkApplyKey(worktreePath: string, filePath: string): string {
  return `${worktreePath}${filePath}`
}

/**
 * Stage a single hunk of a file's unstaged diff.
 */
export async function stageHunk(
  worktreePath: string,
  filePath: string,
  range: DiffHunkRange,
  options: GitRuntimeOptions = {}
): Promise<void> {
  return hunkApplyQueue.run(hunkApplyKey(worktreePath, filePath), async () => {
    invalidateGitReadCaches()
    try {
      await applyHunkRangeToIndex(worktreePath, filePath, range, false, options)
    } finally {
      invalidateGitReadCaches()
    }
  })
}

/**
 * Unstage a single hunk of a file's staged diff.
 */
export async function unstageHunk(
  worktreePath: string,
  filePath: string,
  range: DiffHunkRange,
  options: GitRuntimeOptions = {}
): Promise<void> {
  return hunkApplyQueue.run(hunkApplyKey(worktreePath, filePath), async () => {
    invalidateGitReadCaches()
    try {
      await applyHunkRangeToIndex(worktreePath, filePath, range, true, options)
    } finally {
      invalidateGitReadCaches()
    }
  })
}

/**
 * Bulk stage files in batches to avoid E2BIG.
 */
export async function bulkStageFiles(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }
  try {
    for (const args of bulkPathspecCommands(['add', '--'], filePaths, worktreePath, options)) {
      await gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
    }
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Bulk unstage files in batches to avoid E2BIG.
 */
export async function bulkUnstageFiles(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }
  try {
    const commands = bulkPathspecCommands(
      ['restore', '--staged', '--'],
      filePaths,
      worktreePath,
      options
    )
    for (const args of commands) {
      await gitExecFileAsync(args, { ...gitOptionsForWorktree(worktreePath, options) })
    }
  } finally {
    invalidateGitReadCaches()
  }
}
