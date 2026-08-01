import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import {
  queueTerminalLiveHandleSend,
  queueTerminalLiveMirrorSend,
  type TerminalLivePendingFlushState
} from './terminal-live-pending-flush-state'

type MutableCell<T> = { current: T }

type TerminalLiveMirrorPayloadSendOptions = {
  readonly clearPendingLiveInputCommit: () => void
  readonly currentLiveInputGenerationRef: MutableCell<symbol>
  readonly disposedRef: MutableCell<boolean>
  readonly handle: string
  readonly inputScope: string
  readonly lifecycleEpoch: number
  readonly lifecycleEpochRef: MutableCell<number>
  readonly liveInputGeneration: symbol
  readonly payload: string
  readonly pendingLiveInputFlushRef: TerminalLivePendingFlushState
  readonly sendLiveTerminalInputRef: MutableCell<TerminalLiveInputSender>
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function queueTerminalLiveMirrorPayloadSend({
  clearPendingLiveInputCommit,
  currentLiveInputGenerationRef,
  disposedRef,
  handle,
  inputScope,
  lifecycleEpoch,
  lifecycleEpochRef,
  liveInputGeneration,
  payload,
  pendingLiveInputFlushRef,
  sendLiveTerminalInputRef,
  waitForPendingLiveInputFlush
}: TerminalLiveMirrorPayloadSendOptions): Promise<boolean> {
  if (payload.length === 0) {
    return waitForPendingLiveInputFlush()
  }
  const isCurrent = (): boolean =>
    !disposedRef.current &&
    lifecycleEpoch === lifecycleEpochRef.current &&
    liveInputGeneration === currentLiveInputGenerationRef.current
  const mirrorSend = queueTerminalLiveMirrorSend(pendingLiveInputFlushRef, () =>
    queueTerminalLiveHandleSend(inputScope, handle, () =>
      isCurrent() ? sendLiveTerminalInputRef.current(handle, payload) : Promise.resolve(false)
    )
  )
  void mirrorSend.then((sent) => {
    if (!sent && isCurrent()) {
      lifecycleEpochRef.current += 1
      pendingLiveInputFlushRef.current = null
      clearPendingLiveInputCommit()
    }
  })
  return mirrorSend
}
