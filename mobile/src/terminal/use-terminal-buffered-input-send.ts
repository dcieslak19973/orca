import { useCallback, useLayoutEffect, useRef } from 'react'
import type { MobileTerminalBufferedInputSendOutcome } from './mobile-terminal-buffered-input-send'

type TerminalBufferedInputSend = (
  send: () => Promise<MobileTerminalBufferedInputSendOutcome>,
  onRejected: () => void,
  onUnknown: () => void
) => Promise<boolean>

export function useTerminalBufferedInputSend(inputGeneration: symbol): TerminalBufferedInputSend {
  const committedInputGenerationRef = useRef(inputGeneration)
  const sendingInputGenerationRef = useRef<symbol | null>(null)

  useLayoutEffect(() => {
    committedInputGenerationRef.current = inputGeneration
    if (sendingInputGenerationRef.current !== inputGeneration) {
      sendingInputGenerationRef.current = null
    }
  }, [inputGeneration])

  return useCallback(
    async (send, onRejected, onUnknown): Promise<boolean> => {
      if (
        committedInputGenerationRef.current !== inputGeneration ||
        sendingInputGenerationRef.current === inputGeneration
      ) {
        return false
      }
      sendingInputGenerationRef.current = inputGeneration
      let outcome: MobileTerminalBufferedInputSendOutcome = 'unknown'
      try {
        outcome = await send()
      } catch {
        outcome = 'unknown'
      } finally {
        const isCurrent =
          committedInputGenerationRef.current === inputGeneration &&
          sendingInputGenerationRef.current === inputGeneration
        if (isCurrent && outcome === 'rejected') {
          onRejected()
        } else if (isCurrent && outcome === 'unknown') {
          onUnknown()
        }
        if (sendingInputGenerationRef.current === inputGeneration) {
          sendingInputGenerationRef.current = null
        }
      }
      return true
    },
    [inputGeneration]
  )
}
