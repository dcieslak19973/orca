import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'

type DeferredBoolean = {
  readonly promise: Promise<boolean>
  readonly resolve: (value: boolean) => void
}

function createDeferredBoolean(): DeferredBoolean {
  let resolvePromise: (value: boolean) => void = () => undefined
  const promise = new Promise<boolean>((resolve) => {
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

function createOwnershipHarness() {
  const activeHandleRef: RefObject<string | null> = { current: 'terminal-a' }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const firstSend = createDeferredBoolean()
  const sent: string[] = []
  let liveInputGeneration = Symbol('live-input-generation')
  let liveInputProducerGeneration = Symbol('live-input-producer-generation')
  let handlers: ReturnType<typeof useTerminalLivePendingInputFlush<string>> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useTerminalLivePendingInputFlush({
      activeHandleRef,
      activeSessionTabTypeRef,
      inputStateReady: true,
      liveInputRef: { current: null } as RefObject<TextInput | null>,
      liveInputGeneration,
      liveInputProducerGeneration,
      liveInputTerminalHandlesRef: { current: new Set(['terminal-a', 'terminal-b']) },
      sendLiveTerminalInputRef: {
        current: async (_handle, bytes) => {
          sent.push(bytes)
          return sent.length === 1 ? firstSend.promise : true
        }
      } as RefObject<TerminalLiveInputSender>,
      setLiveInputCapture: () => undefined
    })
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
  if (!handlers || !renderer) {
    throw new Error('terminal live ownership hook did not render')
  }

  return {
    firstSend,
    get handlers() {
      if (!handlers) {
        throw new Error('terminal live ownership hook is unavailable')
      }
      return handlers
    },
    sent,
    setOwner(activeHandle: string, owner: string | null): void {
      activeHandleRef.current = activeHandle
      liveInputGeneration = Symbol(owner ?? 'live-input-disabled')
      liveInputProducerGeneration = Symbol(owner ?? 'live-input-disabled-producer')
      act(() => renderer?.update(createElement(Harness)))
    },
    setScope(scope: string): void {
      liveInputGeneration = Symbol(scope)
      liveInputProducerGeneration = Symbol(`${scope}-producer`)
      act(() => renderer?.update(createElement(Harness)))
    },
    unmount(): void {
      act(() => renderer?.unmount())
    }
  }
}

it('keeps a reused handle behind its started send while another handle stays independent', async () => {
  const harness = createOwnershipHarness()
  harness.handlers.applyLiveInputMirror('terminal-a', 'か')
  const staleBoundary = harness.handlers.runLiveInputBoundary('terminal-a', async () => {
    harness.sent.push('stale-a')
    return true
  })
  await vi.waitFor(() => expect(harness.sent).toEqual(['か']))

  harness.setOwner('terminal-b', 'terminal-b')
  const terminalBBoundary = harness.handlers.runLiveInputBoundary('terminal-b', async () => {
    harness.sent.push('terminal-b')
    return true
  })
  await expect(terminalBBoundary).resolves.toBe(true)

  harness.setOwner('terminal-a', 'terminal-a')
  const currentBoundary = harness.handlers.runLiveInputBoundary('terminal-a', async () => {
    harness.sent.push('current-a')
    return true
  })

  await Promise.resolve()
  expect(harness.sent).toEqual(['か', 'terminal-b'])
  harness.firstSend.resolve(true)

  await expect(staleBoundary).resolves.toBe(false)
  await expect(currentBoundary).resolves.toBe(true)
  expect(harness.sent).toEqual(['か', 'terminal-b', 'current-a'])
  harness.unmount()
})

it('cancels queued and producer boundaries across a reused-route scope ABA change', async () => {
  const harness = createOwnershipHarness()
  const staleExternalBoundary = harness.handlers.runLiveInputBoundary
  harness.handlers.applyLiveInputMirror('terminal-a', 'か')
  const queuedBoundary = staleExternalBoundary('terminal-a', async () => {
    harness.sent.push('\r')
    return true
  })
  await vi.waitFor(() => expect(harness.sent).toEqual(['か']))

  harness.setScope('host-a\0worktree-b')
  harness.setScope('host-a\0worktree-a')
  const producerSend = vi.fn(async () => true)

  await expect(staleExternalBoundary('terminal-a', producerSend)).resolves.toBe(false)
  harness.firstSend.resolve(true)
  await expect(queuedBoundary).resolves.toBe(false)
  expect(producerSend).not.toHaveBeenCalled()
  expect(harness.sent).toEqual(['か'])
  harness.unmount()
})

it('rejects a captured producer boundary after unmount', async () => {
  const harness = createOwnershipHarness()
  const staleExternalBoundary = harness.handlers.runLiveInputBoundary
  const producerSend = vi.fn(async () => true)

  harness.unmount()

  await expect(staleExternalBoundary('terminal-a', producerSend)).resolves.toBe(false)
  expect(producerSend).not.toHaveBeenCalled()
})

it('cancels a queued mirror delta across a live-mode ABA change', async () => {
  const harness = createOwnershipHarness()
  harness.handlers.applyLiveInputMirror('terminal-a', 'a')
  harness.handlers.applyLiveInputMirror('terminal-a', 'ab')
  const staleFlush = harness.handlers.waitForPendingLiveInputFlush()
  await vi.waitFor(() => expect(harness.sent).toEqual(['a']))

  harness.setOwner('terminal-a', null)
  harness.setOwner('terminal-a', 'terminal-a')
  harness.firstSend.resolve(true)

  await expect(staleFlush).resolves.toBe(false)
  expect(harness.sent).toEqual(['a'])
  harness.unmount()
})
