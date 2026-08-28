import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'
import {
  describeUnconfirmedStop,
  type PtyLivenessVerdict
} from '../../../../shared/pty-liveness-verdict'
import { translate } from '@/i18n/i18n'

export async function terminateSshSessionsWithReconnect(
  targetId: string
): Promise<PtyLivenessVerdict> {
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
export function describeTerminateOutcome(verdict: PtyLivenessVerdict): {
  tone: 'success' | 'warning'
  message: string
} {
  if (verdict.status === 'exited') {
    return {
      tone: 'success',
      message: translate('auto.components.settings.SshPane.90e308c98b', 'Remote terminals ended')
    }
  }
  const detail =
    verdict.status === 'live'
      ? `${verdict.ptyIds.length} remote session(s) are still live`
      : describeUnconfirmedStop(verdict.reason)
  return {
    tone: 'warning',
    message: translate(
      'auto.components.settings.SshPane.terminateUnreachableExpired',
      'Local cleanup done, but the remote sessions could not be confirmed stopped. {{value0}} Reconnect and end remote terminals again.',
      { value0: detail }
    )
  }
}
