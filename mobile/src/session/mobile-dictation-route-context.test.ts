import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  consumeCurrentMobileDictationRouteContext,
  type MobileDictationRouteContext,
  useMobileDictationRouteContext
} from './mobile-dictation-route-context'

function context(routeGeneration: symbol): MobileDictationRouteContext {
  return { handle: 'terminal-a', liveInputEnabled: true, routeGeneration, showNativeChat: false }
}

describe('mobile dictation route context', () => {
  it('consumes a transcript context from the current input generation', () => {
    const generation = Symbol('worktree-a')
    const contextRef = { current: context(generation) }

    expect(consumeCurrentMobileDictationRouteContext(contextRef, generation)).toEqual({
      handle: 'terminal-a',
      liveInputEnabled: true,
      routeGeneration: generation,
      showNativeChat: false
    })
    expect(contextRef.current).toBeNull()
  })

  it('drops a context after route or ownership ABA returns to the same identity', () => {
    const originalGeneration = Symbol('worktree-a')
    const returnedGeneration = Symbol('worktree-a')
    const contextRef = { current: context(originalGeneration) }

    expect(consumeCurrentMobileDictationRouteContext(contextRef, returnedGeneration)).toBeNull()
    expect(contextRef.current).toBeNull()
  })

  it('drops a transcript when the visible composer changes', () => {
    const inputGeneration = Symbol('terminal-a')
    let showNativeChat = false
    let controller: ReturnType<typeof useMobileDictationRouteContext> | null = null
    let renderer: ReactTestRenderer | null = null
    function Harness(): null {
      controller = useMobileDictationRouteContext(inputGeneration, showNativeChat)
      return null
    }
    const originalConsoleError = console.error
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
        originalConsoleError(...args)
      }
    })
    try {
      act(() => {
        renderer = create(createElement(Harness))
      })
      const capturedController = controller
      if (!capturedController) {
        throw new Error('dictation route context hook did not render')
      }
      expect(capturedController.capture('terminal-a', new Set(['terminal-a'])).showNativeChat).toBe(
        false
      )

      showNativeChat = true
      act(() => renderer?.update(createElement(Harness)))

      expect(controller?.consume()).toBeNull()
    } finally {
      act(() => renderer?.unmount())
      errorSpy.mockRestore()
    }
  })
})
