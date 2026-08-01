// @vitest-environment happy-dom
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/types'
import type { OpenFile } from '@/store/slices/editor'

const { storeState, stageHunkMock, unstageHunkMock, refreshMock, toastErrorMock } = vi.hoisted(
  () => ({
    // Why: gitStatusByWorktree stores the entry array directly, not a { entries } envelope.
    // Reproducing that exact shape is the point of this file.
    storeState: {
      settings: { activeRuntimeEnvironmentId: null },
      gitStatusByWorktree: {} as Record<string, GitStatusEntry[]>,
      setGitStatus: vi.fn(),
      updateWorktreeGitIdentity: vi.fn(),
      setUpstreamStatus: vi.fn(),
      fetchUpstreamStatus: vi.fn()
    },
    stageHunkMock: vi.fn(),
    unstageHunkMock: vi.fn(),
    refreshMock: vi.fn(),
    toastErrorMock: vi.fn()
  })
)

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ settingsForRuntimeOwner: (s: unknown) => s }))
vi.mock('@/runtime/runtime-git-client', () => ({
  stageRuntimeGitHunk: (...args: unknown[]) => stageHunkMock(...args),
  unstageRuntimeGitHunk: (...args: unknown[]) => unstageHunkMock(...args)
}))
vi.mock('../right-sidebar/git-status-refresh', () => ({
  refreshGitStatusForWorktree: (...args: unknown[]) => refreshMock(...args)
}))

import { useDiffHunkStagingAction } from './useDiffHunkStagingAction'

const WORKTREE = 'wt-1'
const RANGE = { oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }

function unstagedDiffFile(): OpenFile {
  return {
    id: 'diff-1',
    filePath: '/repo/src/a.ts',
    relativePath: 'src/a.ts',
    worktreeId: WORKTREE,
    language: 'typescript',
    isDirty: false,
    mode: 'diff',
    diffSource: 'unstaged'
  } as OpenFile
}

function entry(area: GitStatusEntry['area']): GitStatusEntry {
  return { path: 'src/a.ts', area, status: 'modified' } as GitStatusEntry
}

describe('useDiffHunkStagingAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.gitStatusByWorktree = { [WORKTREE]: [entry('unstaged')] }
    refreshMock.mockResolvedValue(undefined)
    stageHunkMock.mockResolvedValue(undefined)
  })

  it('offers the action for a tracked file in the tab area', () => {
    const { result } = renderHook(() =>
      useDiffHunkStagingAction(unstagedDiffFile(), [entry('unstaged')], vi.fn())
    )
    expect(result.current?.scope).toBe('unstaged')
  })

  it('withholds the action when the file has no entry in the tab area', () => {
    const { result } = renderHook(() =>
      useDiffHunkStagingAction(unstagedDiffFile(), [entry('staged')], vi.fn())
    )
    expect(result.current).toBeUndefined()
  })

  // Why: this is the regression guard for reading gitStatusByWorktree. Reaching for `.entries`
  // typechecks (Array.prototype.entries) and then throws on `.some()`, which surfaced only as a
  // rejected promise — the hunk staged but the tab never reloaded.
  it('completes the post-apply path without throwing, against the real store shape', async () => {
    const reloadContent = vi.fn()
    const { result } = renderHook(() =>
      useDiffHunkStagingAction(unstagedDiffFile(), [entry('unstaged')], reloadContent)
    )

    // The file leaves the unstaged area once its last hunk is staged.
    refreshMock.mockImplementation(async () => {
      storeState.gitStatusByWorktree = { [WORKTREE]: [entry('staged')] }
    })

    await act(async () => {
      await expect(result.current?.applyHunk(RANGE)).resolves.toBeUndefined()
    })

    expect(stageHunkMock).toHaveBeenCalledWith(expect.anything(), 'src/a.ts', RANGE)
    expect(reloadContent).toHaveBeenCalledTimes(1)
  })

  it('forces a reload when the status refresh fails', async () => {
    const reloadContent = vi.fn()
    const { result } = renderHook(() =>
      useDiffHunkStagingAction(unstagedDiffFile(), [entry('unstaged')], reloadContent)
    )
    refreshMock.mockRejectedValue(new Error('offline'))

    await act(async () => {
      await result.current?.applyHunk(RANGE)
    })

    // Stale entries still show the file as unstaged, which would otherwise suppress the reload.
    expect(reloadContent).toHaveBeenCalledTimes(1)
  })

  it('reports a failed apply and does not reload', async () => {
    const reloadContent = vi.fn()
    const { result } = renderHook(() =>
      useDiffHunkStagingAction(unstagedDiffFile(), [entry('unstaged')], reloadContent)
    )
    stageHunkMock.mockRejectedValue(new Error('stale hunk'))

    await act(async () => {
      await result.current?.applyHunk(RANGE)
    })

    expect(toastErrorMock).toHaveBeenCalledWith('stale hunk')
    expect(reloadContent).not.toHaveBeenCalled()
  })
})
