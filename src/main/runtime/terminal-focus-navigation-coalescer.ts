/**
 * Latest-wins single-flight coalescer for exclusive host terminal focus navigation.
 *
 * Scope: concurrent `terminal.focus` / host-nav storms (CLI switch fan-out, bulk open).
 * Not a substitute for cheaper activation or reconnect-scan bounding.
 *
 * Why: only one host terminal can be focused. Intermediate navigations are waste;
 * running them in parallel freezes large remote fleets. Pending jobs collapse to
 * the newest; in-flight work re-checks a generation so obsolete runs do not claim
 * a successful host navigation after a newer focus arrived.
 */

export type TerminalFocusNavigationContext = {
  /** True while this job is still the newest focus request. */
  isCurrent: () => boolean
}

export type TerminalFocusNavigationJob<TResult> = {
  /** Stable key for diagnostics (usually terminal handle). */
  key: string
  /**
   * Full navigation work (reveal/focus host UI).
   * Must consult `ctx.isCurrent()` before/after expensive host work and avoid
   * claiming navigation when false.
   */
  run: (ctx: TerminalFocusNavigationContext) => Promise<TResult>
  /**
   * Result when this job is dropped (pending superseded) or becomes obsolete
   * mid-flight. Must not perform host navigation. Should set navigated: false.
   */
  resolveSuperseded: () => TResult
}

type PendingJob<TResult> = {
  key: string
  generation: number
  run: (ctx: TerminalFocusNavigationContext) => Promise<TResult>
  resolve: (value: TResult) => void
  reject: (error: unknown) => void
  resolveSuperseded: () => TResult
}

export class TerminalFocusNavigationCoalescer<TResult> {
  private running = false
  private pending: PendingJob<TResult> | null = null
  private activeKey: string | null = null
  private generation = 0

  getState(): {
    running: boolean
    activeKey: string | null
    pendingKey: string | null
    generation: number
  } {
    return {
      running: this.running,
      activeKey: this.activeKey,
      pendingKey: this.pending?.key ?? null,
      generation: this.generation
    }
  }

  run(job: TerminalFocusNavigationJob<TResult>): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      if (this.pending) {
        try {
          this.pending.resolve(this.pending.resolveSuperseded())
        } catch (error) {
          this.pending.reject(error)
        }
      }
      const generation = ++this.generation
      this.pending = {
        key: job.key,
        generation,
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
        const ctx: TerminalFocusNavigationContext = {
          isCurrent: () => job.generation === this.generation
        }
        try {
          if (!ctx.isCurrent()) {
            job.resolve(job.resolveSuperseded())
            continue
          }
          const result = await job.run(ctx)
          // A newer focus arrived during run — do not claim this result as the
          // host's final navigation even if expensive work already started.
          if (!ctx.isCurrent()) {
            job.resolve(job.resolveSuperseded())
          } else {
            job.resolve(result)
          }
        } catch (error) {
          if (ctx.isCurrent()) {
            job.reject(error)
          } else {
            try {
              job.resolve(job.resolveSuperseded())
            } catch (supersedeError) {
              job.reject(supersedeError)
            }
          }
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
