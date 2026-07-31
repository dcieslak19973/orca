import type { IPtyProvider } from '../providers/types'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { combineUnsubscribes } from './combine-unsubscribes'

export async function probePtyOwners(
  id: string,
  routed: IPtyProvider | undefined,
  possibleOwners: readonly DaemonPtyAdapter[]
): Promise<boolean | null> {
  if (routed) {
    return routed.probePtyLiveness
      ? await routed.probePtyLiveness(id)
      : (routed.hasPty?.(id) ?? null)
  }
  const results = await Promise.all(possibleOwners.map((provider) => provider.probePtyLiveness(id)))
  return results.some((result) => result === true)
    ? true
    : results.every((result) => result === false)
      ? false
      : null
}

export function subscribePtyLivenessAuthority(
  providers: readonly IPtyProvider[],
  callback: (payload: { id: string }) => void
): () => void {
  return combineUnsubscribes(
    providers.map((provider) => provider.onPtyLivenessAuthorityChanged?.(callback) ?? (() => {}))
  )
}
