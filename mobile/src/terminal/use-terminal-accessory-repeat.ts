import { useCallback, useLayoutEffect, useRef } from 'react'

type TerminalAccessoryKeyHandler<TInput> = (input: TInput) => Promise<void>

type TerminalAccessoryRepeat<TInput> = {
  readonly startAccessoryRepeat: (input: TInput) => void
  readonly stopAccessoryRepeat: () => void
}

export function useTerminalAccessoryRepeat<TInput>(
  handleAccessoryKey: TerminalAccessoryKeyHandler<TInput>
): TerminalAccessoryRepeat<TInput> {
  const repeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const handleAccessoryKeyRef = useRef(handleAccessoryKey)

  useLayoutEffect(() => {
    handleAccessoryKeyRef.current = handleAccessoryKey
  }, [handleAccessoryKey])

  const stopAccessoryRepeat = useCallback(() => {
    if (repeatTimeoutRef.current) {
      clearTimeout(repeatTimeoutRef.current)
      repeatTimeoutRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
  }, [])

  const startAccessoryRepeat = useCallback(
    (input: TInput) => {
      stopAccessoryRepeat()
      repeatTimeoutRef.current = setTimeout(() => {
        repeatIntervalRef.current = setInterval(() => {
          void handleAccessoryKeyRef.current(input)
        }, 45)
      }, 400)
    },
    [stopAccessoryRepeat]
  )

  useLayoutEffect(() => stopAccessoryRepeat, [stopAccessoryRepeat])

  return { startAccessoryRepeat, stopAccessoryRepeat }
}
