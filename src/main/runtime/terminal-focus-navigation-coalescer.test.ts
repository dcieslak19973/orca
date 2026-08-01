import { describe, expect, it, vi } from 'vitest'
import { TerminalFocusNavigationCoalescer } from './terminal-focus-navigation-coalescer'

describe('TerminalFocusNavigationCoalescer', () => {
  it('runs a single job to completion', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<string>()
    const result = await coalescer.run({
      key: 'term_a',
      run: async () => 'full-a',
      resolveSuperseded: () => 'superseded-a'
    })
    expect(result).toBe('full-a')
    expect(coalescer.getState()).toEqual({
      running: false,
      activeKey: null,
      pendingKey: null
    })
  })

  it('serializes concurrent focuses and latest-wins drops intermediate pending', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<string>()
    let releaseA!: () => void
    const aStarted = Promise.withResolvers<void>()
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const runA = vi.fn(async () => {
      aStarted.resolve()
      await aGate
      return 'full-a'
    })
    const runB = vi.fn(async () => 'full-b')
    const runC = vi.fn(async () => 'full-c')
    const superA = vi.fn(() => 'super-a')
    const superB = vi.fn(() => 'super-b')
    const superC = vi.fn(() => 'super-c')

    const pA = coalescer.run({
      key: 'term_a',
      run: runA,
      resolveSuperseded: superA
    })
    await aStarted.promise

    const pB = coalescer.run({
      key: 'term_b',
      run: runB,
      resolveSuperseded: superB
    })
    const pC = coalescer.run({
      key: 'term_c',
      run: runC,
      resolveSuperseded: superC
    })

    // B was pending then superseded by C before A finished.
    await expect(pB).resolves.toBe('super-b')
    expect(superB).toHaveBeenCalledTimes(1)
    expect(runB).not.toHaveBeenCalled()

    releaseA()
    await expect(pA).resolves.toBe('full-a')
    await expect(pC).resolves.toBe('full-c')
    expect(runC).toHaveBeenCalledTimes(1)
    expect(superC).not.toHaveBeenCalled()
    expect(runA).toHaveBeenCalledTimes(1)
  })

  it('bounds host navigation to one full run under a parallel storm', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<number>()
    let inFlight = 0
    let maxInFlight = 0
    let fullRuns = 0

    const makeJob = (key: string) =>
      coalescer.run({
        key,
        run: async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          fullRuns += 1
          await new Promise((r) => setTimeout(r, 5))
          inFlight -= 1
          return fullRuns
        },
        resolveSuperseded: () => -1
      })

    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => makeJob(`term_${i}`)))

    // Only one full navigation at a time.
    expect(maxInFlight).toBe(1)
    // Most of the storm is superseded; only a small number of full runs occur.
    expect(fullRuns).toBeLessThanOrEqual(2)
    expect(fullRuns).toBeGreaterThanOrEqual(1)
    // Superseded jobs resolve cheaply; the last completer is a full run.
    expect(results.filter((r) => r === -1).length).toBeGreaterThanOrEqual(14)
    expect(results.some((r) => r > 0)).toBe(true)
  })

  it('propagates run failures without stranding the queue', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<string>()
    let releaseA!: () => void
    const aStarted = Promise.withResolvers<void>()
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const pA = coalescer.run({
      key: 'term_a',
      run: async () => {
        aStarted.resolve()
        await aGate
        throw new Error('boom')
      },
      resolveSuperseded: () => 'super-a'
    })
    await aStarted.promise

    const pB = coalescer.run({
      key: 'term_b',
      run: async () => 'full-b',
      resolveSuperseded: () => 'super-b'
    })

    releaseA()
    await expect(pA).rejects.toThrow('boom')
    await expect(pB).resolves.toBe('full-b')
    expect(coalescer.getState().running).toBe(false)
  })
})
