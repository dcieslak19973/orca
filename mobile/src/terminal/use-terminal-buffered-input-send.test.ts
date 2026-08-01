import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { MobileTerminalBufferedInputSendOutcome } from './mobile-terminal-buffered-input-send'
import { useTerminalBufferedInputSend } from './use-terminal-buffered-input-send'

type DeferredOutcome = {
  readonly promise: Promise<MobileTerminalBufferedInputSendOutcome>
  readonly resolve: (outcome: MobileTerminalBufferedInputSendOutcome) => void
}

function createDeferredOutcome(): DeferredOutcome {
  let resolvePromise: DeferredOutcome['resolve'] = () => undefined
  const promise = new Promise<MobileTerminalBufferedInputSendOutcome>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function suppressRendererWarning(): () => void {
  const originalConsoleError = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] !== 'string' || !args[0].includes('react-test-renderer is deprecated')) {
      originalConsoleError(...args)
    }
  })
  return () => spy.mockRestore()
}

function createBufferedSendHarness() {
  let generation = Symbol('terminal-a-1')
  let runSend: ReturnType<typeof useTerminalBufferedInputSend> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    runSend = useTerminalBufferedInputSend(generation)
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

  return {
    get runSend() {
      if (!runSend) {
        throw new Error('terminal buffered-input hook did not render')
      }
      return runSend
    },
    setGeneration(label: string): void {
      generation = Symbol(label)
      act(() => renderer?.update(createElement(Harness)))
    },
    unmount(): void {
      act(() => renderer?.unmount())
    }
  }
}

describe('terminal buffered input send', () => {
  it('keeps A, B, and reused A ownership independent across deferred sends', async () => {
    const harness = createBufferedSendHarness()
    const a1 = createDeferredOutcome()
    const rejectedA1 = vi.fn()
    const unknownA1 = vi.fn()
    const sendA1 = harness.runSend(() => a1.promise, rejectedA1, unknownA1)

    harness.setGeneration('terminal-b')
    const rejectedB = vi.fn()
    await expect(harness.runSend(async () => 'accepted', rejectedB, vi.fn())).resolves.toBe(true)
    expect(rejectedB).not.toHaveBeenCalled()

    harness.setGeneration('terminal-a-2')
    const a2 = createDeferredOutcome()
    const rejectedA2 = vi.fn()
    const sendA2 = harness.runSend(() => a2.promise, rejectedA2, vi.fn())
    await expect(harness.runSend(async () => 'accepted', vi.fn(), vi.fn())).resolves.toBe(false)

    a1.resolve('rejected')
    await expect(sendA1).resolves.toBe(true)
    expect(rejectedA1).not.toHaveBeenCalled()
    expect(unknownA1).not.toHaveBeenCalled()
    await expect(harness.runSend(async () => 'accepted', vi.fn(), vi.fn())).resolves.toBe(false)

    a2.resolve('rejected')
    await expect(sendA2).resolves.toBe(true)
    expect(rejectedA2).toHaveBeenCalledOnce()
    await expect(harness.runSend(async () => 'accepted', vi.fn(), vi.fn())).resolves.toBe(true)
    harness.unmount()
  })

  it('reports only the current generation outcome', async () => {
    const harness = createBufferedSendHarness()
    const onRejected = vi.fn()
    const onUnknown = vi.fn()

    await expect(harness.runSend(async () => 'accepted', onRejected, onUnknown)).resolves.toBe(true)
    expect(onRejected).not.toHaveBeenCalled()
    expect(onUnknown).not.toHaveBeenCalled()

    await expect(harness.runSend(async () => 'rejected', onRejected, onUnknown)).resolves.toBe(true)
    expect(onRejected).toHaveBeenCalledOnce()

    await expect(harness.runSend(async () => 'unknown', onRejected, onUnknown)).resolves.toBe(true)
    await expect(
      harness.runSend(
        async () => {
          throw new Error('unexpected transport failure')
        },
        onRejected,
        onUnknown
      )
    ).resolves.toBe(true)
    expect(onUnknown).toHaveBeenCalledTimes(2)
    harness.unmount()
  })
})
