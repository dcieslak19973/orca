import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  takeAllPendingBackgroundTerminalWorktreeMounts,
  takePendingBackgroundTerminalWorktreeMount
} from '../components/terminal/background-terminal-worktree-mount'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { cancelRecoveryTopologyWait } from './sleeping-agent-recovery-topology'

const initialAppStoreState = useAppStore.getState()
const WORKTREE_ID = 'ssh-worktree'
const OTHER_WORKTREE_ID = 'unrelated-worktree'
const TAB_ID = 'original-codex-tab'
const SECOND_TAB_ID = 'second-codex-tab'
const OTHER_TAB_ID = 'unrelated-tab'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PTY_ID = toAppSshPtyId('ssh-target', 'original-pty')
const PROVIDER_SESSION_ID = 'codex-provider-session'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function makeTerminalTab(id: string, worktreeId: string, ptyId: string | null) {
  return {
    id,
    ptyId,
    worktreeId,
    title: 'codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(leafId: string, ptyId: string) {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function makeRecord(
  tabId: string,
  leafId: string,
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey(tabId, leafId),
    tabId,
    worktreeId: WORKTREE_ID,
    agent: 'codex',
    providerSession: { key: 'session_id', id: PROVIDER_SESSION_ID },
    prompt: 'continue',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live',
    ...overrides
  }
}

afterEach(() => {
  cancelRecoveryTopologyWait(WORKTREE_ID)
  cancelRecoveryTopologyWait(OTHER_WORKTREE_ID)
  cancelRecoveryTopologyWait('folder:folder-1')
  for (let index = 0; index < 10; index += 1) {
    cancelRecoveryTopologyWait(`worktree-${index}`)
  }
  takeAllPendingBackgroundTerminalWorktreeMounts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

describe('live agent resume during renderer graph hydration', () => {
  it('waits for graph topology before targeting the original pane', async () => {
    const record = makeRecord(TAB_ID, LEAF_ID)
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: {
        [WORKTREE_ID]: [],
        [OTHER_WORKTREE_ID]: [makeTerminalTab(OTHER_TAB_ID, OTHER_WORKTREE_ID, 'other-pty')]
      },
      ptyIdsByTabId: {
        [OTHER_TAB_ID]: ['other-pty']
      },
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    } as never)
    const stateBeforeResume = useAppStore.getState()
    const createTab = vi.spyOn(stateBeforeResume, 'createTab')
    const queueStartup = vi.spyOn(stateBeforeResume, 'queueTabStartupCommand')
    const claimResume = vi.spyOn(stateBeforeResume, 'claimAutomaticAgentResume')

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    expect(launched).toBe(0)
    expect(createTab).not.toHaveBeenCalled()
    expect(queueStartup).not.toHaveBeenCalled()
    expect(claimResume).not.toHaveBeenCalled()
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toBeNull()
    expect(takePendingBackgroundTerminalWorktreeMount(OTHER_WORKTREE_ID)).toBeNull()

    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTerminalTab(TAB_ID, WORKTREE_ID, PTY_ID)],
        [OTHER_WORKTREE_ID]: [makeTerminalTab(OTHER_TAB_ID, OTHER_WORKTREE_ID, 'other-pty')]
      },
      ptyIdsByTabId: { [TAB_ID]: [], [OTHER_TAB_ID]: ['other-pty'] },
      terminalLayoutsByTabId: { [TAB_ID]: makeLayout(LEAF_ID, PTY_ID) }
    } as never)
    await Promise.resolve()

    const hydratedState = useAppStore.getState()
    expect(hydratedState.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([TAB_ID])
    expect(hydratedState.tabsByWorktree[OTHER_WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      OTHER_TAB_ID
    ])
    expect(hydratedState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBe(record)
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds: [TAB_ID]
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(queueStartup).not.toHaveBeenCalled()
    expect(claimResume).not.toHaveBeenCalled()
  })

  it('mounts a hidden folder-workspace pane while local PTY liveness is unknown', () => {
    const worktreeId = 'folder:folder-1'
    const localPtyId = 'local-pty-1'
    const record = makeRecord(TAB_ID, LEAF_ID, { worktreeId })
    useAppStore.setState({
      activeWorktreeId: worktreeId,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: {
        [worktreeId]: [makeTerminalTab(TAB_ID, worktreeId, localPtyId)]
      },
      ptyIdsByTabId: { [TAB_ID]: [] },
      terminalLayoutsByTabId: { [TAB_ID]: makeLayout(LEAF_ID, localPtyId) },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree(worktreeId)

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([TAB_ID])
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    expect(takePendingBackgroundTerminalWorktreeMount(worktreeId)).toEqual({
      worktreeId,
      tabIds: [TAB_ID]
    })
  })

  it('waits for stable quit recovery topology before creating a replacement', async () => {
    const record = makeRecord(TAB_ID, LEAF_ID, { origin: 'quit' })
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: { [WORKTREE_ID]: [] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)
    const state = useAppStore.getState()
    const createTab = vi.spyOn(state, 'createTab')
    const queueStartup = vi.spyOn(state, 'queueTabStartupCommand')

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expect(createTab).not.toHaveBeenCalled()
    expect(queueStartup).not.toHaveBeenCalled()

    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTerminalTab(TAB_ID, WORKTREE_ID, PTY_ID)]
      },
      ptyIdsByTabId: { [TAB_ID]: [] },
      terminalLayoutsByTabId: { [TAB_ID]: makeLayout(LEAF_ID, PTY_ID) }
    } as never)
    await Promise.resolve()

    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds: [TAB_ID]
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(queueStartup).not.toHaveBeenCalled()
  })

  it('mounts hidden preserved panes for in-place worktree-sleep recovery', () => {
    const record = makeRecord(TAB_ID, LEAF_ID, { origin: 'worktree-sleep' })
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'terminal',
      activeTabId: SECOND_TAB_ID,
      activeTabIdByWorktree: { [WORKTREE_ID]: SECOND_TAB_ID },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTerminalTab(TAB_ID, WORKTREE_ID, PTY_ID),
          makeTerminalTab(SECOND_TAB_ID, WORKTREE_ID, 'second-pty')
        ]
      },
      terminalLayoutsByTabId: {
        [TAB_ID]: makeLayout(LEAF_ID, PTY_ID),
        [SECOND_TAB_ID]: makeLayout(SECOND_LEAF_ID, 'second-pty')
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([TAB_ID, SECOND_TAB_ID])
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds: [TAB_ID]
    })
  })

  it('probes the oldest preserved pane first for a duplicated provider session', () => {
    const first = makeRecord(TAB_ID, LEAF_ID)
    const second = makeRecord(SECOND_TAB_ID, SECOND_LEAF_ID, {
      capturedAt: 2,
      updatedAt: 2
    })
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTerminalTab(TAB_ID, WORKTREE_ID, PTY_ID),
          makeTerminalTab(SECOND_TAB_ID, WORKTREE_ID, 'second-pty')
        ]
      },
      ptyIdsByTabId: { [TAB_ID]: [], [SECOND_TAB_ID]: [] },
      terminalLayoutsByTabId: {
        [TAB_ID]: makeLayout(LEAF_ID, PTY_ID),
        [SECOND_TAB_ID]: makeLayout(SECOND_LEAF_ID, 'second-pty')
      },
      sleepingAgentSessionsByPaneKey: {
        [first.paneKey]: first,
        [second.paneKey]: second
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.sleepingAgentSessionsByPaneKey[first.paneKey]).toBe(first)
    expect(state.sleepingAgentSessionsByPaneKey[second.paneKey]).toBe(second)
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds: [TAB_ID]
    })
  })

  it('waits for the oldest provider alias before probing a newer hydrated alias', async () => {
    const oldest = makeRecord(TAB_ID, LEAF_ID)
    const newer = makeRecord(SECOND_TAB_ID, SECOND_LEAF_ID, {
      capturedAt: 2,
      updatedAt: 2
    })
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTerminalTab(SECOND_TAB_ID, WORKTREE_ID, 'second-pty')]
      },
      ptyIdsByTabId: { [SECOND_TAB_ID]: [] },
      terminalLayoutsByTabId: {
        [SECOND_TAB_ID]: makeLayout(SECOND_LEAF_ID, 'second-pty')
      },
      sleepingAgentSessionsByPaneKey: {
        [oldest.paneKey]: oldest,
        [newer.paneKey]: newer
      }
    } as never)
    await Promise.resolve()

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toBeNull()

    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTerminalTab(TAB_ID, WORKTREE_ID, PTY_ID),
          makeTerminalTab(SECOND_TAB_ID, WORKTREE_ID, 'second-pty')
        ]
      },
      ptyIdsByTabId: { [TAB_ID]: [], [SECOND_TAB_ID]: [] },
      terminalLayoutsByTabId: {
        [TAB_ID]: makeLayout(LEAF_ID, PTY_ID),
        [SECOND_TAB_ID]: makeLayout(SECOND_LEAF_ID, 'second-pty')
      }
    } as never)
    await Promise.resolve()

    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds: [TAB_ID]
    })
  })

  it('promotes a hydrated provider alias after the pending oldest record clears', async () => {
    const oldest = makeRecord(TAB_ID, LEAF_ID)
    const newer = makeRecord(SECOND_TAB_ID, SECOND_LEAF_ID, {
      capturedAt: 2,
      updatedAt: 2
    })
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTerminalTab(SECOND_TAB_ID, WORKTREE_ID, 'second-pty')]
      },
      ptyIdsByTabId: { [SECOND_TAB_ID]: [] },
      terminalLayoutsByTabId: {
        [SECOND_TAB_ID]: makeLayout(SECOND_LEAF_ID, 'second-pty')
      },
      sleepingAgentSessionsByPaneKey: {
        [oldest.paneKey]: oldest,
        [newer.paneKey]: newer
      }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toBeNull()

    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: { [newer.paneKey]: newer }
    } as never)
    await Promise.resolve()

    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds: [SECOND_TAB_ID]
    })
  })

  it('does not let renderer PTY hints reorder or retire provider-session aliases', () => {
    const oldest = makeRecord(TAB_ID, LEAF_ID)
    const hinted = makeRecord(SECOND_TAB_ID, SECOND_LEAF_ID, {
      capturedAt: 2,
      updatedAt: 2
    })
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'terminal',
      activeTabId: SECOND_TAB_ID,
      activeTabIdByWorktree: { [WORKTREE_ID]: SECOND_TAB_ID },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTerminalTab(TAB_ID, WORKTREE_ID, PTY_ID),
          makeTerminalTab(SECOND_TAB_ID, WORKTREE_ID, 'second-pty')
        ]
      },
      ptyIdsByTabId: { [TAB_ID]: [], [SECOND_TAB_ID]: ['second-pty'] },
      terminalLayoutsByTabId: {
        [TAB_ID]: makeLayout(LEAF_ID, PTY_ID),
        [SECOND_TAB_ID]: makeLayout(SECOND_LEAF_ID, 'second-pty')
      },
      sleepingAgentSessionsByPaneKey: {
        [oldest.paneKey]: oldest,
        [hinted.paneKey]: hinted
      }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.sleepingAgentSessionsByPaneKey[oldest.paneKey]).toBe(oldest)
    expect(state.sleepingAgentSessionsByPaneKey[hinted.paneKey]).toBe(hinted)
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds: [TAB_ID]
    })
  })

  it('advances partial topology hydration once per pending-pane transition', async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    vi.stubGlobal(
      'CustomEvent',
      class {
        detail: unknown

        constructor(_type: string, init: { detail: unknown }) {
          this.detail = init.detail
        }
      }
    )
    const first = makeRecord(TAB_ID, LEAF_ID)
    const second = makeRecord(SECOND_TAB_ID, SECOND_LEAF_ID, {
      providerSession: { key: 'session_id', id: 'second-provider-session' }
    })
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: { [WORKTREE_ID]: [] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        [first.paneKey]: first,
        [second.paneKey]: second
      }
    } as never)
    const state = useAppStore.getState()
    const createTab = vi.spyOn(state, 'createTab')
    const queueStartup = vi.spyOn(state, 'queueTabStartupCommand')

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expect(dispatchEvent).not.toHaveBeenCalled()

    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTerminalTab(TAB_ID, WORKTREE_ID, PTY_ID)]
      },
      ptyIdsByTabId: { [TAB_ID]: [] },
      terminalLayoutsByTabId: { [TAB_ID]: makeLayout(LEAF_ID, PTY_ID) }
    } as never)
    await Promise.resolve()

    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds: [TAB_ID]
    })

    useAppStore.setState({ activeTabId: 'unrelated-browser-tab' } as never)
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toBeNull()

    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTerminalTab(TAB_ID, WORKTREE_ID, PTY_ID),
          makeTerminalTab(SECOND_TAB_ID, WORKTREE_ID, 'second-pty')
        ]
      },
      ptyIdsByTabId: { [TAB_ID]: [], [SECOND_TAB_ID]: [] },
      terminalLayoutsByTabId: {
        [TAB_ID]: makeLayout(LEAF_ID, PTY_ID),
        [SECOND_TAB_ID]: makeLayout(SECOND_LEAF_ID, 'second-pty')
      }
    } as never)
    await Promise.resolve()

    expect(dispatchEvent).toHaveBeenCalledTimes(2)
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds: [SECOND_TAB_ID]
    })
    useAppStore.setState({ activeTabId: null } as never)
    expect(dispatchEvent).toHaveBeenCalledTimes(2)
    expect(createTab).not.toHaveBeenCalled()
    expect(queueStartup).not.toHaveBeenCalled()
  })

  it('does not enumerate unchanged topology maps after an unrelated tab title update', async () => {
    const worktreeIds = Array.from({ length: 10 }, (_, index) => `worktree-${index}`)
    const records: Record<string, SleepingAgentSessionRecord> = {}
    const unrelatedTab = makeTerminalTab('unrelated-tab', 'unrelated', 'unrelated-pty')
    const rawTabsByWorktree = {
      ...Object.fromEntries(
        worktreeIds.map((worktreeId) => [worktreeId, [] as ReturnType<typeof makeTerminalTab>[]])
      ),
      unrelated: [unrelatedTab]
    }
    for (const [worktreeIndex, worktreeId] of worktreeIds.entries()) {
      for (let paneIndex = 0; paneIndex < 10; paneIndex += 1) {
        const suffix = String(worktreeIndex * 10 + paneIndex).padStart(12, '0')
        const record = makeRecord(`tab-${suffix}`, `00000000-0000-4000-8000-${suffix}`, {
          worktreeId,
          providerSession: { key: 'session_id', id: `session-${suffix}` }
        })
        records[record.paneKey] = record
      }
    }
    let ptyMapEnumerations = 0
    let layoutMapEnumerations = 0
    const ptyIdsByTabId = new Proxy<Record<string, string[]>>(
      { unrelated: ['unrelated-pty'] },
      {
        ownKeys(target) {
          ptyMapEnumerations += 1
          return Reflect.ownKeys(target)
        }
      }
    )
    const terminalLayoutsByTabId = new Proxy<Record<string, ReturnType<typeof makeLayout>>>(
      {
        unrelated: makeLayout('33333333-3333-4333-8333-333333333333', 'unrelated-pty')
      },
      {
        ownKeys(target) {
          layoutMapEnumerations += 1
          return Reflect.ownKeys(target)
        }
      }
    )
    useAppStore.setState({
      activeWorktreeId: worktreeIds[0],
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: rawTabsByWorktree,
      ptyIdsByTabId,
      terminalLayoutsByTabId,
      sleepingAgentSessionsByPaneKey: records
    } as never)
    for (const worktreeId of worktreeIds) {
      expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
    }
    ptyMapEnumerations = 0
    layoutMapEnumerations = 0

    const nextTabsByWorktree = {
      ...rawTabsByWorktree,
      unrelated: [
        {
          ...unrelatedTab,
          title: 'renamed shell'
        }
      ]
    }
    useAppStore.setState({
      tabsByWorktree: nextTabsByWorktree
    } as never)
    await Promise.resolve()

    expect(ptyMapEnumerations).toBe(0)
    expect(layoutMapEnumerations).toBe(0)
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([])
  })

  it('mounts a replacement record that reuses a requested pane key', async () => {
    const first = makeRecord(TAB_ID, LEAF_ID)
    const unresolved = makeRecord(SECOND_TAB_ID, SECOND_LEAF_ID, {
      providerSession: { key: 'session_id', id: 'unresolved-session' }
    })
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: { [WORKTREE_ID]: [] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        [first.paneKey]: first,
        [unresolved.paneKey]: unresolved
      }
    } as never)
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)

    useAppStore.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTerminalTab(TAB_ID, WORKTREE_ID, PTY_ID)]
      },
      ptyIdsByTabId: { [TAB_ID]: [] },
      terminalLayoutsByTabId: { [TAB_ID]: makeLayout(LEAF_ID, PTY_ID) }
    } as never)
    await Promise.resolve()
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)?.tabIds).toEqual([TAB_ID])

    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: { [unresolved.paneKey]: unresolved }
    } as never)
    const replacement = makeRecord(TAB_ID, LEAF_ID, {
      providerSession: { key: 'session_id', id: 'replacement-session' },
      capturedAt: 3,
      updatedAt: 3
    })
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [replacement.paneKey]: replacement,
        [unresolved.paneKey]: unresolved
      }
    } as never)
    await Promise.resolve()

    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)?.tabIds).toEqual([TAB_ID])
  })

  it('coalesces synchronous hydration into one targeted linear topology pass', async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    vi.stubGlobal(
      'CustomEvent',
      class {
        detail: unknown

        constructor(_type: string, init: { detail: unknown }) {
          this.detail = init.detail
        }
      }
    )
    const tabIds = Array.from({ length: 100 }, (_, index) => `tab-${index}`)
    const records: Record<string, SleepingAgentSessionRecord> = {}
    const leafIds = tabIds.map(
      (_tabId, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    )
    for (const [index, tabId] of tabIds.entries()) {
      const record = makeRecord(tabId, leafIds[index]!, {
        providerSession: { key: 'session_id', id: `session-${index}` }
      })
      records[record.paneKey] = record
    }
    let recordEnumerations = 0
    const sleepingAgentSessionsByPaneKey = new Proxy(records, {
      ownKeys(target) {
        recordEnumerations += 1
        return Reflect.ownKeys(target)
      }
    })
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: { [WORKTREE_ID]: [] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey
    } as never)
    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    recordEnumerations = 0

    const tabs: ReturnType<typeof makeTerminalTab>[] = []
    const rawPtyIdsByTabId: Record<string, string[]> = {}
    const rawTerminalLayoutsByTabId: Record<string, ReturnType<typeof makeLayout>> = {}
    let ptyMapEnumerations = 0
    let layoutMapEnumerations = 0
    let targetedTopologyReads = 0
    const ptyIdsByTabId = new Proxy(rawPtyIdsByTabId, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          targetedTopologyReads += 1
        }
        return Reflect.get(target, property, receiver)
      },
      ownKeys(target) {
        ptyMapEnumerations += 1
        return Reflect.ownKeys(target)
      }
    })
    const terminalLayoutsByTabId = new Proxy(rawTerminalLayoutsByTabId, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          targetedTopologyReads += 1
        }
        return Reflect.get(target, property, receiver)
      },
      ownKeys(target) {
        layoutMapEnumerations += 1
        return Reflect.ownKeys(target)
      }
    })
    for (const [index, tabId] of tabIds.entries()) {
      const ptyId = `pty-${index}`
      tabs.push(makeTerminalTab(tabId, WORKTREE_ID, ptyId))
      rawPtyIdsByTabId[tabId] = []
      rawTerminalLayoutsByTabId[tabId] = makeLayout(leafIds[index]!, ptyId)
      useAppStore.setState({
        tabsByWorktree: { [WORKTREE_ID]: [...tabs] },
        ptyIdsByTabId,
        terminalLayoutsByTabId
      } as never)
    }
    await Promise.resolve()

    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds
    })
    expect(recordEnumerations).toBeLessThanOrEqual(1)
    expect(ptyMapEnumerations).toBe(0)
    expect(layoutMapEnumerations).toBe(0)
    expect(targetedTopologyReads).toBeLessThanOrEqual(tabIds.length * 12)
  })

  it('batches one hundred preserved claims into one targeted mount event', () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    vi.stubGlobal(
      'CustomEvent',
      class {
        detail: unknown

        constructor(_type: string, init: { detail: unknown }) {
          this.detail = init.detail
        }
      }
    )
    const tabIds = Array.from({ length: 100 }, (_, index) => `tab-${index}`)
    const tabs = tabIds.map((tabId, index) => makeTerminalTab(tabId, WORKTREE_ID, `pty-${index}`))
    const ptyIdsByTabId: Record<string, string[]> = {}
    const terminalLayoutsByTabId: Record<string, ReturnType<typeof makeLayout>> = {}
    const sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> = {}
    for (const [index, tabId] of tabIds.entries()) {
      const leafId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      const record = makeRecord(tabId, leafId, {
        providerSession: { key: 'session_id', id: `session-${index}` }
      })
      ptyIdsByTabId[tabId] = []
      terminalLayoutsByTabId[tabId] = makeLayout(leafId, `pty-${index}`)
      sleepingAgentSessionsByPaneKey[record.paneKey] = record
    }
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeTabType: 'browser',
      activeTabId: null,
      tabsByWorktree: { [WORKTREE_ID]: tabs },
      ptyIdsByTabId,
      terminalLayoutsByTabId,
      sleepingAgentSessionsByPaneKey
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    expect(launched).toBe(0)
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(takePendingBackgroundTerminalWorktreeMount(WORKTREE_ID)).toEqual({
      worktreeId: WORKTREE_ID,
      tabIds
    })
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]).toHaveLength(100)
  })
})
