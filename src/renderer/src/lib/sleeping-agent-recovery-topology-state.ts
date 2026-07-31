import type { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  getPreservedStablePaneRecoveryTabId,
  recordHasStablePaneIdentity
} from './sleeping-agent-pane-ownership'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export function recordWaitsForRecoveryTopology(
  record: SleepingAgentSessionRecord,
  state: AppStoreState
): boolean {
  return (
    (record.origin === 'live' || record.origin === 'quit' || record.origin === 'worktree-sleep') &&
    recordHasStablePaneIdentity(record) &&
    getPreservedStablePaneRecoveryTabId(record, state) === null
  )
}

export function collectChangedSleepingAgentPaneKeys(
  current: Record<string, SleepingAgentSessionRecord | undefined>,
  previous: Record<string, SleepingAgentSessionRecord | undefined>
): Set<string> {
  const changed = new Set<string>()
  for (const key of Object.keys(current)) {
    if (!(key in previous) || current[key] !== previous[key]) {
      changed.add(key)
    }
  }
  for (const key of Object.keys(previous)) {
    if (!(key in current)) {
      changed.add(key)
    }
  }
  return changed
}
