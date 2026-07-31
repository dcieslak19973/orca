import { useCallback } from 'react'
import type { TerminalLiveInputBoundarySender } from '../terminal/terminal-live-input-sender'

type CurrentRef<T> = { readonly current: T }

type AttachmentInputLeaseGateArgs = {
  readonly sendLiveInputExternalBoundary: TerminalLiveInputBoundarySender
  readonly connStateRef: CurrentRef<string>
  readonly activeHandleRef: CurrentRef<string | null>
  readonly activeSessionTabTypeRef: CurrentRef<string | null>
  readonly nativeChatInputLeaseReadyRef: CurrentRef<boolean>
  readonly showToast: (message: string, durationMs?: number) => void
}

// Poll cadence + ceiling for riding out a terminal resubscribe (WS reconnect or
// return-to-terminal) during which the input lease is briefly not ready.
const LEASE_READY_POLL_MS = 100
const LEASE_READY_TIMEOUT_MS = 3000

/** Waits for the terminal lease, then reserves the attachment behind live input. */
export function useMobileAttachmentInputLeaseGate({
  sendLiveInputExternalBoundary,
  connStateRef,
  activeHandleRef,
  activeSessionTabTypeRef,
  nativeChatInputLeaseReadyRef,
  showToast
}: AttachmentInputLeaseGateArgs): TerminalLiveInputBoundarySender {
  return useCallback(
    async (targetHandle, sendBoundary): Promise<boolean> => {
      // Why: image picking/upload can outlive the original tab.
      if (
        connStateRef.current !== 'connected' ||
        targetHandle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        return false
      }
      const deadline = Date.now() + LEASE_READY_TIMEOUT_MS
      while (!nativeChatInputLeaseReadyRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, LEASE_READY_POLL_MS))
      }
      // Why: the wait can outlive the target too — re-check so a tab/host switch
      // or disconnect mid-wait doesn't send into the wrong (or dead) terminal.
      // A moved-away target drops silently like the pre-wait guard; only a lease
      // that never recovered warrants the toast.
      if (
        connStateRef.current !== 'connected' ||
        targetHandle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        return false
      }
      if (nativeChatInputLeaseReadyRef.current) {
        return sendLiveInputExternalBoundary(targetHandle, sendBoundary)
      }
      showToast('Attach failed (reconnecting)', 1500)
      return false
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      connStateRef,
      nativeChatInputLeaseReadyRef,
      sendLiveInputExternalBoundary,
      showToast
    ]
  )
}
