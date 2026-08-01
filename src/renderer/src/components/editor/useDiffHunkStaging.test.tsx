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

type Handlers = {
  mouseMove?: (e: unknown) => void
  mouseLeave?: () => void
  scroll?: () => void
}

function setup(): { host: HTMLElement; handlers: Handlers; applyHunk: ReturnType<typeof vi.fn> } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const handlers: Handlers = {}
  const dispose = { dispose: vi.fn() }

  const modifiedEditor = {
    getDomNode: () => host,
    getOption: () => 19,
    getTopForLineNumber: () => 100,
    getScrollTop: () => 0,
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
  return { host, handlers, applyHunk }
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
    handlers.mouseMove?.({ target: { position: { lineNumber: 5 } }, event: {} })
    expect(button(host).style.display).toBe('flex')

    handlers.mouseMove?.({ target: { position: { lineNumber: 40 } }, event: {} })
    expect(button(host).style.display).toBe('none')
  })

  // Why: hoverLineRef intentionally survives mouse-leave so a click in the gap between the content
  // area and the button still resolves to a line. That means a scroll must not treat a live ref as
  // permission to re-show, or keyboard/programmatic scrolling pops the button up under no cursor.
  it('stays hidden when a scroll arrives after the pointer left the editor', () => {
    const { host, handlers } = setup()
    handlers.mouseMove?.({ target: { position: { lineNumber: 5 } }, event: {} })
    expect(button(host).style.display).toBe('flex')

    handlers.mouseLeave?.()
    expect(button(host).style.display).toBe('none')

    handlers.scroll?.()
    expect(button(host).style.display).toBe('none')
  })

  it('keeps following the hovered line while the button is visible', () => {
    const { host, handlers } = setup()
    handlers.mouseMove?.({ target: { position: { lineNumber: 5 } }, event: {} })
    handlers.scroll?.()
    expect(button(host).style.display).toBe('flex')
  })
})
