import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'

type AuthorityListener = () => void

const listenersByEnvironmentAndPty = new Map<string, Set<AuthorityListener>>()
const listenersByEnvironmentAndSshTarget = new Map<string, Set<AuthorityListener>>()
const listenersByEnvironment = new Map<string, Set<AuthorityListener>>()

function authorityKey(environmentId: string, identity: string): string {
  return `${environmentId}\0${identity}`
}

function addListener(
  index: Map<string, Set<AuthorityListener>>,
  key: string,
  listener: AuthorityListener
): void {
  const listeners = index.get(key) ?? new Set()
  listeners.add(listener)
  index.set(key, listeners)
}

function removeListener(
  index: Map<string, Set<AuthorityListener>>,
  key: string,
  listener: AuthorityListener
): void {
  const listeners = index.get(key)
  listeners?.delete(listener)
  if (listeners?.size === 0) {
    index.delete(key)
  }
}

function dispatch(index: Map<string, Set<AuthorityListener>>, key: string): void {
  for (const listener of index.get(key) ?? []) {
    listener()
  }
}

export function subscribeRuntimeTerminalAuthority(
  environmentId: string,
  ptyId: string,
  listener: AuthorityListener
): () => void {
  const ptyKey = authorityKey(environmentId, ptyId)
  const environmentKey = authorityKey(environmentId, '')
  const sshTarget = parseAppSshPtyId(ptyId)?.connectionId
  const sshKey = sshTarget ? authorityKey(environmentId, sshTarget) : null
  addListener(listenersByEnvironmentAndPty, ptyKey, listener)
  addListener(listenersByEnvironment, environmentKey, listener)
  if (sshKey) {
    addListener(listenersByEnvironmentAndSshTarget, sshKey, listener)
  }
  let active = true
  return () => {
    if (!active) {
      return
    }
    active = false
    removeListener(listenersByEnvironmentAndPty, ptyKey, listener)
    removeListener(listenersByEnvironment, environmentKey, listener)
    if (sshKey) {
      removeListener(listenersByEnvironmentAndSshTarget, sshKey, listener)
    }
  }
}

export function dispatchRuntimeTerminalAuthorityEvent(
  environmentId: string,
  event: RuntimeClientEvent
): void {
  if (event.type === 'terminalLivenessAuthorityChanged') {
    dispatch(listenersByEnvironmentAndPty, authorityKey(environmentId, event.ptyId))
    return
  }
  if (event.type === 'sshStateChanged' && event.state.status === 'connected') {
    dispatch(listenersByEnvironmentAndSshTarget, authorityKey(environmentId, event.targetId))
  }
}

export function dispatchRuntimeTerminalAuthorityReconnect(environmentId: string): void {
  dispatch(listenersByEnvironment, authorityKey(environmentId, ''))
}
