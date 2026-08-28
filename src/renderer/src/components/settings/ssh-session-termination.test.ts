import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
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
    terminateSessions: vi.fn().mockResolvedValue({ status: 'exited' }),
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
      terminateSessions: vi
        .fn()
        .mockResolvedValue({ status: 'unverifiable', reason: 'the relay is offline' })
    })

    await expect(terminateSshSessionsWithReconnect('ssh-1')).resolves.toEqual({
      status: 'unverifiable',
      reason: 'the relay is offline'
    })
  })

  it('returns the retry result after a reconnect-required failure', async () => {
    const terminateSessions = vi
      .fn()
      .mockRejectedValueOnce(new Error(`${SSH_TERMINATE_RECONNECT_REQUIRED}: relay detached`))
      .mockResolvedValueOnce({ status: 'exited' })
    const ssh = installApi({ terminateSessions })

    await expect(terminateSshSessionsWithReconnect('ssh-1')).resolves.toEqual({
      status: 'exited'
    })
    expect(ssh.connect).toHaveBeenCalledWith({ targetId: 'ssh-1' })
    expect(terminateSessions).toHaveBeenCalledTimes(2)
  })
})

describe('describeTerminateOutcome', () => {
  // Why (#12661): offline expired-only terminate must not be presented as a
  // successful remote kill.
  it('warns with the unverifiable reason instead of claiming success', () => {
    const outcome = describeTerminateOutcome({
      status: 'unverifiable',
      reason: SSH_PROVIDER_UNREGISTERED_REASON
    })

    expect(outcome.tone).toBe('warning')
    expect(outcome.message).toContain('could not be confirmed stopped')
    expect(outcome.message).toContain(SSH_PROVIDER_UNREGISTERED_REASON)
    // The warning must tell the user how to finish the job, not just that it failed.
    expect(outcome.message).toContain('Reconnect and end remote terminals again')
  })

  it('reports success when every session was reachable', () => {
    const outcome = describeTerminateOutcome({ status: 'exited' })

    expect(outcome.tone).toBe('success')
    expect(outcome.message).toBe('Remote terminals ended')
  })
})
