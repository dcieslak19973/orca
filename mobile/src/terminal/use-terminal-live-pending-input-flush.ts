import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import {
  buildTerminalLiveMirrorPayload,
  computeTerminalLiveMirrorStep,
  getTerminalLiveHeldCommitPolicy,
  TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS
} from './terminal-live-composition-mirror'
import {
  queueTerminalLiveBoundarySend,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

type TerminalLivePendingInputFlushOptions<TTabType extends string> = {
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

type TerminalLivePendingInputFlush = {
  readonly applyLiveInputMirror: (handle: string, fieldText: string) => void
  readonly clearPendingLiveInputCommit: () => void
  readonly heldLiveInputTextRef: RefObject<string>
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly reconcileLiveInputAfterDisconnect: () => void
  readonly runLiveInputBoundary: (
    expectedHandle: string | null,
    sendBoundary: () => Promise<boolean>
  ) => Promise<boolean>
  readonly sentLiveInputTextRef: RefObject<string>
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function useTerminalLivePendingInputFlush<TTabType extends string>({
  activeHandleRef,
  activeSessionTabTypeRef,
  liveInputRef,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLivePendingInputFlushOptions<TTabType>): TerminalLivePendingInputFlush {
  const heldCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLiveInputFlushRef = useRef<Promise<boolean> | null>(null)
  const lifecycleEpochRef = useRef(0)
  const heldLiveInputTextRef = useRef('')
  const sentLiveInputTextRef = useRef('')
  const pendingLiveInputHandleRef = useRef<string | null>(null)
  const runMirrorStepRef = useRef<
    (handle: string, fieldText: string, commitHeld: boolean) => Promise<boolean>
  >(async () => false)

  const clearHeldCommitTimer = useCallback(() => {
    if (heldCommitTimerRef.current) {
      clearTimeout(heldCommitTimerRef.current)
      heldCommitTimerRef.current = null
    }
  }, [])

  const resetMirrorState = useCallback(() => {
    clearHeldCommitTimer()
    heldLiveInputTextRef.current = ''
    sentLiveInputTextRef.current = ''
    pendingLiveInputHandleRef.current = null
  }, [clearHeldCommitTimer])

  const clearPendingLiveInputCommit = useCallback(() => {
    resetMirrorState()
    setLiveInputCapture('')
    liveInputRef.current?.setNativeProps({ text: '' })
  }, [liveInputRef, resetMirrorState, setLiveInputCapture])

  const waitForPendingLiveInputFlush = useCallback(async (): Promise<boolean> => {
    return waitForTerminalLivePendingFlush(pendingLiveInputFlushRef)
  }, [])

  const reconcileLiveInputAfterDisconnect = useCallback(() => {
    // Why: pre-disconnect sends must not release queued control bytes after recovery.
    lifecycleEpochRef.current += 1
    const pendingHandle = pendingLiveInputHandleRef.current
    const heldCodePoint = Array.from(heldLiveInputTextRef.current).at(-1)?.codePointAt(0)
    const canPreserveUnsentKana =
      pendingHandle !== null &&
      pendingHandle === activeHandleRef.current &&
      (activeSessionTabTypeRef.current === null ||
        activeSessionTabTypeRef.current === 'terminal') &&
      liveInputTerminalHandlesRef.current.has(pendingHandle) &&
      sentLiveInputTextRef.current.length === 0 &&
      pendingLiveInputFlushRef.current === null &&
      heldCodePoint !== undefined &&
      getTerminalLiveHeldCommitPolicy(heldCodePoint) === 'boundary'
    if (canPreserveUnsentKana) {
      clearHeldCommitTimer()
      return
    }
    clearPendingLiveInputCommit()
  }, [
    activeHandleRef,
    activeSessionTabTypeRef,
    clearHeldCommitTimer,
    clearPendingLiveInputCommit,
    liveInputTerminalHandlesRef
  ])

  const runMirrorStep = useCallback(
    async (handle: string, fieldText: string, commitHeld: boolean): Promise<boolean> => {
      if (
        handle !== activeHandleRef.current ||
        (activeSessionTabTypeRef.current != null &&
          activeSessionTabTypeRef.current !== 'terminal') ||
        !liveInputTerminalHandlesRef.current.has(handle)
      ) {
        // Why: a stale handle must not keep local mirror state alive — the next
        // active terminal would inherit wrong erase counts. A null tab type is
        // "unknown" during tab-list lag, not "left the terminal", so it must not trip.
        resetMirrorState()
        return false
      }

      const step = computeTerminalLiveMirrorStep(sentLiveInputTextRef.current, fieldText, {
        commitHeld
      })
      sentLiveInputTextRef.current = step.nextSentText
      heldLiveInputTextRef.current = step.heldText
      pendingLiveInputHandleRef.current =
        step.heldText.length > 0 || step.nextSentText.length > 0 ? handle : null

      clearHeldCommitTimer()
      // Why: a 'boundary' hold is released by the next keystroke or an explicit
      // flush only. Arming a settle timer for it would race the flick keyboard's
      // modifier key and commit the base kana the user is about to replace.
      if (step.heldText.length > 0 && step.heldCommitPolicy === 'timer') {
        heldCommitTimerRef.current = setTimeout(() => {
          heldCommitTimerRef.current = null
          const heldField = sentLiveInputTextRef.current + heldLiveInputTextRef.current
          void runMirrorStepRef.current(handle, heldField, true)
        }, TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)
      }

      const payload = buildTerminalLiveMirrorPayload(step)
      if (payload.length === 0) {
        return waitForPendingLiveInputFlush()
      }
      const lifecycleEpoch = lifecycleEpochRef.current
      return queueTerminalLiveMirrorSend(pendingLiveInputFlushRef, () => {
        if (lifecycleEpoch !== lifecycleEpochRef.current) {
          return Promise.resolve(false)
        }
        return sendLiveTerminalInputRef.current(handle, payload)
      })
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      clearHeldCommitTimer,
      liveInputTerminalHandlesRef,
      resetMirrorState,
      sendLiveTerminalInputRef,
      waitForPendingLiveInputFlush
    ]
  )
  runMirrorStepRef.current = runMirrorStep

  const applyLiveInputMirror = useCallback(
    (handle: string, fieldText: string): void => {
      void runMirrorStep(handle, fieldText, false)
    },
    [runMirrorStep]
  )

  const runLiveInputBoundary = useCallback(
    (expectedHandle: string | null, sendBoundary: () => Promise<boolean>): Promise<boolean> => {
      if (expectedHandle !== null && expectedHandle !== activeHandleRef.current) {
        return Promise.resolve(false)
      }
      const lifecycleEpoch = lifecycleEpochRef.current
      const sendCurrentBoundary = (): Promise<boolean> => {
        return lifecycleEpoch === lifecycleEpochRef.current
          ? sendBoundary()
          : Promise.resolve(false)
      }
      const handle = pendingLiveInputHandleRef.current
      if (!handle) {
        return queueTerminalLiveBoundarySend(pendingLiveInputFlushRef, sendCurrentBoundary)
      }
      if (expectedHandle !== null && handle !== expectedHandle) {
        clearPendingLiveInputCommit()
        return queueTerminalLiveBoundarySend(pendingLiveInputFlushRef, sendCurrentBoundary)
      }
      if (
        handle !== activeHandleRef.current ||
        (activeSessionTabTypeRef.current != null &&
          activeSessionTabTypeRef.current !== 'terminal') ||
        !liveInputTerminalHandlesRef.current.has(handle)
      ) {
        clearPendingLiveInputCommit()
        return queueTerminalLiveBoundarySend(pendingLiveInputFlushRef, async () => false)
      }

      const heldField = sentLiveInputTextRef.current + heldLiveInputTextRef.current
      if (heldLiveInputTextRef.current.length > 0) {
        void runMirrorStep(handle, heldField, true)
      }
      const boundaryPromise = queueTerminalLiveBoundarySend(
        pendingLiveInputFlushRef,
        sendCurrentBoundary
      )
      // Why: reserve the old field's boundary before a new generation can queue.
      clearPendingLiveInputCommit()
      return boundaryPromise
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      clearPendingLiveInputCommit,
      liveInputTerminalHandlesRef,
      runMirrorStep
    ]
  )

  useEffect(() => {
    return () => {
      lifecycleEpochRef.current += 1
      if (heldCommitTimerRef.current) {
        clearTimeout(heldCommitTimerRef.current)
        heldCommitTimerRef.current = null
      }
      heldLiveInputTextRef.current = ''
      sentLiveInputTextRef.current = ''
      pendingLiveInputHandleRef.current = null
      pendingLiveInputFlushRef.current = null
    }
  }, [])

  return {
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    heldLiveInputTextRef,
    pendingLiveInputHandleRef,
    reconcileLiveInputAfterDisconnect,
    runLiveInputBoundary,
    sentLiveInputTextRef,
    waitForPendingLiveInputFlush
  }
}
