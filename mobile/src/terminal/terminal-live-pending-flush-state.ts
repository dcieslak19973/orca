export type TerminalLivePendingFlushState = {
  current: Promise<boolean> | null
}

export function waitForTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState
): Promise<boolean> {
  return state.current ?? Promise.resolve(true)
}

// Why: mirror payloads are erase/append deltas against the PTY echo. A skipped
// delta desyncs every later diff, so this chain runs each send even when the
// previous one failed. state.current should never reject; the catch keeps a
// future raw assignment from skipping a delta.
export function queueTerminalLiveMirrorSend(
  state: TerminalLivePendingFlushState,
  sendMirrorPayload: () => Promise<boolean>
): Promise<boolean> {
  const previousSend = state.current
  const sendPromise = (async () => {
    if (previousSend) {
      await previousSend.catch(() => false)
    }
    return sendMirrorPayload()
  })().catch(() => false)
  state.current = sendPromise
  void sendPromise.then(() => {
    if (state.current === sendPromise) {
      state.current = null
    }
  })
  return sendPromise
}

export function queueTerminalLiveBoundarySend(
  state: TerminalLivePendingFlushState,
  sendBoundary: () => Promise<boolean>
): Promise<boolean> {
  const previousSend = state.current
  const boundaryResult = (async () => {
    if (previousSend && !(await previousSend.catch(() => false))) {
      return false
    }
    return sendBoundary()
  })()
  const trackedBoundary = boundaryResult.catch(() => false)
  state.current = trackedBoundary
  void trackedBoundary.then(() => {
    if (state.current === trackedBoundary) {
      state.current = null
    }
  })
  return boundaryResult
}
