import type { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type RequestedRecoveryTopology = {
  tab: TerminalTab | undefined
  ptyIds: string[] | undefined
  layout: TerminalLayoutSnapshot | undefined
}

const requestedTopologyByRecord = new WeakMap<
  SleepingAgentSessionRecord,
  RequestedRecoveryTopology
>()

function getRecoveryTopology(
  record: SleepingAgentSessionRecord,
  state: AppStoreState
): RequestedRecoveryTopology | null {
  const stable = parsePaneKey(record.paneKey)
  if (!stable) {
    return null
  }
  const tabId = record.tabId ?? stable.tabId
  return {
    tab: state.tabsByWorktree[record.worktreeId]?.find((tab) => tab.id === tabId),
    ptyIds: state.ptyIdsByTabId[tabId],
    layout: state.terminalLayoutsByTabId[tabId]
  }
}

export function recoveryTopologyRecordWasRequested(
  record: SleepingAgentSessionRecord,
  state: AppStoreState
): boolean {
  const requested = requestedTopologyByRecord.get(record)
  const current = getRecoveryTopology(record, state)
  return Boolean(
    requested &&
    current &&
    requested.tab === current.tab &&
    requested.ptyIds === current.ptyIds &&
    requested.layout === current.layout
  )
}

export function markRecoveryTopologyRecordsRequested(
  records: ReadonlySet<SleepingAgentSessionRecord>,
  state: AppStoreState
): void {
  for (const record of records) {
    const topology = getRecoveryTopology(record, state)
    if (topology) {
      requestedTopologyByRecord.set(record, topology)
    }
  }
}
