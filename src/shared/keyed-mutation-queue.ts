/**
 * Serializes async work per key so read-modify-write sequences against the same
 * resource cannot interleave. Distinct keys still run concurrently.
 */
export class KeyedMutationQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve()
    // Why: run on both settle paths — one failed task must not wedge the key forever.
    const result = prior.then(task, task)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      // Why: release the key once this is the last queued task, else the map grows per file forever.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key)
      }
    })
    return result
  }

  /** Queue depth bookkeeping for tests; production code should not branch on this. */
  get pendingKeyCount(): number {
    return this.tails.size
  }
}
