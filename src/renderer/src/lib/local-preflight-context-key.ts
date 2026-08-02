import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

type LocalPreflightContextKeyInput =
  | {
      wslDistro?: string | null
      wslDefault?: boolean
      runtimeContextKey?: string
      projectRuntime?: ProjectExecutionRuntimeResolution
      sshHost?: { connectionId: string; hostLabel: string }
    }
  | undefined

export function localPreflightContextKey(context: LocalPreflightContextKeyInput): string {
  if (context?.projectRuntime) {
    return context.projectRuntime.status === 'resolved'
      ? context.projectRuntime.runtime.cacheKey
      : context.projectRuntime.repair.cacheKey
  }
  if (context?.runtimeContextKey) {
    return context.runtimeContextKey
  }
  // Why: two SSH hosts answer differently, so a host switch must invalidate the
  // cached status instead of leaving the previous host's label on the card.
  if (context?.sshHost) {
    return `ssh:${context.sshHost.connectionId}`
  }
  if (context?.wslDistro) {
    return `wsl:${context.wslDistro}`
  }
  return context?.wslDefault ? 'wsl:default' : 'host'
}
