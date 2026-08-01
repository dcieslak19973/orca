/**
 * Latest-wins coalescer for ui:focusTerminal IPC storms.
 * Intermediate focuses are dropped; only the newest paints worktree + tab activation.
 */

export type TerminalFocusIpcPayload = {
  tabId: string
  worktreeId: string
  leafId?: string | null
  ackPaneKeyOnSuccess?: string
  flashFocusedPane?: boolean
  scrollToBottomIfOutputSinceLastView?: boolean
}

export type TerminalFocusIpcCoalescer = {
  enqueue: (payload: TerminalFocusIpcPayload) => void
  dispose: () => void
  /** Test aid: pending payload after enqueue before microtask flush. */
  getPending: () => TerminalFocusIpcPayload | null
}

/**
 * Coalesces focus IPC onto the next microtask so a same-turn storm collapses
 * to a single host activation.
 */
export function createTerminalFocusIpcCoalescer(
  apply: (payload: TerminalFocusIpcPayload) => void
): TerminalFocusIpcCoalescer {
  let pending: TerminalFocusIpcPayload | null = null
  let scheduled = false
  let disposed = false

  const flush = (): void => {
    scheduled = false
    if (disposed) {
      pending = null
      return
    }
    const next = pending
    pending = null
    if (next) {
      apply(next)
    }
  }

  return {
    enqueue(payload) {
      if (disposed) {
        return
      }
      pending = payload
      if (!scheduled) {
        scheduled = true
        queueMicrotask(flush)
      }
    },
    dispose() {
      disposed = true
      pending = null
      scheduled = false
    },
    getPending() {
      return pending
    }
  }
}
