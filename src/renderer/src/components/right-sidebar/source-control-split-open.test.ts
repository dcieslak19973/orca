import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/types'
import {
  findSideSplitDiffTargetGroupId,
  isSourceControlSplitOpenModifier,
  shouldOpenSourceControlRowAsPreview,
  toPermanentSourceControlRowOpenEvent,
  type SourceControlRowOpenEvent
} from './source-control-split-open'

function event(overrides: Partial<SourceControlRowOpenEvent> = {}): SourceControlRowOpenEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('isSourceControlSplitOpenModifier', () => {
  it('uses Cmd on macOS and Ctrl elsewhere as the platform primary modifier', () => {
    expect(isSourceControlSplitOpenModifier(event({ metaKey: true }), true)).toBe(true)
    expect(isSourceControlSplitOpenModifier(event({ ctrlKey: true }), true)).toBe(false)

    expect(isSourceControlSplitOpenModifier(event({ ctrlKey: true }), false)).toBe(true)
    expect(isSourceControlSplitOpenModifier(event({ metaKey: true }), false)).toBe(false)
  })

  it('treats Shift and Alt/Option as split-open modifiers', () => {
    expect(isSourceControlSplitOpenModifier(event({ shiftKey: true }), true)).toBe(true)
    expect(isSourceControlSplitOpenModifier(event({ altKey: true }), false)).toBe(true)
  })

  it('ignores a plain click', () => {
    expect(isSourceControlSplitOpenModifier(event(), true)).toBe(false)
    expect(isSourceControlSplitOpenModifier(event(), false)).toBe(false)
  })
})

describe('shouldOpenSourceControlRowAsPreview', () => {
  it('uses preview for plain row opens in the current group', () => {
    expect(shouldOpenSourceControlRowAsPreview(event(), undefined)).toBe(true)
  })

  it('does not preview when opening into a split group', () => {
    expect(shouldOpenSourceControlRowAsPreview(event(), 'group-2')).toBe(false)
  })

  it('does not preview when the row requests a permanent open', () => {
    expect(shouldOpenSourceControlRowAsPreview(event({ openAsPermanent: true }), undefined)).toBe(
      false
    )
  })
})

function tab(
  groupId: string,
  contentType: Tab['contentType'],
  isPreview?: boolean
): Pick<Tab, 'groupId' | 'contentType' | 'isPreview'> {
  return { groupId, contentType, isPreview }
}

describe('findSideSplitDiffTargetGroupId', () => {
  it('targets the parked preview tab group first, wherever it lives', () => {
    const tabs = [tab('group-a', 'terminal'), tab('group-a', 'diff'), tab('group-b', 'diff', true)]
    expect(findSideSplitDiffTargetGroupId(tabs, 'group-a')).toBe('group-b')
  })

  it('keeps recycling a preview that lives in the active group', () => {
    const tabs = [tab('group-a', 'editor', true)]
    expect(findSideSplitDiffTargetGroupId(tabs, 'group-a')).toBe('group-a')
  })

  it('falls back to a non-active group already holding diff tabs', () => {
    const tabs = [tab('group-a', 'terminal'), tab('group-b', 'diff')]
    expect(findSideSplitDiffTargetGroupId(tabs, 'group-a')).toBe('group-b')
  })

  it('ignores diff tabs in the active group and terminal previews', () => {
    const tabs = [tab('group-a', 'diff'), tab('group-b', 'terminal', true)]
    expect(findSideSplitDiffTargetGroupId(tabs, 'group-a')).toBeUndefined()
  })

  it('returns undefined for a fresh worktree so the caller creates a split', () => {
    expect(findSideSplitDiffTargetGroupId([], 'group-a')).toBeUndefined()
  })
})

describe('toPermanentSourceControlRowOpenEvent', () => {
  it('preserves modifier keys and marks the row open as permanent', () => {
    expect(
      toPermanentSourceControlRowOpenEvent(
        event({
          altKey: true,
          metaKey: true
        })
      )
    ).toEqual({
      altKey: true,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      openAsPermanent: true
    })
  })
})
