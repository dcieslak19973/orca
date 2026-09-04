import { describe, expect, it } from 'vitest'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { resolveLinkTargetGroupId, resolveLinkTargetGroupPlan } from './link-target-group'

const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const split = (first: TabGroupLayoutNode, second: TabGroupLayoutNode): TabGroupLayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  first,
  second,
  ratio: 0.5
})

const base = {
  enabled: true,
  workspaceId: 'ws-1',
  tabs: [{ entityId: 'ws-1', groupId: 'left' }],
  activeGroupId: 'left',
  firstGroupId: 'left',
  layout: split(leaf('left'), leaf('right'))
}

describe('resolveLinkTargetGroupPlan', () => {
  it('keeps default tab behavior when the setting is off', () => {
    expect(resolveLinkTargetGroupPlan({ ...base, enabled: false })).toEqual({
      kind: 'active-group'
    })
  })

  it('targets the sibling pane of the clicked page, not the active pane', () => {
    // Click originates in 'left' while 'right' is focused: still goes to the
    // clicked page's sibling, which is 'right'.
    expect(resolveLinkTargetGroupPlan({ ...base, activeGroupId: 'right' })).toEqual({
      kind: 'existing',
      groupId: 'right'
    })
  })

  it('targets the sibling when the clicked page lives in the second pane', () => {
    expect(
      resolveLinkTargetGroupPlan({
        ...base,
        tabs: [{ entityId: 'ws-1', groupId: 'right' }]
      })
    ).toEqual({ kind: 'existing', groupId: 'left' })
  })

  it('asks for a right split when the worktree has only one pane', () => {
    expect(resolveLinkTargetGroupPlan({ ...base, layout: leaf('left') })).toEqual({
      kind: 'split-right',
      sourceGroupId: 'left'
    })
  })

  it('falls back to the active group when the clicked page has no tab yet', () => {
    expect(resolveLinkTargetGroupPlan({ ...base, tabs: [] })).toEqual({
      kind: 'existing',
      groupId: 'right'
    })
  })

  it('keeps default behavior when no group can be resolved at all', () => {
    expect(
      resolveLinkTargetGroupPlan({
        ...base,
        tabs: [],
        activeGroupId: null,
        firstGroupId: null,
        layout: null
      })
    ).toEqual({ kind: 'active-group' })
  })
})

describe('resolveLinkTargetGroupId invert override', () => {
  const store = {
    settings: { openLinksInSidePane: false } as { openLinksInSidePane?: boolean } | null,
    unifiedTabsByWorktree: { wt: [{ entityId: 'ws-1', groupId: 'left' }] },
    activeGroupIdByWorktree: { wt: 'left' },
    groupsByWorktree: { wt: [{ id: 'left' }, { id: 'right' }] },
    layoutByWorktree: { wt: split(leaf('left'), leaf('right')) },
    createEmptySplitGroup: () => 'new-split'
  }
  const sourcePage = { worktreeId: 'wt', workspaceId: 'ws-1' }

  it('setting off, no override: opens in the active group', () => {
    expect(
      resolveLinkTargetGroupId({ ...store, settings: { openLinksInSidePane: false } }, sourcePage)
    ).toBeNull()
  })

  it('setting off, override: opens beside the clicked pane', () => {
    expect(
      resolveLinkTargetGroupId({ ...store, settings: { openLinksInSidePane: false } }, sourcePage, {
        invert: true
      })
    ).toBe('right')
  })

  it('setting on, no override: opens beside the clicked pane', () => {
    expect(
      resolveLinkTargetGroupId({ ...store, settings: { openLinksInSidePane: true } }, sourcePage)
    ).toBe('right')
  })

  it('setting on, override: opens in the active group', () => {
    expect(
      resolveLinkTargetGroupId({ ...store, settings: { openLinksInSidePane: true } }, sourcePage, {
        invert: true
      })
    ).toBeNull()
  })
})
