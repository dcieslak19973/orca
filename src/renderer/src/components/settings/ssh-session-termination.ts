import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'
import { translate } from '@/i18n/i18n'

export type TerminateSshSessionsResult = { unreachableExpired: number }

export async function terminateSshSessionsWithReconnect(
  targetId: string
): Promise<TerminateSshSessionsResult> {
  try {
    return await window.api.ssh.terminateSessions({ targetId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes(SSH_TERMINATE_RECONNECT_REQUIRED)) {
      throw err
    }
    // Why: disconnect is now non-destructive, so preserved remote PTYs may
    // require a fresh relay attachment before they can be explicitly killed.
    await window.api.ssh.connect({ targetId })
    return await window.api.ssh.terminateSessions({ targetId })
  }
}

/**
 * Why (#12661): offline with only expired leases, terminate finishes local
 * cleanup but cannot reach the remote shells — that outcome must never be
 * presented as a successful remote kill.
 */
export function describeTerminateOutcome(result: TerminateSshSessionsResult): {
  tone: 'success' | 'warning'
  message: string
} {
  if (result.unreachableExpired > 0) {
    return {
      tone: 'warning',
      message: translate(
        'auto.components.settings.SshPane.terminateUnreachableExpired',
        'Local cleanup done, but {{value0}} remote session(s) could not be stopped — the relay is offline. Reconnect and end remote terminals again.',
        { value0: result.unreachableExpired }
      )
    }
  }
  return {
    tone: 'success',
    message: translate('auto.components.settings.SshPane.90e308c98b', 'Remote terminals ended')
  }
}
