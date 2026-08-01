/**
 * Latest-wins single-flight coalescer for host terminal focus/reveal navigation.
 *
 * Why: concurrent terminal.focus / bulk-open storms (remote multi-session open,
 * wake reconnect, CLI switch fan-out) each trigger a full reveal + worktree
 * activation. Intermediate focuses are discarded by the next focus anyway; only
 * the newest request needs to pay for navigation. Running them all in parallel
 * freezes the renderer under large remote fleets.
 */

export type TerminalFocusNavigationJob<TResult> = {
  /** Stable key for diagnostics (usually terminal handle). */
  key: string
  /** Full navigation work (reveal/focus host UI). */
  run: () => Promise<TResult>
  /**
   * Cheap result when this job is superseded by a newer focus while waiting.
   * Must not perform host navigation.
   */
  resolveSuperseded: () => TResult
}

type PendingJob<TResult> = {
  key: string
  run: () => Promise<TResult>
  resolve: (value: TResult) => void
  reject: (error: unknown) => void
  resolveSuperseded: () => TResult
}

export class TerminalFocusNavigationCoalescer<TResult> {
  private running = false
  private pending: PendingJob<TResult> | null = null
  private activeKey: string | null = null

  /** Keys currently waiting or running — test/observability aid. */
  getState(): { running: boolean; activeKey: string | null; pendingKey: string | null } {
    return {
      running: this.running,
      activeKey: this.activeKey,
      pendingKey: this.pending?.key ?? null
    }
  }

  run(job: TerminalFocusNavigationJob<TResult>): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      if (this.pending) {
        // Drop intermediate focus — UI would only show the latest anyway.
        try {
          this.pending.resolve(this.pending.resolveSuperseded())
        } catch (error) {
          this.pending.reject(error)
        }
      }
      this.pending = {
        key: job.key,
        run: job.run,
        resolve,
        reject,
        resolveSuperseded: job.resolveSuperseded
      }
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      while (this.pending) {
        const job = this.pending
        this.pending = null
        this.activeKey = job.key
        try {
          const result = await job.run()
          job.resolve(result)
        } catch (error) {
          job.reject(error)
        } finally {
          this.activeKey = null
        }
      }
    } finally {
      this.running = false
      if (this.pending) {
        void this.pump()
      }
    }
  }
}
