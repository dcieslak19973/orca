import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS } from './terminal-live-composition-mirror'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

type TerminalLiveInputCommitHarness = {
  readonly captures: readonly string[]
  readonly handlers: ReturnType<typeof useTerminalLiveInputCommit<string>>
  readonly sent: readonly string[]
  readonly setActiveHandle: (next: string) => void
  readonly setActiveSessionTabType: (next: string | undefined) => void
  readonly setConnected: (next: boolean) => void
  readonly setSendResult: (next: boolean) => void
  readonly unmount: () => void
}

type TerminalLiveInputCommitHarnessOptions = {
  readonly liveInputEnabled?: boolean
  readonly sendResult?: boolean
}

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

function createTerminalLiveInputCommitHarness({
  liveInputEnabled = true,
  sendResult = true
}: TerminalLiveInputCommitHarnessOptions = {}): TerminalLiveInputCommitHarness {
  let currentActiveHandle = 'terminal-a'
  const activeHandleRef: RefObject<string | null> = { current: currentActiveHandle }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const captures: string[] = []
  const setLiveInputCapture = (text: string): void => {
    captures.push(text)
  }
  const liveInputRef: RefObject<TextInput | null> = { current: null }
  const liveInputTerminalHandles = liveInputEnabled
    ? new Set(['terminal-a', 'terminal-b'])
    : new Set<string>()
  const liveInputTerminalHandlesRef: RefObject<Set<string>> = {
    current: new Set(liveInputTerminalHandles)
  }
  const sent: string[] = []
  let currentSendResult = sendResult
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sent.push(bytes)
      return currentSendResult
    }
  }
  // Refs never re-render; only these variables re-run the hook's clear effects.
  let currentActiveSessionTabType: string | undefined = 'terminal'
  let currentConnected = true
  let handlers: ReturnType<typeof useTerminalLiveInputCommit<string>> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle: currentActiveHandle,
      activeHandleRef,
      activeSessionTabType: currentActiveSessionTabType,
      activeSessionTabTypeRef,
      connected: currentConnected,
      liveInputRef,
      liveInputScope: 'host-a\0worktree-a',
      liveInputTerminalHandles,
      liveInputTerminalHandlesRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture
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
    throw new Error('terminal live input hook did not render')
  }

  return {
    captures,
    get handlers() {
      if (!handlers) {
        throw new Error('terminal live input hook is unavailable')
      }
      return handlers
    },
    sent,
    setActiveHandle: (next: string): void => {
      currentActiveHandle = next
      activeHandleRef.current = next
      act(() => {
        renderer?.update(createElement(Harness))
      })
    },
    setActiveSessionTabType: (next: string | undefined): void => {
      currentActiveSessionTabType = next
      // Ref and prop derive from the same activeSessionTab in the real route, so
      // they go null together during tab-list lag — keep the harness coupled.
      activeSessionTabTypeRef.current = next ?? null
      act(() => {
        renderer?.update(createElement(Harness))
      })
    },
    setConnected: (next: boolean): void => {
      currentConnected = next
      act(() => {
        renderer?.update(createElement(Harness))
      })
    },
    setSendResult: (next: boolean): void => {
      currentSendResult = next
    },
    unmount: () => {
      act(() => renderer?.unmount())
    }
  }
}

describe('terminal live input commit hook', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('Given Hangul composition When steps arrive Then streams the stable prefix and never leaks jamo', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: ㅎ→하→한→한ㄱ→한그→한글 (no settle pause between steps)
    for (const fieldText of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
      handlers.handleLiveInputChange(fieldText)
      await vi.advanceTimersByTimeAsync(50)
    }

    // Then: only the stable prefix went out; the trailing syllable is held
    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given a held syllable When the settle timer elapses Then commits it to the terminal', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given a timer-committed syllable When composition continues Then corrects with DEL and recommits', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('하')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)
    await vi.waitFor(() => expect(sent).toEqual(['하']))

    // When
    handlers.handleLiveInputChange('한')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['하', '\x7f', '한']))
  })

  it('Given Hangul pending text When submit is requested Then sends composed text before carriage return', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputSubmit()

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한', '\r']))
  })

  it('Given no pending text When submit is requested Then sends only carriage return', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    handlers.handleLiveInputSubmit()

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['\r']))
  })

  it('Given a rejected held-text send When submit is requested Then suppresses the carriage return', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputSubmit()
    await Promise.resolve()
    await Promise.resolve()

    // Then: the held commit went out but was not accepted, so no \r follows
    await vi.waitFor(() => expect(sent).toEqual(['한']))
  })

  it('Given ASCII typing When changes arrive Then mirrors immediately', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    handlers.handleLiveInputChange('a')
    handlers.handleLiveInputChange('ab')

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['a', 'b']))
  })

  it('Given iOS smart-dash text When the change arrives Then the capture echoes the raw field text and the PTY gets normalized bytes', async () => {
    // Given
    const { captures, handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: iOS smart punctuation rewrote "--" into an en dash inside the field
    handlers.handleLiveInputChange('a–')

    // Then: writing "a--" back into the controlled value would kill an active
    // iOS dictation/IME session, so the capture must keep what iOS produced
    expect(captures).toEqual(['a–'])
    await vi.waitFor(() => expect(sent).toEqual(['a--']))
  })

  it('Given dictation-style hypothesis revisions When changes arrive Then the field is never rewritten and the PTY converges', async () => {
    // Given
    const { captures, handlers, sent } = createTerminalLiveInputCommitHarness()

    // When: iOS dictation replaces its hypothesis as recognition refines
    handlers.handleLiveInputChange('high')
    handlers.handleLiveInputChange('hi there')

    // Then: captures only echo the field; the mirror repairs the PTY with DELs
    expect(captures).toEqual(['high', 'hi there'])
    await vi.waitFor(() => expect(sent).toEqual(['high', '\x7f\x7f there']))
  })

  it('Given a trailing space after Hangul When the change arrives Then the space commits the held syllable', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputChange('한 ')

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한 ']))
  })

  it('Given Hangul pending text When an external terminal send is requested Then flushes composed text first', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    const flushed = await handlers.sendLiveInputExternalBoundary('terminal-a', async () => true)

    // Then
    expect(flushed).toBe(true)
    expect(sent).toEqual(['한'])
  })

  it('Given pending text cannot be sent When an external terminal send is requested Then reports failure', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness({ sendResult: false })
    handlers.handleLiveInputChange('한')

    // When
    const sendBoundary = vi.fn(async () => true)
    const flushed = await handlers.sendLiveInputExternalBoundary('terminal-a', sendBoundary)

    // Then
    expect(flushed).toBe(false)
    expect(sent).toEqual(['한'])
    expect(sendBoundary).not.toHaveBeenCalled()
  })

  it('Given non-Hangul IME text When changes arrive Then mirrors immediately without a settle window', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()

    // When
    handlers.handleLiveInputChange('你好')

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['你好']))
  })

  it('Given a held kana When the settle window passes Then nothing is committed on a timer', async () => {
    // Given: issue #7427 — a flick modifier can land long after the base kana,
    // so a settle commit would race the user instead of resolving anything.
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('つ')

    // When
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS * 10)

    // Then
    expect(sent).toEqual([])
  })

  it('Given a held kana replaced by its modifier When submit is requested Then only the modified kana reaches the terminal', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('つ')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS * 10)

    // When: the flick keyboard's small-kana modifier rewrites the base kana
    handlers.handleLiveInputChange('っ')
    handlers.handleLiveInputSubmit()

    // Then: no stale 'つ' and no DEL repair — the base kana never left the app
    await vi.waitFor(() => expect(sent).toEqual(['っ', '\r']))
  })

  it('Given decomposed kana normalizes When submitted Then no provisional base or DEL reaches the terminal', async () => {
    vi.useFakeTimers()
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('か')
    handlers.handleLiveInputChange('か\u3099')
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS * 10)
    expect(sent).toEqual([])

    handlers.handleLiveInputChange('が')
    handlers.handleLiveInputSubmit()

    await vi.waitFor(() => expect(sent).toEqual(['が', '\r']))
  })

  it('Given a held syllable When the hook unmounts Then cancels the settle timer', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent, unmount } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    unmount()
    await vi.advanceTimersByTimeAsync(1_000)

    // Then
    expect(sent).toEqual([])
  })

  it('Given Backspace with field text When the key arrives Then edits locally without terminal bytes', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Backspace' } })

    // Then
    await vi.waitFor(() => expect(sent).toEqual([]))
  })

  it('Given Tab with a held syllable When the key arrives Then commits the syllable before the tab bytes', async () => {
    // Given
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('한')

    // When
    handlers.handleLiveInputKeyPress({ nativeEvent: { key: 'Tab' } })

    // Then
    await vi.waitFor(() => expect(sent).toEqual(['한', '\t']))
  })

  it('Given Hangul pending When the tab type lags to undefined Then keeps the composition state', async () => {
    // Given: '한' held while the active tab is still a terminal
    const harness = createTerminalLiveInputCommitHarness()
    harness.handlers.handleLiveInputChange('한')

    // When: the mobile tab list momentarily yields no active tab object
    harness.setActiveSessionTabType(undefined)
    harness.handlers.handleLiveInputSubmit()

    // Then: an unknown tab type is not "left the terminal", so pending still flushes
    await vi.waitFor(() => expect(harness.sent).toEqual(['한', '\r']))
  })

  it('Given Hangul pending When the tab genuinely changes to non-terminal Then clears the composition state', async () => {
    // Given: '한' held while the active tab is still a terminal
    const harness = createTerminalLiveInputCommitHarness()
    harness.handlers.handleLiveInputChange('한')

    // When: the active tab actually becomes a non-terminal (chat) tab
    harness.setActiveSessionTabType('chat')
    harness.handlers.handleLiveInputSubmit()

    // Then: pending was dropped, so submit sends only the carriage return
    await vi.waitFor(() => expect(harness.sent).toEqual(['\r']))
  })

  it('Given bytes lost in a silent stall When the disconnect is detected Then the first post-recovery send carries no stale fragment or phantom erases', async () => {
    // Given: a stalled link — the mirror sends but the PTY never accepts (#6713 second defect)
    const harness = createTerminalLiveInputCommitHarness({ sendResult: false })
    harness.handlers.handleLiveInputChange('XYZZY')
    await vi.waitFor(() => expect(harness.sent).toEqual(['XYZZY']))

    // When: the outage is finally detected, then the link recovers
    harness.setConnected(false)
    harness.setSendResult(true)
    harness.setConnected(true)

    // Then: the capture was wiped, and fresh typing sends verbatim bytes — not
    // 'XYZZY…' replayed and not DELs erasing PTY chars that never arrived
    expect(harness.captures.at(-1)).toBe('')
    const sentBeforeRecovery = harness.sent.length
    harness.handlers.handleLiveInputChange('echo CLEANLINE')
    await vi.waitFor(() =>
      expect(harness.sent.slice(sentBeforeRecovery)).toEqual(['echo CLEANLINE'])
    )
  })

  it('rejects a stale producer boundary across a buffered active-terminal ABA change', async () => {
    const harness = createTerminalLiveInputCommitHarness({ liveInputEnabled: false })
    const firstGeneration = harness.handlers.liveInputProducerGeneration
    const staleBoundary = harness.handlers.sendLiveInputExternalBoundary

    harness.setActiveHandle('terminal-b')
    const secondGeneration = harness.handlers.liveInputProducerGeneration
    harness.setActiveHandle('terminal-a')
    const producerSend = vi.fn(async () => true)

    expect(secondGeneration).not.toBe(firstGeneration)
    expect(harness.handlers.liveInputProducerGeneration).not.toBe(firstGeneration)
    await expect(staleBoundary('terminal-a', producerSend)).resolves.toBe(false)
    expect(producerSend).not.toHaveBeenCalled()
    harness.unmount()
  })

  it('Given a held syllable during an outage When the disconnect is detected Then the settle timer cannot commit it later', async () => {
    // Given
    vi.useFakeTimers()
    const { handlers, sent, setConnected } = createTerminalLiveInputCommitHarness({
      sendResult: false
    })
    handlers.handleLiveInputChange('한')

    // When
    setConnected(false)
    await vi.advanceTimersByTimeAsync(TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)

    // Then: the outage cleared the held text before the timer could send it
    expect(sent).toEqual([])
  })
})
