import type { RuntimeCapability } from '../../../shared/protocol-version'

const checks = new Map<string, Promise<boolean>>()

export function runCoalescedRuntimeCapabilityCheck(
  environmentId: string,
  capability: RuntimeCapability,
  run: () => Promise<boolean>
): Promise<boolean> {
  const key = `${environmentId}\0${capability}`
  const pending = checks.get(key)
  if (pending) {
    return pending
  }
  const check = run().finally(() => {
    if (checks.get(key) === check) {
      checks.delete(key)
    }
  })
  checks.set(key, check)
  return check
}

export function clearCoalescedRuntimeCapabilityChecks(environmentId?: string): void {
  if (!environmentId) {
    checks.clear()
    return
  }
  for (const key of checks.keys()) {
    if (key.startsWith(`${environmentId}\0`)) {
      checks.delete(key)
    }
  }
}
