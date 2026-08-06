import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { attachTerminalScrollIntentAppReplayRepin } from './terminal-scroll-intent-app-replay-repin'
import {
  getTerminalScrollIntentKind,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from './terminal-scroll-intent'
import type { IDisposable } from '@xterm/xterm'

type RepinTerminal = Parameters<typeof attachTerminalScrollIntentAppReplayRepin>[0]

let disposables: IDisposable[] = []
let terminals: Terminal[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const disposable of disposables) {
    disposable.dispose()
  }
  disposables = []
  for (const terminal of terminals) {
    terminal.dispose()
  }
  terminals = []
  vi.useRealTimers()
})

function makeTerminal(): Terminal {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true })
  terminals.push(term)
  return term
}

function attach(term: Terminal): void {
  disposables.push(attachTerminalScrollIntentAppReplayRepin(term as unknown as RepinTerminal))
}

// xterm's write queue schedules on the same (faked) clock; advance it so the
// chunk parses, then await the parse callback.
async function writeChunk(term: Terminal, data: string): Promise<void> {
  const parsed = new Promise<void>((resolve) => term.write(data, resolve))
  await vi.advanceTimersByTimeAsync(20)
  await parsed
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500)
}

function conversationLines(count: number, tag: string): string {
  let out = ''
  for (let i = 0; i < count; i++) {
    out += `${tag} line ${i}\r\n`
  }
  return out
}

async function pinScrolledUpConversation(term: Terminal, line: number): Promise<void> {
  await writeChunk(term, conversationLines(200, 'msg'))
  term.scrollToLine(line)
  markTerminalPinnedViewport(term)
  syncTerminalScrollIntentFromViewport(term, { allowBufferShrink: true })
}

// pi-tui's width-change repaint: home + clear scrollback, then a full replay
// of the conversation (#8715). The clear clamps a scrolled-up viewport to
// line 0 and xterm keeps it there while the replay appends below.
describe('attachTerminalScrollIntentAppReplayRepin', () => {
  it('re-pins a scrolled-up viewport after a clear-scrollback replay', async () => {
    const term = makeTerminal()
    attach(term)
    await pinScrolledUpConversation(term, 50)
    expect(term.buffer.active.viewportY).toBe(50)

    await writeChunk(term, '\x1b[H\x1b[3J')
    await writeChunk(term, conversationLines(200, 'replay'))
    expect(term.buffer.active.viewportY).toBe(0)

    await settle()
    expect(term.buffer.active.viewportY).toBe(50)
    expect(getTerminalScrollIntentKind(term)).toBe('pinnedViewport')
  })

  it('keeps a bottom-following viewport at the bottom', async () => {
    const term = makeTerminal()
    attach(term)
    await writeChunk(term, conversationLines(200, 'msg'))
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)

    await writeChunk(term, '\x1b[H\x1b[3J')
    await writeChunk(term, conversationLines(220, 'replay'))
    await settle()

    const buf = term.buffer.active
    expect(buf.viewportY).toBe(buf.baseY)
    expect(getTerminalScrollIntentKind(term)).toBe('followOutput')
  })

  it('does not touch a viewport deliberately pinned at the top', async () => {
    const term = makeTerminal()
    attach(term)
    await pinScrolledUpConversation(term, 0)
    expect(term.buffer.active.viewportY).toBe(0)

    await writeChunk(term, conversationLines(5, 'more'))
    await settle()
    expect(term.buffer.active.viewportY).toBe(0)
  })

  it('leaves alt-screen TUIs alone', async () => {
    const term = makeTerminal()
    attach(term)
    await pinScrolledUpConversation(term, 50)

    // Full-screen overlay: enter alt, repaint frames there.
    await writeChunk(term, '\x1b[?1049h\x1b[2J\x1b[Hoverlay frame')
    await writeChunk(term, '\x1b[Hoverlay frame 2')
    await settle()
    expect(term.buffer.active.type).toBe('alternate')
    expect(term.buffer.active.viewportY).toBe(0)

    // Overlay closes: back to the normal buffer, pin intact without a replay.
    await writeChunk(term, '\x1b[?1049l')
    await settle()
    expect(term.buffer.active.type).toBe('normal')
    expect(term.buffer.active.viewportY).toBe(50)
  })

  it('caps the settle window under a continuous replay stream', async () => {
    const term = makeTerminal()
    attach(term)
    await pinScrolledUpConversation(term, 50)

    await writeChunk(term, '\x1b[H\x1b[3J')
    // Chunks arriving faster than the debounce, for longer than the cap: the
    // repin must not starve.
    for (let i = 0; i < 20; i++) {
      const parsed = new Promise<void>((resolve) =>
        term.write(conversationLines(10, `stream${i}`), resolve)
      )
      await vi.advanceTimersByTimeAsync(40)
      await parsed
    }
    await settle()
    expect(term.buffer.active.viewportY).toBe(50)
  })

  it('stops re-pinning after dispose', async () => {
    const term = makeTerminal()
    const disposable = attachTerminalScrollIntentAppReplayRepin(term as unknown as RepinTerminal)
    await pinScrolledUpConversation(term, 50)

    disposable.dispose()
    await writeChunk(term, '\x1b[H\x1b[3J')
    await writeChunk(term, conversationLines(200, 'replay'))
    await settle()
    expect(term.buffer.active.viewportY).toBe(0)
  })
})
