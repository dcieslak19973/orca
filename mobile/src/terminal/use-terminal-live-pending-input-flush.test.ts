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
  let resolvePromise: (value: boolean) => void = () => {
    throw new Error('deferred promise was resolved before initialization')
  }
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

it('reserves a slow kana boundary before a newer live-input generation', async () => {
  const activeHandle = 'terminal-a'
  const activeHandleRef: RefObject<string | null> = { current: activeHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const liveInputRef: RefObject<TextInput | null> = { current: null }
  const liveInputTerminalHandlesRef: RefObject<Set<string>> = {
    current: new Set([activeHandle])
  }
  const firstSend = createDeferredBoolean()
  const sent: string[] = []
  let sendCount = 0
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sent.push(bytes)
      sendCount += 1
      return sendCount === 1 ? firstSend.promise : true
    }
  }
  const captures: string[] = []
  let handlers: ReturnType<typeof useTerminalLivePendingInputFlush<string>> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useTerminalLivePendingInputFlush({
      activeHandleRef,
      activeSessionTabTypeRef,
      liveInputRef,
      liveInputTerminalHandlesRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture: (text) => captures.push(text)
    })
    return null
  }

  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    act(() => {
      renderer = create(createElement(Harness))
    })
  } finally {
    restoreConsoleError()
  }
  if (!handlers || !renderer) {
    throw new Error('terminal live pending-input hook did not render')
  }

  handlers.applyLiveInputMirror(activeHandle, 'つ')
  const firstBoundary = handlers.runLiveInputBoundary(activeHandle, () =>
    sendLiveTerminalInputRef.current(activeHandle, '\r')
  )
  await vi.waitFor(() => expect(sent).toEqual(['つ']))
  expect(captures.at(-1)).toBe('')

  handlers.applyLiveInputMirror(activeHandle, 'か')
  handlers.applyLiveInputMirror(activeHandle, 'かき')
  expect(sent).toEqual(['つ'])
  firstSend.resolve(true)
  await expect(firstBoundary).resolves.toBe(true)
  await vi.waitFor(() => expect(sent).toEqual(['つ', '\r', 'か']))

  await handlers.runLiveInputBoundary(activeHandle, () =>
    sendLiveTerminalInputRef.current(activeHandle, '\r')
  )
  expect(sent).toEqual(['つ', '\r', 'か', 'き', '\r'])
  act(() => renderer?.unmount())
})
