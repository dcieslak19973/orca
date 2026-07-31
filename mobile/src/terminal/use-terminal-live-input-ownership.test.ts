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
  let liveInputOwner: string | null = 'terminal-a'
  let handlers: ReturnType<typeof useTerminalLivePendingInputFlush<string>> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useTerminalLivePendingInputFlush({
      activeHandleRef,
      activeSessionTabTypeRef,
      liveInputRef: { current: null } as RefObject<TextInput | null>,
      liveInputOwner,
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
    handlers,
    sent,
    setOwner(activeHandle: string, owner: string | null): void {
      activeHandleRef.current = activeHandle
      liveInputOwner = owner
      act(() => renderer?.update(createElement(Harness)))
    },
    unmount(): void {
      act(() => renderer?.unmount())
    }
  }
}

it('cancels a queued boundary across an active-terminal ABA change', async () => {
  const harness = createOwnershipHarness()
  harness.handlers.applyLiveInputMirror('terminal-a', 'か')
  const boundary = harness.handlers.runLiveInputBoundary('terminal-a', async () => {
    harness.sent.push('\r')
    return true
  })
  await vi.waitFor(() => expect(harness.sent).toEqual(['か']))

  harness.setOwner('terminal-b', 'terminal-b')
  harness.setOwner('terminal-a', 'terminal-a')
  harness.firstSend.resolve(true)

  await expect(boundary).resolves.toBe(false)
  expect(harness.sent).toEqual(['か'])
  harness.unmount()
})

it('cancels a queued mirror delta across a live-mode ABA change', async () => {
  const harness = createOwnershipHarness()
  harness.handlers.applyLiveInputMirror('terminal-a', 'a')
  harness.handlers.applyLiveInputMirror('terminal-a', 'ab')
  await vi.waitFor(() => expect(harness.sent).toEqual(['a']))

  harness.setOwner('terminal-a', null)
  harness.setOwner('terminal-a', 'terminal-a')
  harness.firstSend.resolve(true)

  await expect(harness.handlers.waitForPendingLiveInputFlush()).resolves.toBe(false)
  expect(harness.sent).toEqual(['a'])
  harness.unmount()
})
