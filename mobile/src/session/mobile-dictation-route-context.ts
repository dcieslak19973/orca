import { useCallback, useMemo, useRef } from 'react'

export type MobileDictationRouteContext = {
  readonly handle: string | null
  readonly liveInputEnabled: boolean
  readonly routeGeneration: symbol
  readonly showNativeChat: boolean
}

type MobileDictationRouteContextRef = {
  current: MobileDictationRouteContext | null
}

type MobileDictationRouteContextController = {
  readonly capture: (
    handle: string | null,
    liveInputTerminalHandles: ReadonlySet<string>
  ) => MobileDictationRouteContext
  readonly clear: (expected?: MobileDictationRouteContext) => void
  readonly consume: () => MobileDictationRouteContext | null
}

export function consumeCurrentMobileDictationRouteContext(
  contextRef: MobileDictationRouteContextRef,
  routeGeneration: symbol
): MobileDictationRouteContext | null {
  const context = contextRef.current
  contextRef.current = null
  return context?.routeGeneration === routeGeneration ? context : null
}

export function useMobileDictationRouteContext(
  inputProducerGeneration: symbol,
  showNativeChat: boolean
): MobileDictationRouteContextController {
  const contextRef = useRef<MobileDictationRouteContext | null>(null)
  const routeGeneration = useMemo(
    () => Symbol('mobile-dictation-route-generation'),
    [inputProducerGeneration, showNativeChat]
  )
  const capture = useCallback(
    (handle: string | null, liveInputTerminalHandles: ReadonlySet<string>) => {
      const context = {
        handle,
        liveInputEnabled: handle ? liveInputTerminalHandles.has(handle) : false,
        routeGeneration,
        showNativeChat
      }
      contextRef.current = context
      return context
    },
    [routeGeneration, showNativeChat]
  )
  const clear = useCallback((expected?: MobileDictationRouteContext) => {
    if (!expected || contextRef.current === expected) {
      contextRef.current = null
    }
  }, [])
  const consume = useCallback(
    () => consumeCurrentMobileDictationRouteContext(contextRef, routeGeneration),
    [routeGeneration]
  )
  return useMemo(() => ({ capture, clear, consume }), [capture, clear, consume])
}
