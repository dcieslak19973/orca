import { expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import {
  dispatchRuntimeTerminalAuthorityEvent,
  dispatchRuntimeTerminalAuthorityReconnect,
  subscribeRuntimeTerminalAuthority,
  subscribeRuntimeTerminalTopology
} from './runtime-terminal-authority-events'

it('routes authority, SSH reconnect, and runtime replay to matching waiters', () => {
  const exact = vi.fn()
  const sibling = vi.fn()
  const topology = vi.fn()
  const otherEnvironment = vi.fn()
  const ptyId = toAppSshPtyId('ssh-a', 'pty-1')
  const disposeExact = subscribeRuntimeTerminalAuthority('env-1', ptyId, exact)
  const disposeSibling = subscribeRuntimeTerminalAuthority(
    'env-1',
    toAppSshPtyId('ssh-b', 'pty-2'),
    sibling
  )
  const disposeOther = subscribeRuntimeTerminalAuthority('env-2', ptyId, otherEnvironment)
  const disposeTopology = subscribeRuntimeTerminalTopology('env-1', topology)

  dispatchRuntimeTerminalAuthorityEvent('env-1', {
    type: 'terminalLivenessAuthorityChanged',
    ptyId,
    generation: 1
  })
  expect(exact).toHaveBeenCalledOnce()
  expect(sibling).not.toHaveBeenCalled()
  expect(topology).toHaveBeenCalledOnce()
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
  expect(topology).toHaveBeenCalledOnce()

  dispatchRuntimeTerminalAuthorityReconnect('env-1')
  expect(exact).toHaveBeenCalledTimes(3)
  expect(sibling).toHaveBeenCalledOnce()
  expect(topology).toHaveBeenCalledTimes(2)
  expect(otherEnvironment).not.toHaveBeenCalled()

  disposeExact()
  disposeSibling()
  disposeOther()
  disposeTopology()
})
