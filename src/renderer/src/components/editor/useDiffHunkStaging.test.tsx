// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { useDiffHunkStaging } from './useDiffHunkStaging'

vi.mock('@/lib/monaco-setup', () => ({
  monaco: { editor: { EditorOption: { lineHeight: 67 } } }
}))

const CHANGE = {
  originalStartLineNumber: 5,
  originalEndLineNumber: 5,
  modifiedStartLineNumber: 5,
  modifiedEndLineNumber: 5
}

type RegisteredHandlers = {
  mouseMove: (e: unknown) => void
  mouseLeave: () => void
  scroll: () => void
}

type PartialHandlers = Partial<RegisteredHandlers>

// Why: optional chaining on an unregistered listener makes these tests pass even when the
// hook never subscribed, so assert registration once and hand back required callbacks.
function requireHandlers(handlers: PartialHandlers): RegisteredHandlers {
  const { mouseMove, mouseLeave, scroll } = handlers
  if (!mouseMove || !mouseLeave || !scroll) {
    throw new Error('expected the hook to register mouse-move, mouse-leave and scroll listeners')
  }
  return { mouseMove, mouseLeave, scroll }
}

function setup(): {
  host: HTMLElement
  handlers: RegisteredHandlers
  scrollTo: (top: number) => void
  applyHunk: ReturnType<typeof vi.fn>
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const handlers: PartialHandlers = {}
  const dispose = { dispose: vi.fn() }
  let scrollTop = 0

  const modifiedEditor = {
    getDomNode: () => host,
    getOption: () => 19,
    getTopForLineNumber: () => 100,
    getScrollTop: () => scrollTop,
    onMouseMove: (cb: (e: unknown) => void) => ((handlers.mouseMove = cb), dispose),
    onMouseLeave: (cb: () => void) => ((handlers.mouseLeave = cb), dispose),
    onDidScrollChange: (cb: () => void) => ((handlers.scroll = cb), dispose)
  } as unknown as editor.ICodeEditor

  const diffEditor = {
    getLineChanges: () => [CHANGE],
    onDidUpdateDiff: () => dispose
  } as unknown as editor.IStandaloneDiffEditor

  const applyHunk = vi.fn().mockResolvedValue(undefined)
  renderHook(() =>
    useDiffHunkStaging({
      diffEditor,
      modifiedEditor,
      config: { scope: 'unstaged', actionLabel: 'Stage hunk', applyHunk }
    })
  )
  const registered = requireHandlers(handlers)
  const scrollTo = (top: number): void => {
    scrollTop = top
    registered.scroll()
  }
  return { host, handlers: registered, scrollTo, applyHunk }
}

function button(host: HTMLElement): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('.orca-diff-hunk-stage-btn')
  if (!found) {
    throw new Error('expected the hunk button to be mounted')
  }
  return found
}

describe('useDiffHunkStaging', () => {
  it('shows the button when hovering a changed line and hides it off a change', () => {
    const { host, handlers } = setup()
    handlers.mouseMove({ target: { position: { lineNumber: 5 } }, event: {} })
    expect(button(host).style.display).toBe('flex')

    handlers.mouseMove({ target: { position: { lineNumber: 40 } }, event: {} })
    expect(button(host).style.display).toBe('none')
  })

  // Why: hoverLineRef intentionally survives mouse-leave so a click in the gap between the content
  // area and the button still resolves to a line. That means a scroll must not treat a live ref as
  // permission to re-show, or keyboard/programmatic scrolling pops the button up under no cursor.
  it('stays hidden when a scroll arrives after the pointer left the editor', () => {
    const { host, handlers, scrollTo } = setup()
    handlers.mouseMove({ target: { position: { lineNumber: 5 } }, event: {} })
    expect(button(host).style.display).toBe('flex')

    handlers.mouseLeave()
    expect(button(host).style.display).toBe('none')

    scrollTo(40)
    expect(button(host).style.display).toBe('none')
  })

  it('keeps following the hovered line while the button is visible', () => {
    const { host, handlers, scrollTo } = setup()
    handlers.mouseMove({ target: { position: { lineNumber: 5 } }, event: {} })
    const before = Number.parseFloat(button(host).style.top)

    scrollTo(40)

    expect(button(host).style.display).toBe('flex')
    // Why: the button tracks `getTopForLineNumber - getScrollTop`, so a 40px scroll must
    // move it exactly 40px up or it is not really following the line.
    expect(Number.parseFloat(button(host).style.top)).toBe(before - 40)
  })
})
