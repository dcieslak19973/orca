export function createSleepingAgentRecoveryDispatchBarrier<T>(
  dispatch: (state: T, previousState: T, maximumWaitGeneration: number) => void
): (state: T, previousState: T, maximumWaitGeneration: number) => void {
  let firstState: T | null = null
  let latestState: T | null = null
  let latestWaitGeneration = 0
  let queued = false
  return (state, previousState, maximumWaitGeneration) => {
    firstState ??= previousState
    latestState = state
    latestWaitGeneration = maximumWaitGeneration
    if (queued) {
      return
    }
    queued = true
    queueMicrotask(() => {
      queued = false
      const first = firstState
      const latest = latestState
      const waitGeneration = latestWaitGeneration
      firstState = null
      latestState = null
      if (first && latest) {
        dispatch(latest, first, waitGeneration)
      }
    })
  }
}
