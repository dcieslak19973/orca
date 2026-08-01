/**
 * RPC helpers shared by the realistic freeze harness (keeps main under max-lines).
 */
import { spawn, spawnSync } from 'node:child_process'

export function createOrcaRpc({ envName }) {
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
    const started = performance.now()
    try {
      const opened = await orcaJsonAsync(['open'], { local: true, timeoutMs: 120_000 })
      notes.push(`orca open ms=${opened.elapsedMs.toFixed(0)}`)
    } catch (error) {
      notes.push(`orca open failed: ${String(error).slice(0, 200)}`)
    }
    const storm = await runReconnectRefreshStorm(notes)
    return { wallMs: performance.now() - started, storm }
  }

  return { orcaJsonSync, orcaJsonAsync, runReconnectRefreshStorm, runRestartProxy }
}
