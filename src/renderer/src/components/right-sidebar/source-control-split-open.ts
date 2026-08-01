import type { Tab } from '../../../../shared/types'

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
  return (
    tab.contentType === 'editor' ||
    tab.contentType === 'diff' ||
    tab.contentType === 'conflict-review' ||
    tab.contentType === 'check-details'
  )
}

/**
 * Picks the group that already serves as the worktree's diff column: the parked
 * preview's group wins, else a non-active group holding a diff tab. Undefined
 * means the caller should create a fresh side split.
 */
export function findSideSplitDiffTargetGroupId(
  tabs: readonly SideSplitCandidateTab[],
  activeGroupId: string | undefined
): string | undefined {
  const previewTab = tabs.find((tab) => tab.isPreview && isEditorContentTab(tab))
  if (previewTab) {
    return previewTab.groupId
  }
  return tabs.find((tab) => tab.contentType === 'diff' && tab.groupId !== activeGroupId)?.groupId
}
