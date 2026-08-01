import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { stageRuntimeGitHunk, unstageRuntimeGitHunk } from '@/runtime/runtime-git-client'
import { translate } from '@/i18n/i18n'
import type { DiffHunkRange } from '../../../../shared/git-hunk-patch'
import type { GitStatusEntry } from '../../../../shared/types'
import type { OpenFile } from '@/store/slices/editor'
import { refreshGitStatusForWorktree } from '../right-sidebar/git-status-refresh'
import { shouldReloadDiffOnGitStatusChange } from './editor-panel-diff-reload'
import type { DiffHunkStagingConfig } from './useDiffHunkStaging'

/**
 * Per-hunk stage/unstage action for the active diff tab, or undefined when the
 * tab isn't an unstaged/staged diff with a matching tracked status row.
 */
export function useDiffHunkStagingAction(
  activeFile: OpenFile,
  worktreeEntries: readonly GitStatusEntry[],
  reloadContent: (file: OpenFile) => void
): DiffHunkStagingConfig | undefined {
  const scope =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'unstaged' || activeFile.diffSource === 'staged')
      ? activeFile.diffSource
      : null
  // Why: untracked files have no index entry for `git apply --cached` to patch;
  // whole-file staging already covers them.
  const hasTrackedAreaEntry =
    scope !== null &&
    worktreeEntries.some((entry) => entry.path === activeFile.relativePath && entry.area === scope)

  const applyHunk = useCallback(
    async (range: DiffHunkRange): Promise<void> => {
      if (!scope) {
        return
      }
      const worktreePath = activeFile.filePath.slice(
        0,
        activeFile.filePath.length - activeFile.relativePath.length - 1
      )
      const connectionId = getConnectionIdForFile(activeFile.worktreeId, activeFile.filePath)
      const settings = settingsForRuntimeOwner(
        useAppStore.getState().settings,
        activeFile.runtimeEnvironmentId
      )
      const context = {
        settings,
        worktreeId: activeFile.worktreeId,
        worktreePath,
        connectionId: connectionId ?? undefined
      }
      try {
        await (scope === 'staged'
          ? unstageRuntimeGitHunk(context, activeFile.relativePath, range)
          : stageRuntimeGitHunk(context, activeFile.relativePath, range))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
        return
      }
      const state = useAppStore.getState()
      try {
        await refreshGitStatusForWorktree({
          settings,
          worktreeId: activeFile.worktreeId,
          worktreePath,
          connectionId: connectionId ?? undefined,
          deps: {
            setGitStatus: state.setGitStatus,
            updateWorktreeGitIdentity: state.updateWorktreeGitIdentity,
            setUpstreamStatus: state.setUpstreamStatus,
            fetchUpstreamStatus: state.fetchUpstreamStatus
          }
        })
      } catch (err) {
        // Why: polling reconciles status soon anyway; the hunk itself already applied.
        console.warn('[diff-hunk] git status refresh after hunk apply failed', err)
      }
      // Why: the status-change auto-reload skips tabs whose row left their area,
      // but staging the last hunk must still visibly empty this diff.
      const entries = useAppStore.getState().gitStatusByWorktree[activeFile.worktreeId]?.entries
      if (!shouldReloadDiffOnGitStatusChange(activeFile, entries)) {
        reloadContent(activeFile)
      }
    },
    [activeFile, reloadContent, scope]
  )

  return useMemo(() => {
    if (!scope || !hasTrackedAreaEntry) {
      return undefined
    }
    return {
      scope,
      actionLabel:
        scope === 'staged'
          ? translate('auto.components.editor.EditorContent.unstageHunk', 'Unstage hunk')
          : translate('auto.components.editor.EditorContent.stageHunk', 'Stage hunk'),
      applyHunk
    }
  }, [applyHunk, hasTrackedAreaEntry, scope])
}
