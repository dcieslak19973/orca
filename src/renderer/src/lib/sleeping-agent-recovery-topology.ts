import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  collectChangedSleepingAgentPaneKeys,
  recordWaitsForRecoveryTopology
} from './sleeping-agent-recovery-topology-state'
import { createSleepingAgentRecoveryDispatchBarrier } from './sleeping-agent-recovery-dispatch-barrier'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type RecoveryTopologyRegistration = {
  record: SleepingAgentSessionRecord
  tabId: string
  wait: RecoveryTopologyWait
}

type RecoveryTopologyWait = {
  worktreeId: string
  registrationsByPaneKey: Map<string, RecoveryTopologyRegistration>
  recover: (records: readonly SleepingAgentSessionRecord[]) => void
  recovering: boolean
  generation: number
}

const topologyWaitsByWorktree = new Map<string, RecoveryTopologyWait>()
const registrationsByPaneKey = new Map<string, Set<RecoveryTopologyRegistration>>()
const registrationsByTabId = new Map<string, Set<RecoveryTopologyRegistration>>()
let unsubscribeRecoveryTopology: (() => void) | null = null
let recoveryTopologyDispatching = false
let recoveryTopologyWaitGeneration = 0

function addIndexedRegistration(
  index: Map<string, Set<RecoveryTopologyRegistration>>,
  key: string,
  registration: RecoveryTopologyRegistration
): void {
  const registrations = index.get(key) ?? new Set()
  registrations.add(registration)
  index.set(key, registrations)
}

function removeIndexedRegistration(
  index: Map<string, Set<RecoveryTopologyRegistration>>,
  key: string,
  registration: RecoveryTopologyRegistration
): void {
  const registrations = index.get(key)
  registrations?.delete(registration)
  if (registrations?.size === 0) {
    index.delete(key)
  }
}

function removeRegistration(registration: RecoveryTopologyRegistration): void {
  registration.wait.registrationsByPaneKey.delete(registration.record.paneKey)
  removeIndexedRegistration(registrationsByPaneKey, registration.record.paneKey, registration)
  removeIndexedRegistration(registrationsByTabId, registration.tabId, registration)
}

function addRegistration(
  wait: RecoveryTopologyWait,
  record: SleepingAgentSessionRecord
): RecoveryTopologyRegistration | null {
  const stable = parsePaneKey(record.paneKey)
  if (!stable) {
    return null
  }
  const existing = wait.registrationsByPaneKey.get(record.paneKey)
  if (existing?.record === record) {
    return existing
  }
  if (existing) {
    removeRegistration(existing)
  }
  const registration = {
    record,
    tabId: record.tabId ?? stable.tabId,
    wait
  }
  wait.registrationsByPaneKey.set(record.paneKey, registration)
  addIndexedRegistration(registrationsByPaneKey, record.paneKey, registration)
  addIndexedRegistration(registrationsByTabId, registration.tabId, registration)
  return registration
}

function stopTopologySubscriptionIfIdle(): void {
  if (topologyWaitsByWorktree.size > 0) {
    return
  }
  unsubscribeRecoveryTopology?.()
  unsubscribeRecoveryTopology = null
}

export function cancelRecoveryTopologyWait(worktreeId: string): void {
  const wait = topologyWaitsByWorktree.get(worktreeId)
  if (!wait) {
    return
  }
  for (const registration of wait.registrationsByPaneKey.values()) {
    removeRegistration(registration)
  }
  topologyWaitsByWorktree.delete(worktreeId)
  stopTopologySubscriptionIfIdle()
}

function collectChangedTabIds(state: AppStoreState, previousState: AppStoreState): Set<string> {
  const changedTabIds = new Set<string>()
  const ptyIdsChanged = state.ptyIdsByTabId !== previousState.ptyIdsByTabId
  const layoutsChanged = state.terminalLayoutsByTabId !== previousState.terminalLayoutsByTabId
  if (ptyIdsChanged || layoutsChanged) {
    for (const tabId of registrationsByTabId.keys()) {
      if (
        (ptyIdsChanged && state.ptyIdsByTabId[tabId] !== previousState.ptyIdsByTabId[tabId]) ||
        (layoutsChanged &&
          state.terminalLayoutsByTabId[tabId] !== previousState.terminalLayoutsByTabId[tabId])
      ) {
        changedTabIds.add(tabId)
      }
    }
  }
  if (state.tabsByWorktree === previousState.tabsByWorktree) {
    return changedTabIds
  }
  for (const wait of topologyWaitsByWorktree.values()) {
    const worktreeId = wait.worktreeId
    const previousTabs = previousState.tabsByWorktree[worktreeId] ?? []
    const currentTabs = state.tabsByWorktree[worktreeId] ?? []
    if (previousTabs === currentTabs) {
      continue
    }
    const previousById = new Map(previousTabs.map((tab) => [tab.id, tab]))
    const currentById = new Map(currentTabs.map((tab) => [tab.id, tab]))
    for (const registration of wait.registrationsByPaneKey.values()) {
      if (previousById.get(registration.tabId) !== currentById.get(registration.tabId)) {
        changedTabIds.add(registration.tabId)
      }
    }
  }
  return changedTabIds
}

function addResolvedRegistration(
  registration: RecoveryTopologyRegistration,
  state: AppStoreState,
  recordsByWait: Map<RecoveryTopologyWait, Set<SleepingAgentSessionRecord>>,
  maximumWaitGeneration: number
): void {
  if (registration.wait.generation > maximumWaitGeneration) {
    return
  }
  if (state.sleepingAgentSessionsByPaneKey[registration.record.paneKey] !== registration.record) {
    removeRegistration(registration)
    return
  }
  if (recordWaitsForRecoveryTopology(registration.record, state)) {
    return
  }
  removeRegistration(registration)
  const records = recordsByWait.get(registration.wait) ?? new Set()
  records.add(registration.record)
  recordsByWait.set(registration.wait, records)
}

function reconcileSleepingRecordChanges(
  state: AppStoreState,
  previousState: AppStoreState,
  recordsByWait: Map<RecoveryTopologyWait, Set<SleepingAgentSessionRecord>>,
  maximumWaitGeneration: number
): void {
  const changedPaneKeys = collectChangedSleepingAgentPaneKeys(
    state.sleepingAgentSessionsByPaneKey,
    previousState.sleepingAgentSessionsByPaneKey
  )
  for (const paneKey of changedPaneKeys) {
    for (const registration of registrationsByPaneKey.get(paneKey) ?? []) {
      if (registration.wait.generation > maximumWaitGeneration) {
        continue
      }
      if (state.sleepingAgentSessionsByPaneKey[paneKey] !== registration.record) {
        const records = recordsByWait.get(registration.wait) ?? new Set()
        records.add(registration.record)
        recordsByWait.set(registration.wait, records)
        removeRegistration(registration)
      }
    }
    const record = state.sleepingAgentSessionsByPaneKey[paneKey]
    const wait = record ? topologyWaitsByWorktree.get(record.worktreeId) : null
    if (!record || !wait || wait.generation > maximumWaitGeneration) {
      continue
    }
    if (recordWaitsForRecoveryTopology(record, state)) {
      addRegistration(wait, record)
      continue
    }
    const records = recordsByWait.get(wait) ?? new Set()
    records.add(record)
    recordsByWait.set(wait, records)
  }
}

function dispatchResolvedRecords(
  recordsByWait: Map<RecoveryTopologyWait, Set<SleepingAgentSessionRecord>>
): void {
  for (const [wait, records] of recordsByWait) {
    if (wait.recovering || records.size === 0) {
      continue
    }
    wait.recovering = true
    try {
      wait.recover([...records])
    } finally {
      wait.recovering = false
    }
  }
  for (const wait of topologyWaitsByWorktree.values()) {
    if (wait.registrationsByPaneKey.size === 0) {
      topologyWaitsByWorktree.delete(wait.worktreeId)
    }
  }
  stopTopologySubscriptionIfIdle()
}

function dispatchRecoveryTopologyChanges(
  state: AppStoreState,
  previousState: AppStoreState,
  maximumWaitGeneration: number
): void {
  if (recoveryTopologyDispatching) {
    return
  }
  recoveryTopologyDispatching = true
  try {
    const recordsByWait = new Map<RecoveryTopologyWait, Set<SleepingAgentSessionRecord>>()
    if (state.sleepingAgentSessionsByPaneKey !== previousState.sleepingAgentSessionsByPaneKey) {
      reconcileSleepingRecordChanges(state, previousState, recordsByWait, maximumWaitGeneration)
    }
    if (
      state.tabsByWorktree !== previousState.tabsByWorktree ||
      state.ptyIdsByTabId !== previousState.ptyIdsByTabId ||
      state.terminalLayoutsByTabId !== previousState.terminalLayoutsByTabId
    ) {
      const candidates = new Set<RecoveryTopologyRegistration>()
      for (const tabId of collectChangedTabIds(state, previousState)) {
        for (const registration of registrationsByTabId.get(tabId) ?? []) {
          candidates.add(registration)
        }
      }
      for (const registration of candidates) {
        addResolvedRegistration(registration, state, recordsByWait, maximumWaitGeneration)
      }
    }
    dispatchResolvedRecords(recordsByWait)
  } finally {
    recoveryTopologyDispatching = false
  }
}

const queueRecoveryTopologyDispatch = createSleepingAgentRecoveryDispatchBarrier(
  dispatchRecoveryTopologyChanges
)

function ensureRecoveryTopologySubscription(): void {
  if (unsubscribeRecoveryTopology) {
    return
  }
  unsubscribeRecoveryTopology = useAppStore.subscribe((state, previousState) => {
    const sleepingRecordsChanged =
      state.sleepingAgentSessionsByPaneKey !== previousState.sleepingAgentSessionsByPaneKey
    const terminalTopologyChanged =
      state.tabsByWorktree !== previousState.tabsByWorktree ||
      state.ptyIdsByTabId !== previousState.ptyIdsByTabId ||
      state.terminalLayoutsByTabId !== previousState.terminalLayoutsByTabId
    if (sleepingRecordsChanged || terminalTopologyChanged) {
      queueRecoveryTopologyDispatch(state, previousState, recoveryTopologyWaitGeneration)
    }
  })
}

export function waitForRecoveryTopology(
  worktreeId: string,
  pendingRecords: readonly SleepingAgentSessionRecord[],
  recover: (records: readonly SleepingAgentSessionRecord[]) => void
): void {
  let wait = topologyWaitsByWorktree.get(worktreeId)
  if (!wait) {
    wait = {
      worktreeId,
      registrationsByPaneKey: new Map(),
      recover,
      recovering: false,
      generation: ++recoveryTopologyWaitGeneration
    }
    topologyWaitsByWorktree.set(worktreeId, wait)
  } else {
    wait.recover = recover
    wait.generation = ++recoveryTopologyWaitGeneration
  }
  const pendingByPaneKey = new Map(pendingRecords.map((record) => [record.paneKey, record]))
  for (const registration of wait.registrationsByPaneKey.values()) {
    if (pendingByPaneKey.get(registration.record.paneKey) !== registration.record) {
      removeRegistration(registration)
    }
  }
  for (const record of pendingRecords) {
    addRegistration(wait, record)
  }
  ensureRecoveryTopologySubscription()
}
