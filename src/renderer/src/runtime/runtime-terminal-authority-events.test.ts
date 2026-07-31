import { expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import {
  dispatchRuntimeTerminalAuthorityEvent,
  dispatchRuntimeTerminalAuthorityReconnect,
  subscribeRuntimeTerminalAuthority,
  subscribeRuntimeTerminalPaneAuthority
} from './runtime-terminal-authority-events'

it('routes authority, SSH reconnect, and runtime replay to matching waiters', () => {
  const exact = vi.fn()
  const sibling = vi.fn()
  const paneAuthority = vi.fn()
  const otherEnvironment = vi.fn()
  const ptyId = toAppSshPtyId('ssh-a', 'pty-1')
  const disposeExact = subscribeRuntimeTerminalAuthority('env-1', ptyId, exact)
  const disposeSibling = subscribeRuntimeTerminalAuthority(
    'env-1',
    toAppSshPtyId('ssh-b', 'pty-2'),
    sibling
  )
  const disposeOther = subscribeRuntimeTerminalAuthority('env-2', ptyId, otherEnvironment)
  const paneKey = 'tab-1:pane:1'
  const disposePaneAuthority = subscribeRuntimeTerminalPaneAuthority(
    'env-1',
    paneKey,
    paneAuthority,
    'ssh-a'
  )

  dispatchRuntimeTerminalAuthorityEvent('env-1', {
    type: 'terminalLivenessAuthorityChanged',
    ptyId,
    paneKey,
    generation: 1
  })
  expect(exact).toHaveBeenCalledOnce()
  expect(sibling).not.toHaveBeenCalled()
  expect(paneAuthority).toHaveBeenCalledOnce()
  expect(otherEnvironment).not.toHaveBeenCalled()

  dispatchRuntimeTerminalAuthorityEvent('env-1', {
    type: 'sshStateChanged',
    targetId: 'ssh-a',
    state: {
      targetId: 'ssh-a',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      connectionGeneration: 2
    }
  })
  expect(exact).toHaveBeenCalledTimes(2)
  expect(sibling).not.toHaveBeenCalled()
  expect(paneAuthority).toHaveBeenCalledTimes(2)

  dispatchRuntimeTerminalAuthorityReconnect('env-1')
  expect(exact).toHaveBeenCalledTimes(3)
  expect(sibling).toHaveBeenCalledOnce()
  expect(paneAuthority).toHaveBeenCalledTimes(3)
  expect(otherEnvironment).not.toHaveBeenCalled()

  disposeExact()
  disposeSibling()
  disposeOther()
  disposePaneAuthority()
})

it('routes a graph hydration burst only to matching pane identities', () => {
  const listeners = Array.from({ length: 100 }, () => vi.fn())
  const dispose = listeners.map((listener, index) =>
    subscribeRuntimeTerminalPaneAuthority('env-burst', `tab-${index}:pane:1`, listener)
  )

  for (let index = 0; index < listeners.length; index += 1) {
    dispatchRuntimeTerminalAuthorityEvent('env-burst', {
      type: 'terminalLivenessAuthorityChanged',
      ptyId: `pty-${index}`,
      paneKey: `tab-${index}:pane:1`,
      generation: index + 1
    })
  }

  expect(listeners.reduce((count, listener) => count + listener.mock.calls.length, 0)).toBe(100)
  dispose.forEach((unsubscribe) => unsubscribe())
})

it('does not fan out pane-less authority events to unrelated pane waiters', () => {
  const listeners = Array.from({ length: 100 }, () => vi.fn())
  const dispose = listeners.map((listener, index) =>
    subscribeRuntimeTerminalPaneAuthority('env-legacy', `tab-${index}:pane:1`, listener)
  )
  const exact = vi.fn()
  const disposeExact = subscribeRuntimeTerminalAuthority('env-legacy', 'pty-0', exact)

  for (let index = 0; index < listeners.length; index += 1) {
    dispatchRuntimeTerminalAuthorityEvent('env-legacy', {
      type: 'terminalLivenessAuthorityChanged',
      ptyId: `pty-${index}`,
      generation: index + 1
    })
  }

  expect(exact).toHaveBeenCalledOnce()
  expect(listeners.reduce((count, listener) => count + listener.mock.calls.length, 0)).toBe(0)
  dispose.forEach((unsubscribe) => unsubscribe())
  disposeExact()
})
