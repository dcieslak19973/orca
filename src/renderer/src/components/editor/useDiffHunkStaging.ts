import { useEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import type { DiffHunkRange } from '../../../../shared/git-hunk-patch'
import {
  findLineChangeForModifiedLine,
  toDiffHunkRange,
  type DiffLineChange
} from './diff-hunk-line-changes'

export type DiffHunkStagingConfig = {
  scope: 'unstaged' | 'staged'
  actionLabel: string
  applyHunk: (range: DiffHunkRange) => Promise<void>
}

const STAGE_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8h7.5M7 4.5 10.5 8 7 11.5M13.5 3v10"/></svg>'
const UNSTAGE_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8H6M9 4.5 5.5 8 9 11.5M2.5 3v10"/></svg>'

// Why: Monaco glyph decorations don't expose usable click events (see
// useDiffCommentDecorator), so the hunk action is an absolutely-positioned
// button that follows the hovered changed line in the modified pane.
export function useDiffHunkStaging({
  diffEditor,
  modifiedEditor,
  config
}: {
  diffEditor: editor.IStandaloneDiffEditor | null
  modifiedEditor: editor.ICodeEditor | null
  config: DiffHunkStagingConfig | null
}): void {
  const applyHunkRef = useRef(config?.applyHunk)
  // Why: writing a ref during render is impure and misbehaves under StrictMode's
  // double render. The ref is only read from deferred DOM handlers, so syncing
  // on commit is soon enough, and this runs before the effect below on mount.
  useEffect(() => {
    applyHunkRef.current = config?.applyHunk
  })
  const scope = config?.scope ?? null
  const actionLabel = config?.actionLabel ?? ''

  useEffect(() => {
    if (!diffEditor || !modifiedEditor || !scope) {
      return
    }
    const editorDomNode = modifiedEditor.getDomNode()
    if (!editorDomNode) {
      return
    }

    let changes: readonly DiffLineChange[] = diffEditor.getLineChanges() ?? []
    const diffUpdateSub = diffEditor.onDidUpdateDiff(() => {
      changes = diffEditor.getLineChanges() ?? []
    })

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'orca-diff-hunk-stage-btn'
    button.title = actionLabel
    button.setAttribute('aria-label', actionLabel)
    button.innerHTML = scope === 'staged' ? UNSTAGE_ICON : STAGE_ICON
    button.style.display = 'none'
    editorDomNode.appendChild(button)

    const hoverLineRef = { current: null as number | null }
    let busy = false
    // Cache last-applied styles so repositioning skips redundant DOM writes on high-freq mousemove.
    let lastTop: number | null = null
    let lastDisplay: string | null = null

    const setDisplay = (value: string): void => {
      if (lastDisplay === value) {
        return
      }
      button.style.display = value
      lastDisplay = value
    }

    const BUTTON_SIZE = 18
    const positionAtLine = (lineNumber: number): void => {
      const lineHeight = modifiedEditor.getOption(monaco.editor.EditorOption.lineHeight)
      const lineTop = modifiedEditor.getTopForLineNumber(lineNumber) - modifiedEditor.getScrollTop()
      const top = Math.round(
        lineTop +
          ((typeof lineHeight === 'number' && lineHeight > 0 ? lineHeight : 19) - BUTTON_SIZE) / 2
      )
      if (top !== lastTop) {
        button.style.top = `${top}px`
        lastTop = top
      }
      setDisplay('flex')
    }

    const handleClick = (ev: MouseEvent): void => {
      ev.preventDefault()
      ev.stopPropagation()
      const line = hoverLineRef.current
      if (busy || line == null) {
        return
      }
      const change = findLineChangeForModifiedLine(changes, line)
      if (!change) {
        return
      }
      busy = true
      button.disabled = true
      void applyHunkRef
        .current?.(toDiffHunkRange(change))
        // Why: applyHunk reports git failures itself; anything reaching here is a defect in the
        // post-apply bookkeeping. Without this it lands as an unhandled rejection and the click
        // looks like it silently did nothing.
        .catch((err) => {
          console.error('[diff-hunk] applying the hunk failed after the git call', err)
        })
        .finally(() => {
          busy = false
          button.disabled = false
          setDisplay('none')
        })
    }
    button.addEventListener('mousedown', handleClick)

    const mouseMoveSub = modifiedEditor.onMouseMove((e) => {
      // Monaco reports null position over the button itself; hiding then would flicker-loop.
      const srcEvent = e.event?.browserEvent as MouseEvent | undefined
      if ((srcEvent && button.contains(srcEvent.target as Node)) || busy) {
        return
      }
      const lineNumber = e.target.position?.lineNumber ?? null
      const change = lineNumber == null ? null : findLineChangeForModifiedLine(changes, lineNumber)
      if (lineNumber == null || !change) {
        hoverLineRef.current = null
        setDisplay('none')
        return
      }
      hoverLineRef.current = lineNumber
      positionAtLine(lineNumber)
    })
    const mouseLeaveSub = modifiedEditor.onMouseLeave(() => {
      if (!busy) {
        setDisplay('none')
      }
    })
    const scrollSub = modifiedEditor.onDidScrollChange(() => {
      // Why: follow the line only while the button is actually showing. hoverLineRef deliberately
      // survives mouse-leave so a click in the gap between the content area and the button still
      // resolves to a line, so it cannot double as the visibility signal — without the display
      // check, any scroll after the pointer left would re-show the button under no cursor.
      if (hoverLineRef.current != null && lastDisplay === 'flex') {
        positionAtLine(hoverLineRef.current)
      }
    })

    return () => {
      diffUpdateSub.dispose()
      mouseMoveSub.dispose()
      mouseLeaveSub.dispose()
      scrollSub.dispose()
      button.removeEventListener('mousedown', handleClick)
      button.remove()
    }
  }, [diffEditor, modifiedEditor, scope, actionLabel])
}
