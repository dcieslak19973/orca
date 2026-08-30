import { describe, expect, it } from 'vitest'
import { KeyedMutationQueue } from './keyed-mutation-queue'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('KeyedMutationQueue', () => {
  it('runs same-key tasks one at a time, in submission order', async () => {
    const queue = new KeyedMutationQueue()
    const events: string[] = []
    const first = deferred<void>()

    const a = queue.run('file', async () => {
      events.push('a:start')
      await first.promise
      events.push('a:end')
    })
    const b = queue.run('file', async () => {
      events.push('b:start')
    })

    // Why: the queue always defers through a promise chain, so the first task starts
    // on a microtask rather than synchronously; flush before asserting it is running.
    await Promise.resolve()
    expect(events).toEqual(['a:start'])
    first.resolve()
    await Promise.all([a, b])
    expect(events).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('runs different keys concurrently', async () => {
    const queue = new KeyedMutationQueue()
    const events: string[] = []
    const blocker = deferred<void>()

    const a = queue.run('file-a', async () => {
      events.push('a:start')
      await blocker.promise
    })
    const b = queue.run('file-b', async () => {
      events.push('b:start')
    })

    await b
    expect(events).toEqual(['a:start', 'b:start'])
    blocker.resolve()
    await a
  })

  it('keeps draining a key after a task rejects, and propagates that rejection', async () => {
    const queue = new KeyedMutationQueue()
    const failed = queue.run('file', async () => {
      throw new Error('apply failed')
    })
    const next = queue.run('file', async () => 'ok')

    await expect(failed).rejects.toThrow('apply failed')
    await expect(next).resolves.toBe('ok')
  })

  it('releases keys once drained so the map does not grow unbounded', async () => {
    const queue = new KeyedMutationQueue()
    await Promise.all([queue.run('a', async () => 1), queue.run('b', async () => 2)])
    // Why: the release hook runs in a then() continuation, so let the microtask queue flush.
    await Promise.resolve()
    await Promise.resolve()
    expect(queue.pendingKeyCount).toBe(0)
  })
})
