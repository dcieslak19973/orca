/**
 * Pure metrics helpers for the live remote bulk-open freeze harness.
 * Kept separate so unit tests can drive the same code the repro uses.
 */

export const DEFAULT_SOFT_MS = 2000
export const DEFAULT_HARD_MS = 5000

export function extractTerminalHandle(result) {
  if (!result || typeof result !== 'object') {
    return null
  }
  const candidates = [
    result.handle,
    result.terminalHandle,
    result.agentTerminalHandle,
    typeof result.terminal === 'string' ? result.terminal : result.terminal?.handle,
    result.startupTerminal?.handle,
    result.tab?.terminal,
    result.tab?.handle
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.startsWith('term_')) {
      return value
    }
  }
  for (const value of Object.values(result)) {
    if (typeof value === 'string' && value.startsWith('term_')) {
      return value
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        if (typeof nested === 'string' && nested.startsWith('term_')) {
          return nested
        }
      }
    }
  }
  return null
}

export function worktreeSelector(wt) {
  if (typeof wt?.id === 'string' && wt.id.length > 0) {
    return `id:${wt.id}`
  }
  if (typeof wt?.path === 'string' && wt.path.length > 0) {
    return `path:${wt.path}`
  }
  return null
}

/**
 * Peak stall across individual switch latency and concurrent batch wall.
 * Hard freeze when peak >= hardMs (default 5000).
 */
export function evaluateFreezeSignals({
  maxSwitchMs = 0,
  maxBatchWallMs = 0,
  statusProbeMs = 0,
  memoryProbeMs = null,
  softMs = DEFAULT_SOFT_MS,
  hardMs = DEFAULT_HARD_MS
}) {
  const peakLatencyMs = Math.max(maxSwitchMs, maxBatchWallMs)
  const softFreeze =
    peakLatencyMs >= softMs ||
    statusProbeMs >= softMs ||
    (memoryProbeMs != null && memoryProbeMs >= softMs)
  const hardFreeze =
    peakLatencyMs >= hardMs ||
    statusProbeMs >= hardMs ||
    (memoryProbeMs != null && memoryProbeMs >= hardMs)
  return { peakLatencyMs, softFreeze, hardFreeze }
}

export function shouldCapSwitchTargets(maxSwitchTargets) {
  return Number.isFinite(maxSwitchTargets) && maxSwitchTargets > 0
}

export function applySwitchTargetCap(targets, maxSwitchTargets) {
  if (!shouldCapSwitchTargets(maxSwitchTargets)) {
    return targets
  }
  return targets.slice(0, maxSwitchTargets)
}

/** Scenarios that model real user recovery, not concurrent CLI pileup. */
export const REALISTIC_SCENARIOS = [
  'idle-backlog-open',
  'idle-backlog-reconnect-open',
  'restart-proxy'
]

/**
 * Peak across open latencies + optional reconnect-refresh wall + probes.
 * Used by the naturalistic harness (no parallel switch amp).
 */
export function evaluateRealisticFreezeSignals({
  maxOpenMs = 0,
  firstOpenMs = 0,
  reconnectRefreshMs = 0,
  statusProbeMs = 0,
  memoryProbeMs = null,
  softMs = DEFAULT_SOFT_MS,
  hardMs = DEFAULT_HARD_MS
}) {
  const peakLatencyMs = Math.max(maxOpenMs, firstOpenMs, reconnectRefreshMs)
  return evaluateFreezeSignals({
    maxSwitchMs: peakLatencyMs,
    maxBatchWallMs: 0,
    statusProbeMs,
    memoryProbeMs,
    softMs,
    hardMs
  })
}

export function humanPaceDelayMs(baseMs, jitterMs = 0) {
  const base = Math.max(0, baseMs)
  const jitter = Math.max(0, jitterMs)
  if (jitter === 0) {
    return base
  }
  return base + Math.floor(Math.random() * (jitter + 1))
}
