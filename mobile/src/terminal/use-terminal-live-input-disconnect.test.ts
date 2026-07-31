import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

const TERMINAL_A_LIVE_INPUT_HANDLES = new Set(['terminal-a'])

it('preserves fully unsent kana across a disconnect', async () => {
  const activeHandle = 'terminal-a'
  const activeHandleRef: RefObject<string | null> = { current: activeHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const liveInputRef: RefObject<TextInput | null> = { current: null }
  const liveInputTerminalHandlesRef: RefObject<Set<string>> = {
    current: new Set([activeHandle])
  }
  const sent: string[] = []
  const captures: string[] = []
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sent.push(bytes)
      return true
    }
  }
  let connected = true
  let handlers: ReturnType<typeof useTerminalLiveInputCommit<string>> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      connected,
      liveInputRef,
      liveInputScope: 'host-a\0worktree-a',
      liveInputTerminalHandles: TERMINAL_A_LIVE_INPUT_HANDLES,
      liveInputTerminalHandlesRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture: (text) => captures.push(text)
    })
    return null
  }

  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  try {
    act(() => {
      renderer = create(createElement(Harness))
    })
  } finally {
    consoleErrorSpy.mockRestore()
  }
  if (!handlers || !renderer) {
    throw new Error('terminal live input hook did not render')
  }

  handlers.handleLiveInputChange('つ')
  connected = false
  act(() => renderer?.update(createElement(Harness)))
  connected = true
  act(() => renderer?.update(createElement(Harness)))
  handlers.handleLiveInputSubmit()

  await vi.waitFor(() => expect(sent).toEqual(['つ', '\r']))
  expect(captures).toEqual(['つ', ''])
  act(() => renderer?.unmount())
})
