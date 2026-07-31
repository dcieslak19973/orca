import { describe, expect, it, vi } from 'vitest'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import {
  queueTerminalLiveBoundarySend,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush,
  type TerminalLivePendingFlushState
} from './terminal-live-pending-flush-state'

describe('terminal live pending flush state', () => {
  it('Given no in-flight flush When waiting for the barrier Then allows control input', async () => {
    // Given
    const state: TerminalLivePendingFlushState = { current: null }

    // When / Then
    await expect(waitForTerminalLivePendingFlush(state)).resolves.toBe(true)
  })

  it('Given an in-flight flush When control input waits Then control is held until flush succeeds', async () => {
    // Given
    const events: string[] = []
    let resolveFlush: (value: boolean) => void = () => {}
    const flushPromise = new Promise<boolean>((resolve) => {
      resolveFlush = resolve
    })
    const state: TerminalLivePendingFlushState = { current: flushPromise }

    // When
    const controlSend = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        events.push('control')
        return true
      }
    )
    await Promise.resolve()

    // Then
    expect(events).toEqual([])
    resolveFlush(true)
    await expect(controlSend).resolves.toBe(true)
    expect(events).toEqual(['control'])
  })

  it('Given an in-flight flush fails When control input waits Then control is skipped', async () => {
    // Given
    const events: string[] = []
    let resolveFlush: (value: boolean) => void = () => {}
    const flushPromise = new Promise<boolean>((resolve) => {
      resolveFlush = resolve
    })
    const state: TerminalLivePendingFlushState = { current: flushPromise }

    // When
    const controlSend = sendTerminalLiveControlAfterPendingFlush(
      () => waitForTerminalLivePendingFlush(state),
      async () => {
        events.push('control')
        return true
      }
    )
    resolveFlush(false)

    // Then
    await expect(controlSend).resolves.toBe(false)
    expect(events).toEqual([])
  })
})

describe('terminal live boundary send queue', () => {
  it('reserves the boundary ahead of a later mirror generation', async () => {
    const state: TerminalLivePendingFlushState = { current: null }
    const order: string[] = []
    let resolveCommit: (value: boolean) => void = () => {}
    const commit = queueTerminalLiveMirrorSend(
      state,
      () =>
        new Promise<boolean>((resolve) => {
          order.push('commit')
          resolveCommit = resolve
        })
    )

    const boundary = queueTerminalLiveBoundarySend(state, async () => {
      order.push('boundary')
      return true
    })
    const nextMirror = queueTerminalLiveMirrorSend(state, async () => {
      order.push('next')
      return true
    })
    expect(order).toEqual(['commit'])

    resolveCommit(true)
    await expect(Promise.all([commit, boundary, nextMirror])).resolves.toEqual([true, true, true])
    expect(order).toEqual(['commit', 'boundary', 'next'])
  })

  it('suppresses the boundary when the preceding mirror send fails', async () => {
    const state: TerminalLivePendingFlushState = { current: null }
    const sendBoundary = vi.fn(async () => true)
    queueTerminalLiveMirrorSend(state, async () => false)

    await expect(queueTerminalLiveBoundarySend(state, sendBoundary)).resolves.toBe(false)
    expect(sendBoundary).not.toHaveBeenCalled()
  })

  it('propagates a boundary error while keeping later mirror sends usable', async () => {
    const state: TerminalLivePendingFlushState = { current: null }
    const boundary = queueTerminalLiveBoundarySend(state, async () => {
      throw new Error('boundary failed')
    })
    const nextMirror = queueTerminalLiveMirrorSend(state, async () => true)

    await expect(boundary).rejects.toThrow('boundary failed')
    await expect(nextMirror).resolves.toBe(true)
  })
})

describe('terminal live mirror send queue', () => {
  it('Given a failed previous send When a mirror send queues Then it still runs in order', async () => {
    // Given
    const state: TerminalLivePendingFlushState = { current: null }
    const order: string[] = []
    const first = queueTerminalLiveMirrorSend(state, async () => {
      order.push('first')
      return false
    })

    // When
    const second = queueTerminalLiveMirrorSend(state, async () => {
      order.push('second')
      return true
    })

    // Then
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    expect(order).toEqual(['first', 'second'])
  })

  it('Given a throwing send When a mirror send queues Then the promise resolves false and the chain continues', async () => {
    // Given
    const state: TerminalLivePendingFlushState = { current: null }
    const first = queueTerminalLiveMirrorSend(state, async () => {
      throw new Error('boom')
    })

    // When
    const second = queueTerminalLiveMirrorSend(state, async () => true)

    // Then
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })

  it('Given a settled mirror send When it was the newest Then the state resets to null', async () => {
    // Given
    const state: TerminalLivePendingFlushState = { current: null }

    // When
    await queueTerminalLiveMirrorSend(state, async () => true)
    await Promise.resolve()

    // Then
    expect(state.current).toBeNull()
  })
})
