import { describe, expect, it, vi } from 'vitest'
import { createTerminalFocusIpcCoalescer } from './terminal-focus-ipc-coalescer'

describe('createTerminalFocusIpcCoalescer', () => {
  it('collapses a same-frame focus storm to the latest payload', () => {
    const apply = vi.fn()
    const callbacks: (() => void)[] = []
    const coalescer = createTerminalFocusIpcCoalescer(apply, {
      request: (cb) => {
        callbacks.push(cb)
        return callbacks.length
      },
      cancel: vi.fn()
    })

    coalescer.enqueue({ tabId: 't1', worktreeId: 'wt-1' })
    coalescer.enqueue({ tabId: 't2', worktreeId: 'wt-2' })
    coalescer.enqueue({ tabId: 't3', worktreeId: 'wt-3', leafId: 'leaf-3' })

    expect(apply).not.toHaveBeenCalled()
    expect(callbacks).toHaveLength(1)
    expect(coalescer.getPending()).toEqual({
      tabId: 't3',
      worktreeId: 'wt-3',
      leafId: 'leaf-3'
    })

    callbacks[0]?.()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({
      tabId: 't3',
      worktreeId: 'wt-3',
      leafId: 'leaf-3'
    })
    expect(coalescer.getPending()).toBeNull()
  })

  it('applies sequential frames independently', () => {
    const apply = vi.fn()
    const callbacks: (() => void)[] = []
    const coalescer = createTerminalFocusIpcCoalescer(apply, {
      request: (cb) => {
        callbacks.push(cb)
        return callbacks.length
      },
      cancel: vi.fn()
    })

    coalescer.enqueue({ tabId: 't1', worktreeId: 'wt-1' })
    callbacks[0]?.()
    coalescer.enqueue({ tabId: 't2', worktreeId: 'wt-2' })
    callbacks[1]?.()

    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[0]?.[0]).toEqual({ tabId: 't1', worktreeId: 'wt-1' })
    expect(apply.mock.calls[1]?.[0]).toEqual({ tabId: 't2', worktreeId: 'wt-2' })
  })

  it('dispose cancels a scheduled flush', () => {
    const apply = vi.fn()
    const cancel = vi.fn()
    let scheduled: (() => void) | null = null
    const coalescer = createTerminalFocusIpcCoalescer(apply, {
      request: (cb) => {
        scheduled = cb
        return 7
      },
      cancel
    })
    coalescer.enqueue({ tabId: 't1', worktreeId: 'wt-1' })
    coalescer.dispose()
    expect(cancel).toHaveBeenCalledWith(7)
    scheduled?.()
    expect(apply).not.toHaveBeenCalled()
  })
})
