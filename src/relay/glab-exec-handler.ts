import { spawn, type ChildProcess } from 'node:child_process'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { terminateRelaySubprocessTree } from './subprocess-tree-termination'
import { GLAB_EXEC_METHOD } from '../shared/ssh-types'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60 * 1000
// Why: glab api payloads can be large, but unbounded capture OOMs the relay.
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const GLAB_BINARY = 'glab'

type GlabExecParams = {
  args: unknown
  cwd: unknown
  timeoutMs: unknown
  env: unknown
}

type GlabExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Set when `glab` could not be spawned (e.g. ENOENT). */
  spawnError?: string
}

/**
 * Hard-allowlisted remote `glab` exec. Distinct from `agent.execNonInteractive`
 * so older relays return method-not-found and the desktop can fall back locally.
 */
export class GlabExecHandler {
  constructor(dispatcher: RelayDispatcher) {
    dispatcher.onRequest(GLAB_EXEC_METHOD, (p, context) => this.exec(p as GlabExecParams, context))
  }

  private async exec(params: GlabExecParams, context?: RequestContext): Promise<GlabExecResult> {
    const args = Array.isArray(params.args) ? params.args.map((a) => String(a)) : []
    const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : undefined
    const requestedTimeout =
      typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, requestedTimeout))
    const extraEnv =
      params.env && typeof params.env === 'object' && !Array.isArray(params.env)
        ? (params.env as Record<string, string>)
        : null
    const spawnEnv = {
      ...process.env,
      ...extraEnv
    } as Record<string, string>

    return new Promise<GlabExecResult>((resolve) => {
      let child: ChildProcess
      try {
        // Why: argv array only — never shell-interpolate user-controlled strings.
        child = spawn(GLAB_BINARY, args, {
          cwd,
          env: spawnEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false
        })
      } catch (error) {
        resolve({
          stdout: '',
          stderr: '',
          exitCode: null,
          timedOut: false,
          spawnError: error instanceof Error ? error.message : String(error)
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let timedOut = false
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let detachChildListeners = (): void => {}
      let detachRequestAbortListener = (): void => {}
      const finish = (result: GlabExecResult): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        detachRequestAbortListener()
        detachChildListeners()
        resolve(result)
      }
      const cancelCurrent = (): void => {
        terminateRelaySubprocessTree(child)
      }

      timer = setTimeout(() => {
        timedOut = true
        terminateRelaySubprocessTree(child)
        finish({ stdout, stderr, exitCode: null, timedOut })
      }, timeoutMs)

      const onStdoutData = (chunk: Buffer): void => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          terminateRelaySubprocessTree(child)
          return
        }
        stdout += chunk.toString('utf-8')
      }
      const onStderrData = (chunk: Buffer): void => {
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_OUTPUT_BYTES) {
          terminateRelaySubprocessTree(child)
          return
        }
        stderr += chunk.toString('utf-8')
      }
      const onError = (error: Error): void => {
        finish({
          stdout,
          stderr,
          exitCode: null,
          timedOut,
          spawnError: error.message
        })
      }
      const onClose = (code: number | null): void => {
        finish({ stdout, stderr, exitCode: code, timedOut })
      }
      child.stdout?.on('data', onStdoutData)
      child.stderr?.on('data', onStderrData)
      child.on('error', onError)
      child.on('close', onClose)
      detachChildListeners = () => {
        child.stdout?.off('data', onStdoutData)
        child.stderr?.off('data', onStderrData)
        child.off('error', onError)
        child.off('close', onClose)
      }

      if (context?.signal) {
        if (context.signal.aborted) {
          cancelCurrent()
        } else {
          context.signal.addEventListener('abort', cancelCurrent, { once: true })
          detachRequestAbortListener = () => {
            context.signal?.removeEventListener('abort', cancelCurrent)
          }
        }
      }
    })
  }
}
