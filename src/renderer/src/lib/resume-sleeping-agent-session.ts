import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import {
  getPreservedStablePaneRecoveryTabId,
  getProviderSessionClaimKey,
  isPassiveCompletedHibernationEvidence,
  recordPaneIsOwnedByPreservedPane
} from './sleeping-agent-pane-ownership'
import {
  launchSleepingAgentSession,
  type ResumeSleepingAgentSessionsOptions
} from './sleeping-agent-session-launch'
import {
  cancelRecoveryTopologyWait,
  waitForRecoveryTopology
} from './sleeping-agent-recovery-topology'
import { recordWaitsForRecoveryTopology } from './sleeping-agent-recovery-topology-state'
import {
  activeOrQueuedResumeClaimsProviderSession,
  getCanonicalStableRecordsByClaimKey,
  getNewestActiveRecordsByClaimKey,
  isInvalidWorktreeActivationRecord,
  requestHydratedRecoveryRecords
} from './sleeping-agent-recovery-claims'
import {
  markRecoveryTopologyRecordsRequested,
  recoveryTopologyRecordWasRequested
} from './sleeping-agent-recovery-request-generation'

export type { ResumeSleepingAgentSessionsOptions } from './sleeping-agent-session-launch'

function clearPassiveCompletedRecordsForClaimKey(
  records: readonly SleepingAgentSessionRecord[],
  claimKey: string,
  keepPaneKey: string
): void {
  const state = useAppStore.getState()
  for (const record of records) {
    if (record.paneKey === keepPaneKey || !isPassiveCompletedHibernationEvidence(record)) {
      continue
    }
    if (getProviderSessionClaimKey(record) === claimKey) {
      state.clearSleepingAgentSession(record.paneKey)
    }
  }
}

export function resumeSleepingAgentSessionsForWorktree(
  worktreeId: string,
  options?: ResumeSleepingAgentSessionsOptions
): number {
  const state = useAppStore.getState()
  const worktreeRecords = Object.values(state.sleepingAgentSessionsByPaneKey)
    .filter((record) => record.worktreeId === worktreeId)
    .sort((a, b) => a.capturedAt - b.capturedAt || a.updatedAt - b.updatedAt)
  const validWorktreeRecords = worktreeRecords.filter(
    (record) => !isInvalidWorktreeActivationRecord(record)
  )
  const activeWorktreeRecords = validWorktreeRecords.filter(
    (record) => !isPassiveCompletedHibernationEvidence(record)
  )
  const activeClaimKeys = new Set(activeWorktreeRecords.map(getProviderSessionClaimKey))
  const newestActiveRecordByClaimKey = getNewestActiveRecordsByClaimKey(activeWorktreeRecords)
  const recoveryRecordByClaimKey = getCanonicalStableRecordsByClaimKey(activeWorktreeRecords)
  const freshlyLaunchedClaimKeys = new Set<string>()
  const recoveryTabIdsToMount = new Set<string>()
  const recoveryRecordsToMount = new Set<SleepingAgentSessionRecord>()
  const topologyPendingRecords: SleepingAgentSessionRecord[] = []

  let launched = 0
  for (const record of worktreeRecords) {
    const currentState = useAppStore.getState()
    if (currentState.sleepingAgentSessionsByPaneKey[record.paneKey] !== record) {
      continue
    }
    const claimKey = getProviderSessionClaimKey(record)
    // Why: a mounted pane already consumed (or latched) the in-place
    // hibernation wake for this session; its record clears when that spawn
    // succeeds. Launching or clearing here would double-resume the session.
    if (options?.skipClaimKeys?.has(claimKey)) {
      continue
    }
    if (record.automaticResumeBlockedBy === 'legacy-orchestration-worker') {
      continue
    }
    if (isInvalidWorktreeActivationRecord(record)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (isPassiveCompletedHibernationEvidence(record) && activeClaimKeys.has(claimKey)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (recordWaitsForRecoveryTopology(record, currentState)) {
      topologyPendingRecords.push(record)
      continue
    }
    const paneIsAlreadyOwned = recordPaneIsOwnedByPreservedPane(record, currentState)
    const preservedRecoveryTabId = getPreservedStablePaneRecoveryTabId(record, currentState)
    const isPaneOwned = paneIsAlreadyOwned || preservedRecoveryTabId !== null
    if (isPassiveCompletedHibernationEvidence(record)) {
      // Why: completed-agent hibernation is passive history; activation should
      // only keep displayable evidence, never start new work from it.
      if (!isPaneOwned || activeClaimKeys.has(claimKey)) {
        state.clearSleepingAgentSession(record.paneKey)
      }
      continue
    }
    if (activeOrQueuedResumeClaimsProviderSession(record, currentState, isPaneOwned)) {
      // Why: main can replay the old wake record after the same provider
      // session was already queued in a fresh tab; clear the stale replay.
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    const recoveryRecord = recoveryRecordByClaimKey.get(claimKey)
    if (recoveryRecord) {
      if (
        recoveryRecord === record &&
        preservedRecoveryTabId &&
        !recoveryTopologyRecordWasRequested(record, currentState)
      ) {
        recoveryTabIdsToMount.add(preservedRecoveryTabId)
        recoveryRecordsToMount.add(record)
      }
      continue
    }
    if (freshlyLaunchedClaimKeys.has(claimKey)) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (newestActiveRecordByClaimKey.get(claimKey) !== record) {
      state.clearSleepingAgentSession(record.paneKey)
      continue
    }
    if (isPaneOwned) {
      continue
    }
    if (launchSleepingAgentSession(record, options)) {
      launched += 1
      freshlyLaunchedClaimKeys.add(claimKey)
      clearPassiveCompletedRecordsForClaimKey(worktreeRecords, claimKey, record.paneKey)
    }
  }
  if (recoveryTabIdsToMount.size > 0) {
    markRecoveryTopologyRecordsRequested(recoveryRecordsToMount, useAppStore.getState())
    // Why: one event avoids quadratic restriction merges when many panes recover together.
    requestBackgroundTerminalWorktreeMount({
      worktreeId,
      tabIds: [...recoveryTabIdsToMount]
    })
  }
  if (topologyPendingRecords.length > 0) {
    waitForRecoveryTopology(worktreeId, topologyPendingRecords, (records) => {
      requestHydratedRecoveryRecords(worktreeId, records, options)
    })
  } else {
    cancelRecoveryTopologyWait(worktreeId)
  }
  return launched
}
