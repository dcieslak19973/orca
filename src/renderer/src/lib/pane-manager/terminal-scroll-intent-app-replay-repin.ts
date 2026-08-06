import type { IDisposable, Terminal } from '@xterm/xterm'
import { enforceTerminalCurrentScrollIntent, readStoredIntent } from './terminal-scroll-intent'
import { isTerminalScrollIntentRebuildInFlight } from './terminal-scroll-intent-rebuild'
import { readTerminalScrollBufferSnapshot } from './terminal-scroll-buffer-snapshot'

// Debounce to the end of the replay burst: full-conversation repaints arrive
// as several parsed chunks over one PTY round-trip. The cap bounds how long a
// continuously streaming app can hold the viewport at the wrong line.
const REPLAY_SETTLE_MS = 64
const REPLAY_SETTLE_CAP_MS = 400

/**
 * Re-enforce a pinned viewport after an app-driven scrollback rebuild.
 *
 * Why: inline TUIs that keep their transcript in the normal buffer (OMP, Pi)
 * repaint on width change by clearing scrollback (`ESC[H ESC[3J`) and
 * replaying every row. The clear clamps a scrolled-up viewport to line 0 and
 * xterm keeps it there while the replay appends below — the user lands at the
 * TOP of the conversation (#8715). The stored scroll intent survives (its
 * shrink guards were built for exactly this transient), but nothing re-applied
 * it: reveal-time enforcement runs before the repaint's bytes arrive, and
 * Orca's rebuild bracket only covers replays Orca itself initiates.
 *
 * Detection compares the durable stored pin against the live viewport: parsed
 * output that leaves a pinned terminal at the hard top arms a settle-debounced
 * re-enforcement. User gestures during the settle window stay authoritative —
 * they rewrite the stored intent, and the enforcement applies whatever intent
 * is current at fire time (a deliberate wheel to the top degrades to a no-op).
 */
export function attachTerminalScrollIntentAppReplayRepin(terminal: Terminal): IDisposable {
  // Why: never let this break pane creation if a Terminal stub or a future
  // xterm build lacks onWriteParsed — the pin then stays lost on app replays,
  // as it did before this watcher existed.
  if (typeof terminal.onWriteParsed !== 'function') {
    return { dispose: () => undefined }
  }
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let firstYankAtMs: number | null = null

  const clearPending = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    firstYankAtMs = null
  }

  const yankedPinnedViewport = (): boolean => {
    // Orca's own structural replays bracket themselves and re-apply intent
    // when they complete; never double-enforce underneath one.
    if (isTerminalScrollIntentRebuildInFlight(terminal)) {
      return false
    }
    // Why: the durable stored pin, not live-derived state — with an idle
    // agent no output lands between the user's scroll and the replay, so any
    // watcher-local memory of the pin would never have been primed.
    const stored = readStoredIntent(terminal)
    if (stored?.kind !== 'pinnedViewport' || stored.bufferType !== 'normal') {
      return false
    }
    const live = readTerminalScrollBufferSnapshot(terminal)
    // Why: the hard top is the clear's clamp target; a pin recorded at the top
    // is already where the user wants to be. Alt-screen owns its own viewport.
    return (
      live !== null && live.bufferType === 'normal' && live.viewportY === 0 && stored.viewportY > 0
    )
  }

  const fire = (): void => {
    settleTimer = null
    firstYankAtMs = null
    if (yankedPinnedViewport()) {
      enforceTerminalCurrentScrollIntent(terminal)
    }
  }

  const writeParsedDisposable = terminal.onWriteParsed(() => {
    if (!yankedPinnedViewport()) {
      clearPending()
      return
    }
    const now = Date.now()
    firstYankAtMs ??= now
    if (settleTimer !== null) {
      // Why: an unbounded per-chunk debounce would let a continuously
      // streaming replay starve the restore; stop extending at the cap.
      if (now - firstYankAtMs >= REPLAY_SETTLE_CAP_MS) {
        return
      }
      clearTimeout(settleTimer)
    }
    settleTimer = setTimeout(fire, REPLAY_SETTLE_MS)
  })

  return {
    dispose: () => {
      clearPending()
      writeParsedDisposable.dispose()
    }
  }
}
