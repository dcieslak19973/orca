import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'
import {
  describeTerminateOutcome,
  terminateSshSessionsWithReconnect
} from './ssh-session-termination'

type SshApi = {
  terminateSessions: Mock
  connect: Mock
}

function installApi(overrides: Partial<SshApi> = {}): SshApi {
  const ssh: SshApi = {
    terminateSessions: vi.fn().mockResolvedValue({ unreachableExpired: 0 }),
    connect: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
  vi.stubGlobal('window', { api: { ssh } })
  return ssh
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('terminateSshSessionsWithReconnect', () => {
  it('passes the handler result through', async () => {
    installApi({
      terminateSessions: vi.fn().mockResolvedValue({ unreachableExpired: 2 })
    })

    await expect(terminateSshSessionsWithReconnect('ssh-1')).resolves.toEqual({
      unreachableExpired: 2
    })
  })

  it('returns the retry result after a reconnect-required failure', async () => {
    const terminateSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error(`${SSH_TERMINATE_RECONNECT_REQUIRED}: relay detached`))
      .mockResolvedValueOnce({ unreachableExpired: 0 })
    const ssh = installApi({ terminateSessions })

    await expect(terminateSshSessionsWithReconnect('ssh-1')).resolves.toEqual({
      unreachableExpired: 0
    })
    expect(ssh.connect).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(terminateSessions).toHaveBeenCalledTimes(2)
  })
})

describe('describeTerminateOutcome', () => {
  // Why (#12661): offline expired-only terminate must not be presented as a
  // successful remote kill.
  it('warns with the unreachable count instead of claiming success', () => {
    const outcome = describeTerminateOutcome({ unreachableExpired: 3 })

    expect(outcome.tone).toBe('warning')
    expect(outcome.message).toContain('3')
    expect(outcome.message).toContain('could not be stopped')
  })

  it('reports success when every session was reachable', () => {
    const outcome = describeTerminateOutcome({ unreachableExpired: 0 })

    expect(outcome.tone).toBe('success')
    expect(outcome.message).toBe('Remote terminals ended')
  })
})
