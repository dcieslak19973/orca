import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  cancelRecoveryTopologyWait,
  waitForRecoveryTopology
} from './sleeping-agent-recovery-topology'

const initialAppStoreState = useAppStore.getState()
const WORKTREE_ID = 'ssh-worktree'
const TAB_ID = 'original-tab'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = 'ssh:ssh-target@@original-pty'

const record: SleepingAgentSessionRecord = {
  paneKey: makePaneKey(TAB_ID, LEAF_ID),
  tabId: TAB_ID,
  worktreeId: WORKTREE_ID,
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'provider-session' },
  prompt: 'continue',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'live'
}

function emptyTopology() {
  return {
    tabsByWorktree: { [WORKTREE_ID]: [] },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  }
}

function hydratedTopology() {
  return {
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: PTY_ID,
          worktreeId: WORKTREE_ID,
          title: 'codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    ptyIdsByTabId: { [TAB_ID]: [] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    }
  }
}

afterEach(() => {
  cancelRecoveryTopologyWait(WORKTREE_ID)
  useAppStore.setState(initialAppStoreState, true)
})

describe('sleeping agent recovery topology', () => {
  it('does not let a queued hydration consume a later reconnect wait', async () => {
    useAppStore.setState(emptyTopology() as never)
    const staleRecover = () => {}
    const currentRecover = vi.fn()

    waitForRecoveryTopology(WORKTREE_ID, [record], staleRecover)
    useAppStore.setState(hydratedTopology() as never)
    cancelRecoveryTopologyWait(WORKTREE_ID)
    useAppStore.setState(emptyTopology() as never)
    waitForRecoveryTopology(WORKTREE_ID, [record], currentRecover)

    await Promise.resolve()
    expect(currentRecover).not.toHaveBeenCalled()

    useAppStore.setState(hydratedTopology() as never)
    await Promise.resolve()

    expect(currentRecover).toHaveBeenCalledOnce()
    expect(currentRecover).toHaveBeenCalledWith([record])
  })
})
