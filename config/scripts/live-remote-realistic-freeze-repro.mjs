#!/usr/bin/env node
/**
 * Naturalistic freeze repro — Tim/Expand + Brandon/Uber recovery stories.
 *
 * Unlike the bulk parallel-switch amplifier, this models:
 *   1) agents streaming on remote while user is idle (backlog builds)
 *   2) user returns and opens sessions one-by-one (or after reconnect refresh)
 *
 * Scenarios:
 *   idle-backlog-open            — idle with flood, then human-paced sequential open
 *   idle-backlog-reconnect-open  — same + wake-like metadata refresh storm, then open
 *   restart-proxy                — idle, then orca open + status/list storm + open
 *                                  (does NOT kill the desktop; proxies restore work)
 *
 * Usage:
 *   ORCA_FREEZE_ENV=awin ORCA_FREEZE_SCENARIO=idle-backlog-open \
 *     node config/scripts/live-remote-realistic-freeze-repro.mjs
 *
 *   pnpm run repro:live-remote-realistic-freeze
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_HARD_MS,
  DEFAULT_SOFT_MS,
  evaluateRealisticFreezeSignals,
  extractTerminalHandle,
  humanPaceDelayMs,
  REALISTIC_SCENARIOS,
  worktreeSelector
} from './live-remote-bulk-open-freeze-metrics.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const reportDir = path.join(root, 'test-results', 'freeze-repro')
const envName = process.env.ORCA_FREEZE_ENV || 'awin'
const scenario = process.env.ORCA_FREEZE_SCENARIO || 'idle-backlog-open'
const createCount = Math.max(0, Number(process.env.ORCA_FREEZE_CREATE || '8'))
const openCount = Math.max(2, Number(process.env.ORCA_FREEZE_OPEN_COUNT || '20'))
const idleMs = Math.max(0, Number(process.env.ORCA_FREEZE_IDLE_MS || '45000'))
const paceMs = Math.max(0, Number(process.env.ORCA_FREEZE_PACE_MS || '250'))
const paceJitterMs = Math.max(0, Number(process.env.ORCA_FREEZE_PACE_JITTER_MS || '150'))
const createWorktreeSpan = Math.max(1, Number(process.env.ORCA_FREEZE_CREATE_WT_SPAN || '12'))
const softMs = Number(process.env.ORCA_FREEZE_SOFT_MS || DEFAULT_SOFT_MS)
const hardMs = Number(process.env.ORCA_FREEZE_HARD_MS || DEFAULT_HARD_MS)
const scratchDir = process.env.ORCA_FREEZE_SCRATCH || ''

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function orcaJsonSync(args, opts = {}) {
  const started = performance.now()
  const result = spawnSync(
    'orca',
    [...args, ...(opts.local ? [] : ['--environment', envName]), '--json'],
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 120_000
    }
  )
  const elapsedMs = performance.now() - started
  if (result.status !== 0) {
    throw new Error(
      `orca ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`
    )
  }
  const parsed = JSON.parse(result.stdout)
  if (parsed.ok === false) {
    throw new Error(`orca ${args.join(' ')} ok=false: ${JSON.stringify(parsed)}`)
  }
  return { parsed, elapsedMs, result: parsed.result }
}

function orcaJsonAsync(args, opts = {}) {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const child = spawn(
      'orca',
      [...args, ...(opts.local ? [] : ['--environment', envName]), '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`orca ${args.join(' ')} timed out after ${opts.timeoutMs ?? 120_000}ms`))
    }, opts.timeoutMs ?? 120_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const elapsedMs = performance.now() - started
      if (code !== 0) {
        reject(
          new Error(`orca ${args.join(' ')} failed (${code}): ${stderr || stdout}`.slice(0, 800))
        )
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.ok === false) {
          reject(
            new Error(`orca ${args.join(' ')} ok=false: ${JSON.stringify(parsed)}`.slice(0, 800))
          )
          return
        }
        resolve({ parsed, elapsedMs, result: parsed.result })
      } catch (error) {
        reject(new Error(`orca parse failed: ${error}; stdout=${stdout.slice(0, 400)}`))
      }
    })
  })
}

async function mapPool(items, concurrency, worker) {
  const results = Array.from({ length: items.length })
  let next = 0
  async function run() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run())
  )
  return results
}

function floodCommand(marker) {
  const script =
    "const m=process.argv[1];process.stdout.write('READY:'+m+'\\n');let f=0;const c='A'.repeat(2048);setInterval(()=>{f++;process.stdout.write('BG:'+m+':'+f+':'+c+'\\n')},8);process.stdin.resume()"
  return `node -e ${JSON.stringify(script)} ${JSON.stringify(marker)}`
}

function sampleOrcaIfPossible() {
  try {
    const status = orcaJsonSync(['status'], { local: true }).result
    const pid = status?.app?.pid
    if (!pid) {
      return null
    }
    const out = path.join(reportDir, `orca-sample-realistic-${Date.now()}.txt`)
    spawnSync('sample', [String(pid), '5', '-file', out], {
      timeout: 20_000,
      stdio: 'ignore'
    })
    return out
  } catch {
    return null
  }
}

function listLiveTerminalHandles() {
  const listed = orcaJsonSync(['terminal', 'list'])
  const terms = listed.result?.terminals || []
  return terms
    .filter((t) => typeof t.handle === 'string' && t.handle.startsWith('term_'))
    .map((t) => ({
      handle: t.handle,
      title: t.title,
      worktreeId: t.worktreeId,
      connected: t.connected
    }))
}

/**
 * Wake/reconnect proxy: fan-out the cheap metadata RPCs that fire when a
 * runtime becomes reachable again (status, worktrees, terminals).
 * Does not kill Tailscale; models the *client-side refresh storm* half of wake.
 */
async function runReconnectRefreshStorm(notes) {
  const started = performance.now()
  const jobs = [
    () => orcaJsonAsync(['status'], { timeoutMs: 90_000 }),
    () => orcaJsonAsync(['worktree', 'list'], { timeoutMs: 120_000 }),
    () => orcaJsonAsync(['terminal', 'list'], { timeoutMs: 120_000 }),
    () => orcaJsonAsync(['status'], { local: true, timeoutMs: 60_000 }),
    () => orcaJsonAsync(['worktree', 'list'], { timeoutMs: 120_000 }),
    () => orcaJsonAsync(['terminal', 'list'], { timeoutMs: 120_000 })
  ]
  const results = await Promise.all(
    jobs.map(async (job, index) => {
      try {
        const r = await job()
        return { index, ok: true, ms: r.elapsedMs }
      } catch (error) {
        notes.push(`reconnect-refresh job ${index} failed: ${String(error).slice(0, 200)}`)
        return { index, ok: false, ms: null, error: String(error) }
      }
    })
  )
  const wallMs = performance.now() - started
  const maxJobMs = Math.max(0, ...results.map((r) => r.ms || 0))
  notes.push(
    `reconnect-refresh wall=${wallMs.toFixed(0)}ms maxJob=${maxJobMs.toFixed(0)}ms ok=${results.filter((r) => r.ok).length}/${results.length}`
  )
  return { wallMs, maxJobMs, results }
}

async function runRestartProxy(notes) {
  // Do not kill the user's desktop. `orca open` + full graph refresh approximates
  // post-restart discovery without destructive process kill.
  const started = performance.now()
  try {
    const opened = await orcaJsonAsync(['open'], { local: true, timeoutMs: 120_000 })
    notes.push(`orca open ms=${opened.elapsedMs.toFixed(0)}`)
  } catch (error) {
    notes.push(`orca open failed: ${String(error).slice(0, 200)}`)
  }
  const storm = await runReconnectRefreshStorm(notes)
  return {
    wallMs: performance.now() - started,
    storm
  }
}

async function main() {
  if (!REALISTIC_SCENARIOS.includes(scenario)) {
    throw new Error(
      `Unknown ORCA_FREEZE_SCENARIO=${scenario}. Expected one of: ${REALISTIC_SCENARIOS.join(', ')}`
    )
  }

  mkdirSync(reportDir, { recursive: true })
  const notes = []
  const phases = []
  const openTimings = []

  console.log(
    `[realistic-freeze] scenario=${scenario} env=${envName} create=${createCount} idleMs=${idleMs} openCount=${openCount} paceMs=${paceMs}`
  )

  const local = orcaJsonSync(['status'], { local: true })
  const remote = orcaJsonSync(['status'])
  notes.push(
    `local version=${local.result?.runtime?.appVersion} pid=${local.result?.app?.pid}`,
    `remote version=${remote.result?.runtime?.appVersion} state=${remote.result?.runtime?.state}`
  )

  const worktrees = orcaJsonSync(['worktree', 'list']).result
  const wtList = worktrees?.worktrees || worktrees?.items || worktrees || []
  if (!Array.isArray(wtList) || wtList.length === 0) {
    throw new Error(`No worktrees on environment ${envName}`)
  }
  notes.push(`remote worktrees=${wtList.length}`)
  phases.push({ phase: 'baseline', worktrees: wtList.length })

  // --- Phase: seed flood terminals (agent-like backlog sources) ---
  const created = []
  if (createCount > 0) {
    const targets = wtList.slice(0, Math.min(createWorktreeSpan, wtList.length))
    await mapPool(
      Array.from({ length: createCount }, (_, i) => i),
      Math.min(4, createCount),
      async (i) => {
        const wt = targets[i % targets.length]
        const selector = worktreeSelector(wt)
        if (!selector) {
          return
        }
        const marker = `REALISTIC_${Date.now()}_${i}`
        try {
          const createdTerm = await orcaJsonAsync(
            [
              'terminal',
              'create',
              '--worktree',
              selector,
              '--title',
              `realistic-freeze-${i}`,
              '--command',
              floodCommand(marker)
            ],
            { timeoutMs: 180_000 }
          )
          const handle = extractTerminalHandle(createdTerm.result)
          if (handle) {
            created.push({ handle, marker, worktree: selector })
            console.log(
              `[realistic-freeze] flood terminal ${handle} (${createdTerm.elapsedMs.toFixed(0)}ms)`
            )
          } else {
            notes.push(
              `create ${i} missing handle: ${JSON.stringify(createdTerm.result).slice(0, 300)}`
            )
          }
        } catch (error) {
          notes.push(`create ${i} failed: ${String(error).slice(0, 250)}`)
          console.warn(`[realistic-freeze] create failed: ${error}`)
        }
      }
    )
    phases.push({ phase: 'seed-flood', created: created.length })
  }

  // Prefer created floods for open pass; fill with existing live terminals.
  let live = []
  try {
    live = listLiveTerminalHandles()
    notes.push(`live terminals listed=${live.length}`)
  } catch (error) {
    notes.push(`terminal list failed: ${String(error).slice(0, 200)}`)
  }

  const openTargets = [...created.map((c) => c.handle), ...live.map((t) => t.handle)].filter(
    (v, i, a) => typeof v === 'string' && a.indexOf(v) === i
  )

  if (openTargets.length < 2) {
    throw new Error(`Need ≥2 terminals; got ${openTargets.length}. ${notes.join('; ')}`)
  }

  const openList = openTargets.slice(0, Math.min(openCount, openTargets.length))

  // --- Phase: park — leave one session focused, rest accumulate flood while "away" ---
  try {
    const parkHandle = openList[0]
    const parked = await orcaJsonAsync(['terminal', 'switch', '--terminal', parkHandle], {
      timeoutMs: 60_000
    })
    notes.push(`park switch ms=${parked.elapsedMs.toFixed(0)} handle=${parkHandle}`)
  } catch (error) {
    notes.push(`park switch failed: ${String(error).slice(0, 200)}`)
  }

  console.log(`[realistic-freeze] idle ${idleMs}ms while remotes stream (user away / asleep)`)
  const idleStarted = performance.now()
  await sleep(idleMs)
  phases.push({ phase: 'idle', idleMs, actualMs: performance.now() - idleStarted })

  // --- Phase: recovery trigger ---
  let reconnectRefreshMs = 0
  if (scenario === 'idle-backlog-reconnect-open') {
    console.log(
      '[realistic-freeze] wake/reconnect proxy: parallel status/worktree/terminal refresh'
    )
    const storm = await runReconnectRefreshStorm(notes)
    reconnectRefreshMs = Math.max(storm.wallMs, storm.maxJobMs)
    phases.push({
      phase: 'reconnect-refresh',
      wallMs: storm.wallMs,
      maxJobMs: storm.maxJobMs
    })
  } else if (scenario === 'restart-proxy') {
    console.log('[realistic-freeze] restart proxy: orca open + refresh storm (no process kill)')
    const restart = await runRestartProxy(notes)
    reconnectRefreshMs = Math.max(restart.wallMs, restart.storm.wallMs, restart.storm.maxJobMs)
    phases.push({
      phase: 'restart-proxy',
      wallMs: restart.wallMs,
      reconnectWallMs: restart.storm.wallMs
    })
  }

  // --- Phase: human-paced sequential open (Tim: open remote sessions again) ---
  console.log(
    `[realistic-freeze] human-paced open of ${openList.length} sessions (pace≈${paceMs}ms + jitter)`
  )
  let maxOpenMs = 0
  let firstOpenMs = 0
  let sumOpenMs = 0
  let openOk = 0
  const openStarted = performance.now()

  for (let i = 0; i < openList.length; i += 1) {
    const handle = openList[i]
    try {
      const sw = await orcaJsonAsync(['terminal', 'switch', '--terminal', handle], {
        timeoutMs: 90_000
      })
      openOk += 1
      sumOpenMs += sw.elapsedMs
      maxOpenMs = Math.max(maxOpenMs, sw.elapsedMs)
      if (i === 0) {
        firstOpenMs = sw.elapsedMs
      }
      openTimings.push({ handle, ms: sw.elapsedMs, index: i })
      if (sw.elapsedMs >= softMs) {
        console.warn(`[realistic-freeze] SOFT open #${i} ${handle}: ${sw.elapsedMs.toFixed(0)}ms`)
      }
      if (sw.elapsedMs >= hardMs) {
        console.warn(`[realistic-freeze] HARD open #${i} ${handle}: ${sw.elapsedMs.toFixed(0)}ms`)
      }
    } catch (error) {
      openTimings.push({ handle, error: String(error), index: i })
      notes.push(`open ${handle} failed: ${String(error).slice(0, 200)}`)
    }
    if (i < openList.length - 1) {
      await sleep(humanPaceDelayMs(paceMs, paceJitterMs))
    }
  }

  const openWallMs = performance.now() - openStarted
  phases.push({
    phase: 'human-paced-open',
    count: openList.length,
    ok: openOk,
    maxOpenMs,
    firstOpenMs,
    openWallMs
  })

  const statusProbe = orcaJsonSync(['status'], { local: true })
  let memoryProbeMs = null
  try {
    const mem = orcaJsonSync(['diagnostics', 'memory'], { local: true, timeoutMs: 120_000 })
    memoryProbeMs = mem.elapsedMs
    notes.push(`memory diagnostic ms=${mem.elapsedMs.toFixed(0)}`)
  } catch (error) {
    notes.push(`memory diagnostic failed: ${String(error).slice(0, 200)}`)
  }

  const signals = evaluateRealisticFreezeSignals({
    maxOpenMs,
    firstOpenMs,
    reconnectRefreshMs,
    statusProbeMs: statusProbe.elapsedMs,
    memoryProbeMs,
    softMs,
    hardMs
  })

  let samplePath = null
  if (signals.softFreeze || signals.hardFreeze) {
    samplePath = sampleOrcaIfPossible()
    if (samplePath) {
      notes.push(`sample=${samplePath}`)
    } else {
      notes.push('sample unavailable')
    }
  }

  const report = {
    topology: 'live-paired-remote-realistic',
    scenario,
    story:
      scenario === 'idle-backlog-open'
        ? 'User away while remotes stream; returns and opens sessions one-by-one (Tim).'
        : scenario === 'idle-backlog-reconnect-open'
          ? 'User away; wake-like reconnect metadata storm; then opens sessions (Brandon/Tim wake).'
          : 'User away; restart-proxy discovery; then opens sessions.',
    environment: envName,
    localVersion: local.result?.runtime?.appVersion,
    remoteVersion: remote.result?.runtime?.appVersion,
    remoteWorktreeCount: wtList.length,
    createdFloodTerminals: created.length,
    openTargets: openList.length,
    idleMs,
    paceMs,
    paceJitterMs,
    firstOpenMs,
    maxOpenMs,
    avgOpenMs: openOk ? sumOpenMs / openOk : 0,
    openWallMs,
    reconnectRefreshMs,
    peakLatencyMs: signals.peakLatencyMs,
    statusProbeMs: statusProbe.elapsedMs,
    memoryProbeMs,
    softFreeze: signals.softFreeze,
    hardFreeze: signals.hardFreeze,
    softMs,
    hardMs,
    phases,
    notes,
    openTimings: openTimings.slice(-80)
  }

  const outPath = path.join(reportDir, `live-realistic-freeze-${envName}-${scenario}.json`)
  const stamped = path.join(
    reportDir,
    `live-realistic-freeze-${envName}-${scenario}-peak-${Date.now()}.json`
  )
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(stamped, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[realistic-freeze] report ${outPath}`)
  console.log(JSON.stringify(report, null, 2))

  if (scratchDir) {
    try {
      mkdirSync(scratchDir, { recursive: true })
      copyFileSync(outPath, path.join(scratchDir, 'live-realistic-freeze-report.json'))
    } catch (error) {
      console.warn(`[realistic-freeze] scratch copy failed: ${error}`)
    }
  }

  if (signals.hardFreeze) {
    process.exitCode = 2
    console.error('[realistic-freeze] HARD FREEZE SIGNAL')
  } else if (signals.softFreeze) {
    process.exitCode = 1
    console.error('[realistic-freeze] SOFT FREEZE SIGNAL')
  } else {
    console.log('[realistic-freeze] no freeze signal under thresholds')
  }
}

main().catch((error) => {
  console.error('[realistic-freeze] failed', error)
  process.exit(3)
})
