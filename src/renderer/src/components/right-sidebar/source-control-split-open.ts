import type { Tab } from '../../../../shared/types'
import { isEditorTabContentType } from '../../../../shared/editor-tab-content-type'

export type SourceControlRowOpenEvent = {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  openAsPermanent?: boolean
}

type SourceControlOpenModifierKeys = Pick<
  SourceControlRowOpenEvent,
  'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>

export function isSourceControlSplitOpenModifier(
  event: SourceControlRowOpenEvent,
  isMac: boolean
): boolean {
  const platformPrimary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return platformPrimary || event.shiftKey || event.altKey
}

export function shouldOpenSourceControlRowAsPreview(
  event: SourceControlRowOpenEvent | undefined,
  targetGroupId: string | undefined
): boolean {
  return !targetGroupId && event?.openAsPermanent !== true
}

export function toSourceControlRowOpenEvent(
  event: SourceControlOpenModifierKeys
): SourceControlRowOpenEvent {
  return {
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey
  }
}

export function toPermanentSourceControlRowOpenEvent(
  event: SourceControlOpenModifierKeys
): SourceControlRowOpenEvent {
  return { ...toSourceControlRowOpenEvent(event), openAsPermanent: true }
}

type SideSplitCandidateTab = Pick<Tab, 'groupId' | 'contentType' | 'isPreview'>

function isEditorContentTab(tab: SideSplitCandidateTab): boolean {
  return isEditorTabContentType(tab.contentType)
}

export type SideSplitDiffColumn = {
  /** Group to open the diff in; undefined tells the caller to create a fresh right split. */
  groupId: string | undefined
  /** Whether the caller must record the resulting group as this worktree's diff column. */
  shouldRecord: boolean
}

export type SideSplitDiffColumnInput = {
  tabs: readonly SideSplitCandidateTab[]
  activeGroupId: string | undefined
  liveGroupIds: readonly string[]
  /** Diff column this worktree already committed to, if any. */
  recordedGroupId: string | undefined
}

/**
 * Resolves the worktree's diff column: the recorded group while it lives, else a one-time
 * inference the caller records so the column stops moving with focus.
 */
export function resolveSideSplitDiffColumn({
  tabs,
  activeGroupId,
  liveGroupIds,
  recordedGroupId
}: SideSplitDiffColumnInput): SideSplitDiffColumn {
  // Why: a live recorded column outranks inference. Inferring per open is what made the setting a
  // no-op — a preview parked in the active group answered "this is the diff column", so no split
  // was ever created. A dead id needs no cleanup; it just fails this check.
  if (recordedGroupId && liveGroupIds.includes(recordedGroupId)) {
    return { groupId: recordedGroupId, shouldRecord: false }
  }
  // Why: any editor-family preview counts, not just a diff — the group is pinned by the caller,
  // which scopes preview replacement, so skipping a parked non-diff preview would orphan it
  // (#11839). Excluding the active group is only safe because the result is recorded: the split
  // created next becomes active, and rule 1 keeps it instead of re-splitting.
  const previewGroupId = tabs.find(
    (tab) => tab.isPreview && isEditorContentTab(tab) && tab.groupId !== activeGroupId
  )?.groupId
  if (previewGroupId) {
    return { groupId: previewGroupId, shouldRecord: true }
  }
  // Why: deliberately narrower than the branch above. With no preview to recycle, the question is
  // "which column already looks like the diff column", and only a diff tab answers that.
  const diffGroupId = tabs.find(
    (tab) => tab.contentType === 'diff' && tab.groupId !== activeGroupId
  )?.groupId
  return { groupId: diffGroupId, shouldRecord: true }
}
