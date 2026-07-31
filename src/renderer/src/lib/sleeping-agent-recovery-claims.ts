import { useAppStore } from '@/store'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import type { ResumeSleepingAgentSessionsOptions } from './sleeping-agent-session-launch'
import {
  getPreservedStablePaneRecoveryTabId,
  getProviderSessionClaimKey,
  getSleepingAgentRecordsForProviderClaim,
  isPassiveCompletedHibernationEvidence,
  recordHasStablePaneIdentity
} from './sleeping-agent-pane-ownership'
import { recordWaitsForRecoveryTopology } from './sleeping-agent-recovery-topology-state'
import {
  markRecoveryTopologyRecordsRequested,
  recoveryTopologyRecordWasRequested
} from './sleeping-agent-recovery-request-generation'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export function isInvalidWorktreeActivationRecord(record: SleepingAgentSessionRecord): boolean {
  if (record.interrupted === true) {
    return true
  }
  if (!record.origin && record.state === 'done') {
    return true
  }
  return (
    record.state !== 'done' && record.capturedAt - record.updatedAt > AGENT_STATUS_STALE_AFTER_MS
  )
}

export function getCanonicalStableRecordsByClaimKey(
  records: readonly SleepingAgentSessionRecord[]
): Map<string, SleepingAgentSessionRecord> {
  const recordsByClaimKey = new Map<string, SleepingAgentSessionRecord>()
  for (const record of records) {
    if (
      isInvalidWorktreeActivationRecord(record) ||
      isPassiveCompletedHibernationEvidence(record) ||
      !recordHasStablePaneIdentity(record)
    ) {
      continue
    }
    const claimKey = getProviderSessionClaimKey(record)
    const current = recordsByClaimKey.get(claimKey)
    if (
      !current ||
      record.capturedAt < current.capturedAt ||
      (record.capturedAt === current.capturedAt && record.updatedAt < current.updatedAt)
    ) {
      recordsByClaimKey.set(claimKey, record)
    }
  }
  return recordsByClaimKey
}

export function getNewestActiveRecordsByClaimKey(
  records: readonly SleepingAgentSessionRecord[]
): Map<string, SleepingAgentSessionRecord> {
  const newestRecords = new Map<string, SleepingAgentSessionRecord>()
  for (const record of records) {
    const claimKey = getProviderSessionClaimKey(record)
    const current = newestRecords.get(claimKey)
    if (
      !current ||
      record.capturedAt > current.capturedAt ||
      (record.capturedAt === current.capturedAt && record.updatedAt > current.updatedAt)
    ) {
      newestRecords.set(claimKey, record)
    }
  }
  return newestRecords
}

function getAgentStatusTabId(entry: {
  paneKey: string
  tabId?: string | undefined
}): string | null {
  if (entry.tabId) {
    return entry.tabId
  }
  const separatorIndex = entry.paneKey.indexOf(':')
  return separatorIndex === -1 ? null : entry.paneKey.slice(0, separatorIndex)
}

export function activeOrQueuedResumeClaimsProviderSession(
  record: SleepingAgentSessionRecord,
  state: AppStoreState,
  samePaneOwnsRecovery: boolean
): boolean {
  const worktreeTabIds = new Set(
    (state.tabsByWorktree[record.worktreeId] ?? []).map((tab) => tab.id)
  )
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (samePaneOwnsRecovery && entry.paneKey === record.paneKey) {
      continue
    }
    if (
      worktreeTabIds.has(getAgentStatusTabId(entry) ?? '') &&
      entry.worktreeId === record.worktreeId &&
      entry.agentType === record.agent &&
      entry.state !== 'done' &&
      agentProviderSessionsEqual(record.agent, entry.providerSession, record.providerSession)
    ) {
      return true
    }
  }
  for (const [tabId, startup] of Object.entries(state.pendingStartupByTabId)) {
    if (
      worktreeTabIds.has(tabId) &&
      startup.launchAgent === record.agent &&
      agentProviderSessionsEqual(
        record.agent,
        startup.resumeProviderSession,
        record.providerSession
      )
    ) {
      return true
    }
  }
  for (const [tabId, claim] of Object.entries(state.automaticAgentResumeClaimsByTabId)) {
    if (
      worktreeTabIds.has(tabId) &&
      claim.worktreeId === record.worktreeId &&
      claim.launchAgent === record.agent &&
      agentProviderSessionsEqual(record.agent, claim.providerSession, record.providerSession)
    ) {
      return true
    }
  }
  return false
}

export function requestHydratedRecoveryRecords(
  worktreeId: string,
  records: readonly SleepingAgentSessionRecord[],
  options?: ResumeSleepingAgentSessionsOptions
): void {
  const state = useAppStore.getState()
  const affectedClaims = new Map<string, SleepingAgentSessionRecord>()
  for (const record of records) {
    if (
      record.worktreeId === worktreeId &&
      !isInvalidWorktreeActivationRecord(record) &&
      !isPassiveCompletedHibernationEvidence(record)
    ) {
      affectedClaims.set(getProviderSessionClaimKey(record), record)
    }
  }
  const recordsToMount = new Set<SleepingAgentSessionRecord>()
  const tabIdsToMount = new Set<string>()
  for (const [claimKey, identity] of affectedClaims) {
    if (options?.skipClaimKeys?.has(claimKey)) {
      continue
    }
    const claimRecords = getSleepingAgentRecordsForProviderClaim(state, identity).filter(
      (record) =>
        record.worktreeId === worktreeId &&
        state.sleepingAgentSessionsByPaneKey[record.paneKey] === record
    )
    const canonical = getCanonicalStableRecordsByClaimKey(claimRecords).get(claimKey)
    if (
      !canonical ||
      canonical.automaticResumeBlockedBy === 'legacy-orchestration-worker' ||
      recordWaitsForRecoveryTopology(canonical, state)
    ) {
      continue
    }
    const tabId = getPreservedStablePaneRecoveryTabId(canonical, state)
    if (
      !tabId ||
      recoveryTopologyRecordWasRequested(canonical, state) ||
      activeOrQueuedResumeClaimsProviderSession(canonical, state, true)
    ) {
      continue
    }
    recordsToMount.add(canonical)
    tabIdsToMount.add(tabId)
  }
  if (tabIdsToMount.size === 0) {
    return
  }
  markRecoveryTopologyRecordsRequested(recordsToMount, state)
  requestBackgroundTerminalWorktreeMount({
    worktreeId,
    tabIds: [...tabIdsToMount]
  })
}
