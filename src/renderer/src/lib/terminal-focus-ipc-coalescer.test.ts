import { describe, expect, it, vi } from 'vitest'
import { createTerminalFocusIpcCoalescer } from './terminal-focus-ipc-coalescer'

describe('createTerminalFocusIpcCoalescer', () => {
  it('collapses a same-turn focus storm to the latest payload', async () => {
    const apply = vi.fn()
    const coalescer = createTerminalFocusIpcCoalescer(apply)

    coalescer.enqueue({ tabId: 't1', worktreeId: 'wt-1' })
    coalescer.enqueue({ tabId: 't2', worktreeId: 'wt-2' })
    coalescer.enqueue({ tabId: 't3', worktreeId: 'wt-3', leafId: 'leaf-3' })

    expect(apply).not.toHaveBeenCalled()
    expect(coalescer.getPending()).toEqual({
      tabId: 't3',
      worktreeId: 'wt-3',
      leafId: 'leaf-3'
    })

    await Promise.resolve()
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({
      tabId: 't3',
      worktreeId: 'wt-3',
      leafId: 'leaf-3'
    })
    expect(coalescer.getPending()).toBeNull()
  })

  it('applies sequential turns independently', async () => {
    const apply = vi.fn()
    const coalescer = createTerminalFocusIpcCoalescer(apply)

    coalescer.enqueue({ tabId: 't1', worktreeId: 'wt-1' })
    await Promise.resolve()
    coalescer.enqueue({ tabId: 't2', worktreeId: 'wt-2' })
    await Promise.resolve()

    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[0]?.[0]).toEqual({ tabId: 't1', worktreeId: 'wt-1' })
    expect(apply.mock.calls[1]?.[0]).toEqual({ tabId: 't2', worktreeId: 'wt-2' })
  })
})
