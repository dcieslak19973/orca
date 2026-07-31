import { useAppStore } from '@/store'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export type TerminalPaneAuthorityTopology = {
  tabs: AppStoreState['tabsByWorktree'][string] | undefined
  tab: AppStoreState['tabsByWorktree'][string][number] | undefined
  ptyIds: AppStoreState['ptyIdsByTabId'][string] | undefined
  layout: AppStoreState['terminalLayoutsByTabId'][string] | undefined
  record: AppStoreState['sleepingAgentSessionsByPaneKey'][string] | undefined
}

type AuthorityRecoveryRegistration = {
  worktreeId: string
  tabId: string
  paneKey: string
  ptyId: string
  initial: TerminalPaneAuthorityTopology
  recover: () => void
  active: boolean
}

const registrations = new Set<AuthorityRecoveryRegistration>()
const registrationsByPtyId = new Map<string, Set<AuthorityRecoveryRegistration>>()
let unsubscribeStore: (() => void) | null = null
let unsubscribeAuthority: (() => void) | null = null
let storeSubscriptionEpoch = 0
let queuedTopologyState: { epoch: number; state: AppStoreState } | null = null
let topologyDrainQueued = false

function addToIndex(
  index: Map<string, Set<AuthorityRecoveryRegistration>>,
  key: string,
  registration: AuthorityRecoveryRegistration
): void {
  const entries = index.get(key) ?? new Set()
  entries.add(registration)
  index.set(key, entries)
}

function removeFromIndex(
  index: Map<string, Set<AuthorityRecoveryRegistration>>,
  key: string,
  registration: AuthorityRecoveryRegistration
): void {
  const entries = index.get(key)
  entries?.delete(registration)
  if (entries?.size === 0) {
    index.delete(key)
  }
}

function stopSubscriptionsIfIdle(): void {
  if (registrations.size > 0) {
    return
  }
  unsubscribeStore?.()
  unsubscribeAuthority?.()
  unsubscribeStore = null
  unsubscribeAuthority = null
  storeSubscriptionEpoch += 1
}

function removeRegistration(registration: AuthorityRecoveryRegistration): void {
  if (!registration.active) {
    return
  }
  registration.active = false
  registrations.delete(registration)
  removeFromIndex(registrationsByPtyId, registration.ptyId, registration)
  stopSubscriptionsIfIdle()
}

export function captureTerminalPaneAuthorityTopology(
  worktreeId: string,
  tabId: string,
  paneKey: string,
  state = useAppStore.getState()
): TerminalPaneAuthorityTopology {
  const tabs = state.tabsByWorktree[worktreeId]
  return {
    tabs,
    tab: tabs?.find((candidate) => candidate.id === tabId),
    ptyIds: state.ptyIdsByTabId[tabId],
    layout: state.terminalLayoutsByTabId[tabId],
    record: state.sleepingAgentSessionsByPaneKey[paneKey]
  }
}

function topologyChanged(
  registration: AuthorityRecoveryRegistration,
  state: AppStoreState
): boolean {
  if (
    state.ptyIdsByTabId[registration.tabId] !== registration.initial.ptyIds ||
    state.terminalLayoutsByTabId[registration.tabId] !== registration.initial.layout ||
    state.sleepingAgentSessionsByPaneKey[registration.paneKey] !== registration.initial.record
  ) {
    return true
  }
  const tabs = state.tabsByWorktree[registration.worktreeId]
  return (
    tabs !== registration.initial.tabs &&
    tabs?.find((candidate) => candidate.id === registration.tabId) !== registration.initial.tab
  )
}

function recoverRegistration(registration: AuthorityRecoveryRegistration): void {
  if (!registration.active) {
    return
  }
  removeRegistration(registration)
  registration.recover()
}

function queueTopologyDrain(state: AppStoreState, epoch: number): void {
  queuedTopologyState = { epoch, state }
  if (topologyDrainQueued) {
    return
  }
  topologyDrainQueued = true
  queueMicrotask(() => {
    topologyDrainQueued = false
    const queued = queuedTopologyState
    queuedTopologyState = null
    if (!queued || queued.epoch !== storeSubscriptionEpoch || registrations.size === 0) {
      return
    }
    for (const registration of registrations) {
      if (topologyChanged(registration, queued.state)) {
        recoverRegistration(registration)
      }
    }
  })
}

function ensureSubscriptions(): void {
  if (!unsubscribeStore) {
    const epoch = ++storeSubscriptionEpoch
    unsubscribeStore = useAppStore.subscribe((state, previousState) => {
      if (
        state.ptyIdsByTabId !== previousState.ptyIdsByTabId ||
        state.terminalLayoutsByTabId !== previousState.terminalLayoutsByTabId ||
        state.tabsByWorktree !== previousState.tabsByWorktree ||
        state.sleepingAgentSessionsByPaneKey !== previousState.sleepingAgentSessionsByPaneKey
      ) {
        queueTopologyDrain(state, epoch)
      }
    })
  }
  unsubscribeAuthority ??=
    window.api.pty.onLivenessAuthorityChanged?.((payload) => {
      for (const registration of registrationsByPtyId.get(payload.id) ?? []) {
        recoverRegistration(registration)
      }
    }) ?? (() => {})
}

export function waitForTerminalPaneAuthorityChange(args: {
  worktreeId: string
  tabId: string
  paneKey: string
  ptyId: string
  initial: TerminalPaneAuthorityTopology
  initialAuthorityGeneration: number | null
  recover: () => void
}): () => void {
  const registration: AuthorityRecoveryRegistration = {
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    paneKey: args.paneKey,
    ptyId: args.ptyId,
    initial: args.initial,
    recover: args.recover,
    active: true
  }
  registrations.add(registration)
  addToIndex(registrationsByPtyId, args.ptyId, registration)
  ensureSubscriptions()

  if (
    args.initialAuthorityGeneration !== null &&
    window.api.pty.getPtyLivenessAuthorityGeneration
  ) {
    void window.api.pty
      .getPtyLivenessAuthorityGeneration(args.ptyId)
      .then((generation) => {
        if (generation !== args.initialAuthorityGeneration) {
          recoverRegistration(registration)
        }
      })
      .catch(() => {})
  }
  if (topologyChanged(registration, useAppStore.getState())) {
    recoverRegistration(registration)
  }
  return () => removeRegistration(registration)
}
