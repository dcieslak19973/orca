import { useCallback, useEffect, useMemo, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { getTerminalLiveSpecialKeyDecision } from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type {
  TerminalLiveInputBoundarySender,
  TerminalLiveInputSender
} from './terminal-live-input-sender'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'
import {
  useTerminalLiveAccessoryInputCommit,
  type TerminalLiveAccessoryInputCommitResult
} from './use-terminal-live-accessory-input-commit'

type TerminalLiveInputKeyPressEvent = {
  readonly nativeEvent: {
    readonly key: string
  }
}

type TerminalLiveInputCommitOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly connected: boolean
  readonly inputStateReady: boolean
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputScope: string
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

type TerminalLiveInputCommitHandlers = {
  readonly clearPendingLiveInputCommit: () => void
  readonly handleLiveInputAccessoryBytes: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly handleLiveInputChange: (text: string) => void
  readonly handleLiveInputKeyPress: (event: TerminalLiveInputKeyPressEvent) => void
  readonly handleLiveInputSubmit: () => void
  readonly liveInputProducerGeneration: symbol
  readonly sendLiveInputExternalBoundary: TerminalLiveInputBoundarySender
}

export function useTerminalLiveInputCommit<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  connected,
  inputStateReady,
  liveInputRef,
  liveInputScope,
  liveInputTerminalHandles,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLiveInputCommitOptions<TTabType>): TerminalLiveInputCommitHandlers {
  const liveInputProducerOwner =
    inputStateReady && (activeSessionTabType == null || activeSessionTabType === 'terminal')
      ? activeHandle
      : null
  const liveInputOwner =
    liveInputProducerOwner && liveInputTerminalHandles.has(liveInputProducerOwner)
      ? liveInputProducerOwner
      : null
  // Buffered producers share the boundary queue, so terminal changes must detach it even with live input off.
  const liveInputGeneration = useMemo(
    () => Symbol('terminal-live-input-generation'),
    [liveInputOwner, liveInputProducerOwner, liveInputScope]
  )
  const liveInputProducerGeneration = useMemo(
    () => Symbol('terminal-live-input-producer-generation'),
    [connected, liveInputGeneration]
  )
  const {
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    heldLiveInputTextRef,
    isLiveInputProducerCurrent,
    pendingLiveInputHandleRef,
    reconcileLiveInputAfterDisconnect,
    runLiveInputBoundary,
    sentLiveInputTextRef,
    waitForPendingLiveInputFlush
  } = useTerminalLivePendingInputFlush({
    activeHandleRef,
    activeSessionTabTypeRef,
    inputStateReady,
    liveInputRef,
    liveInputGeneration,
    liveInputProducerGeneration,
    liveInputTerminalHandlesRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })

  useEffect(() => {
    // Why: unsent kana is safe to retain; sent prefixes and timer-held text are ambiguous after an outage.
    if (!connected) {
      reconcileLiveInputAfterDisconnect()
    }
  }, [connected, reconcileLiveInputAfterDisconnect])

  useEffect(() => {
    const pendingHandle = pendingLiveInputHandleRef.current
    if (!pendingHandle) {
      return
    }
    // Why: a lagging mobile tab list briefly yields no active tab object; a
    // null/undefined type is "unknown", not "left the terminal" — flush guards
    // still block sends if the tab truly changed.
    if (
      !activeHandle ||
      pendingHandle !== activeHandle ||
      (activeSessionTabType != null && activeSessionTabType !== 'terminal') ||
      !liveInputTerminalHandles.has(activeHandle)
    ) {
      clearPendingLiveInputCommit()
    }
  }, [activeHandle, activeSessionTabType, clearPendingLiveInputCommit, liveInputTerminalHandles])

  const sendLiveInputExternalBoundary = useCallback<TerminalLiveInputBoundarySender>(
    (handle, sendBoundary) => runLiveInputBoundary(handle, sendBoundary),
    [runLiveInputBoundary]
  )

  const handleLiveInputChange = useCallback(
    (text: string) => {
      if (!isLiveInputProducerCurrent()) {
        return
      }
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommit()
        return
      }
      // Why: iOS kills an active dictation/IME session when JS writes a value
      // that differs from the native field text, so the controlled capture must
      // echo the field verbatim; only the PTY mirror sees normalized text.
      setLiveInputCapture(text)
      applyLiveInputMirror(activeHandle, normalizeTerminalTextInput(text))
    },
    [
      activeHandle,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      isLiveInputProducerCurrent,
      liveInputTerminalHandles,
      setLiveInputCapture
    ]
  )

  const handleLiveInputKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      if (!isLiveInputProducerCurrent()) {
        return
      }
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommit()
      }
      const decision = getTerminalLiveSpecialKeyDecision({
        key: event.nativeEvent.key,
        heldText: ownsPendingState ? heldLiveInputTextRef.current : '',
        sentText: ownsPendingState ? sentLiveInputTextRef.current : ''
      })
      switch (decision.kind) {
        case 'ignore':
        case 'local-edit':
          return
        case 'send-now':
        case 'commit-held-then-send':
          void runLiveInputBoundary(activeHandle, () =>
            sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      clearPendingLiveInputCommit,
      isLiveInputProducerCurrent,
      liveInputTerminalHandles,
      runLiveInputBoundary,
      sendLiveTerminalInputRef
    ]
  )

  const handleLiveInputAccessoryBytes = useTerminalLiveAccessoryInputCommit({
    activeHandle,
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    heldLiveInputTextRef,
    isLiveInputProducerCurrent,
    liveInputRef,
    liveInputTerminalHandles,
    pendingLiveInputHandleRef,
    runLiveInputBoundary,
    sentLiveInputTextRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture,
    waitForPendingLiveInputFlush
  })

  const handleLiveInputSubmit = useCallback(() => {
    if (
      !isLiveInputProducerCurrent() ||
      !activeHandle ||
      !liveInputTerminalHandles.has(activeHandle)
    ) {
      return
    }
    void runLiveInputBoundary(activeHandle, () =>
      sendLiveTerminalInputRef.current(activeHandle, '\r')
    )
  }, [
    activeHandle,
    isLiveInputProducerCurrent,
    liveInputTerminalHandles,
    runLiveInputBoundary,
    sendLiveTerminalInputRef
  ])

  return {
    clearPendingLiveInputCommit,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit,
    liveInputProducerGeneration,
    sendLiveInputExternalBoundary
  }
}
