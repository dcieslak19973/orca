import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'

type TerminalBufferedInputSend = (
  send: () => Promise<unknown>,
  onRejected: () => void
) => Promise<boolean>

export function useTerminalBufferedInputSend(inputScope: string): TerminalBufferedInputSend {
  const inputGeneration = useMemo(() => Symbol('terminal-buffered-input-generation'), [inputScope])
  const committedInputGenerationRef = useRef(inputGeneration)
  const sendingInputGenerationRef = useRef<symbol | null>(null)

  useLayoutEffect(() => {
    committedInputGenerationRef.current = inputGeneration
    if (sendingInputGenerationRef.current !== inputGeneration) {
      sendingInputGenerationRef.current = null
    }
  }, [inputGeneration])

  return useCallback(
    async (send, onRejected): Promise<boolean> => {
      if (
        committedInputGenerationRef.current !== inputGeneration ||
        sendingInputGenerationRef.current === inputGeneration
      ) {
        return false
      }
      sendingInputGenerationRef.current = inputGeneration
      try {
        await send()
      } catch {
        if (
          committedInputGenerationRef.current === inputGeneration &&
          sendingInputGenerationRef.current === inputGeneration
        ) {
          onRejected()
        }
      } finally {
        if (sendingInputGenerationRef.current === inputGeneration) {
          sendingInputGenerationRef.current = null
        }
      }
      return true
    },
    [inputGeneration]
  )
}
