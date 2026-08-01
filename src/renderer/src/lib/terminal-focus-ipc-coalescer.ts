/**
 * Latest-wins coalescer for ui:focusTerminal IPC storms on the host renderer.
 * Collapses to one activation per animation frame so exclusive host focus
 * does not remount worktrees/tabs for every intermediate IPC delivery.
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
  /** Test aid: pending payload before frame flush. */
  getPending: () => TerminalFocusIpcPayload | null
}

type RafScheduler = {
  request: (cb: () => void) => number
  cancel: (id: number) => void
}

function defaultRafScheduler(): RafScheduler {
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    return {
      request: (cb) => requestAnimationFrame(cb),
      cancel: (id) => cancelAnimationFrame(id)
    }
  }
  // Node/test fallback: microtask approximates a single turn.
  return {
    request: (cb) => {
      queueMicrotask(cb)
      return 1
    },
    cancel: () => undefined
  }
}

/**
 * Coalesces focus IPC onto the next animation frame so multi-delivery storms
 * collapse to a single host activation (last payload wins).
 */
export function createTerminalFocusIpcCoalescer(
  apply: (payload: TerminalFocusIpcPayload) => void,
  scheduler: RafScheduler = defaultRafScheduler()
): TerminalFocusIpcCoalescer {
  let pending: TerminalFocusIpcPayload | null = null
  let rafId: number | null = null
  let disposed = false

  const flush = (): void => {
    rafId = null
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
      if (rafId === null) {
        rafId = scheduler.request(flush)
      }
    },
    dispose() {
      disposed = true
      if (rafId !== null) {
        scheduler.cancel(rafId)
        rafId = null
      }
      pending = null
    },
    getPending() {
      return pending
    }
  }
}
