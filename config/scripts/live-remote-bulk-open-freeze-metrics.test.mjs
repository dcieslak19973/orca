import { describe, expect, it } from 'vitest'
import {
  applySwitchTargetCap,
  evaluateFreezeSignals,
  evaluateRealisticFreezeSignals,
  extractTerminalHandle,
  humanPaceDelayMs,
  REALISTIC_SCENARIOS,
  shouldCapSwitchTargets,
  worktreeSelector
} from './live-remote-bulk-open-freeze-metrics.mjs'

describe('live-remote-bulk-open-freeze-metrics', () => {
  it('extracts term_ handles from nested create payloads', () => {
    expect(extractTerminalHandle({ handle: 'term_abc' })).toBe('term_abc')
    expect(extractTerminalHandle({ terminal: { handle: 'term_nested' } })).toBe('term_nested')
    expect(extractTerminalHandle({ tab: { terminal: 'term_tab' } })).toBe('term_tab')
    expect(extractTerminalHandle({ startupTerminal: { handle: 'term_start' } })).toBe('term_start')
    expect(extractTerminalHandle({ junk: { deep: 'term_deep' } })).toBe('term_deep')
    expect(extractTerminalHandle({ handle: 'not-a-term' })).toBeNull()
    expect(extractTerminalHandle(null)).toBeNull()
  })

  it('builds worktree selectors from id/path', () => {
    expect(
      worktreeSelector({ id: 'repo::C:/Users/neil/orca/orca', path: 'C:/Users/neil/orca/orca' })
    ).toBe('id:repo::C:/Users/neil/orca/orca')
    expect(worktreeSelector({ path: '/tmp/x' })).toBe('path:/tmp/x')
    expect(worktreeSelector({})).toBeNull()
  })

  it('does not cap switch targets when max is 0 (regression for Math.max(2,0) bug)', () => {
    expect(shouldCapSwitchTargets(0)).toBe(false)
    expect(shouldCapSwitchTargets(-1)).toBe(false)
    expect(shouldCapSwitchTargets(2)).toBe(true)
    const many = Array.from({ length: 111 }, (_, i) => `term_${i}`)
    expect(applySwitchTargetCap(many, 0)).toHaveLength(111)
    expect(applySwitchTargetCap(many, 2)).toHaveLength(2)
  })

  it('classifies hard freeze at >=5000ms peak (individual or batch wall)', () => {
    expect(evaluateFreezeSignals({ maxSwitchMs: 3874, maxBatchWallMs: 3874 }).hardFreeze).toBe(
      false
    )
    expect(evaluateFreezeSignals({ maxSwitchMs: 3874, maxBatchWallMs: 3874 }).softFreeze).toBe(true)

    const hardIndividual = evaluateFreezeSignals({ maxSwitchMs: 19954, maxBatchWallMs: 1000 })
    expect(hardIndividual.hardFreeze).toBe(true)
    expect(hardIndividual.peakLatencyMs).toBe(19954)

    const hardBatch = evaluateFreezeSignals({ maxSwitchMs: 900, maxBatchWallMs: 20201 })
    expect(hardBatch.hardFreeze).toBe(true)
    expect(hardBatch.peakLatencyMs).toBe(20201)
  })

  it('evaluates naturalistic peaks without requiring parallel batch amp', () => {
    expect(REALISTIC_SCENARIOS).toContain('idle-backlog-open')
    expect(REALISTIC_SCENARIOS).toContain('idle-backlog-reconnect-open')
    const soft = evaluateRealisticFreezeSignals({
      maxOpenMs: 3200,
      firstOpenMs: 2800,
      reconnectRefreshMs: 900
    })
    expect(soft.softFreeze).toBe(true)
    expect(soft.hardFreeze).toBe(false)
    expect(soft.peakLatencyMs).toBe(3200)

    const hardFromReconnect = evaluateRealisticFreezeSignals({
      maxOpenMs: 800,
      firstOpenMs: 700,
      reconnectRefreshMs: 6200
    })
    expect(hardFromReconnect.hardFreeze).toBe(true)
    expect(hardFromReconnect.peakLatencyMs).toBe(6200)
  })

  it('human pace delay stays within base+jitter', () => {
    for (let i = 0; i < 20; i += 1) {
      const d = humanPaceDelayMs(250, 150)
      expect(d).toBeGreaterThanOrEqual(250)
      expect(d).toBeLessThanOrEqual(400)
    }
    expect(humanPaceDelayMs(100, 0)).toBe(100)
  })

  it('reads the real hard-freeze lab report when present', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const reportPath = resolve(
      process.cwd(),
      'test-results/freeze-repro/live-bulk-open-freeze-awin.json'
    )
    if (!existsSync(reportPath)) {
      // Local clones without lab artifacts still pass pure metrics tests above.
      return
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const evaluated = evaluateFreezeSignals({
      maxSwitchMs: report.maxSwitchMs,
      maxBatchWallMs: report.maxBatchWallMs ?? 0,
      statusProbeMs: report.statusProbeMs ?? 0,
      memoryProbeMs: report.memoryProbeMs,
      softMs: report.softMs,
      hardMs: report.hardMs
    })
    expect(evaluated.hardFreeze).toBe(report.hardFreeze)
    expect(evaluated.peakLatencyMs).toBeGreaterThanOrEqual(5000)
    expect(report.environment).toBe('awin')
    expect(report.switchTargets).toBeGreaterThan(50)
    expect(report.parallel).toBeGreaterThanOrEqual(8)
  })
})
