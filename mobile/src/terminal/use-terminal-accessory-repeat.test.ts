import { createElement, startTransition, Suspense } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalAccessoryRepeat } from './use-terminal-accessory-repeat'

type RepeatControls = ReturnType<typeof useTerminalAccessoryRepeat<string>>

const NEVER_RESOLVES = new Promise<void>(() => undefined)

function suppressRendererWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
      originalConsoleError(...args)
    }
  })
  return () => spy.mockRestore()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('terminal accessory repeat', () => {
  it('keeps the committed callback when a replacement render is abandoned', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    const handleW1 = vi.fn(async () => undefined)
    const handleW2 = vi.fn(async () => undefined)
    let controls: RepeatControls | null = null

    function Harness({ route, suspend }: { route: 'w1' | 'w2'; suspend?: boolean }): null {
      controls = useTerminalAccessoryRepeat(route === 'w1' ? handleW1 : handleW2)
      if (suspend) {
        throw NEVER_RESOLVES
      }
      return null
    }

    const render = (route: 'w1' | 'w2', suspend = false) =>
      createElement(Suspense, { fallback: null }, createElement(Harness, { route, suspend }))
    let renderer: ReactTestRenderer | null = null
    const restoreConsoleError = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(render('w1'), { unstable_isConcurrent: true } as never)
      })
    } finally {
      restoreConsoleError()
    }
    if (!controls) {
      throw new Error('terminal accessory repeat hook did not render')
    }

    controls.startAccessoryRepeat('left')
    await act(async () => {
      startTransition(() => renderer?.update(render('w2', true)))
      await Promise.resolve()
    })
    await act(async () => vi.advanceTimersByTimeAsync(445))

    expect(handleW1).toHaveBeenCalledWith('left')
    expect(handleW2).not.toHaveBeenCalled()
    act(() => renderer?.unmount())
  })

  it('stops an armed repeat before a reused route can receive it', async () => {
    vi.useFakeTimers()
    const handleW1 = vi.fn(async () => undefined)
    const handleW2 = vi.fn(async () => undefined)
    let route: 'w1' | 'w2' = 'w1'
    let controls: RepeatControls | null = null
    let renderer: ReactTestRenderer | null = null

    function Harness(): null {
      controls = useTerminalAccessoryRepeat(route === 'w1' ? handleW1 : handleW2)
      return null
    }

    const restoreConsoleError = suppressRendererWarning()
    try {
      act(() => {
        renderer = create(createElement(Harness))
      })
    } finally {
      restoreConsoleError()
    }
    if (!controls) {
      throw new Error('terminal accessory repeat hook did not render')
    }

    controls.startAccessoryRepeat('down')
    controls.stopAccessoryRepeat()
    route = 'w2'
    act(() => renderer?.update(createElement(Harness)))
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(handleW1).not.toHaveBeenCalled()
    expect(handleW2).not.toHaveBeenCalled()
    act(() => renderer?.unmount())
  })
})
