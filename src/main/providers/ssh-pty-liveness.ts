import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { toRelaySshPtyId } from './ssh-pty-id'

const SSH_PTY_LIVENESS_TIMEOUT_MS = 1_000
const SSH_PTY_LIVENESS_AUTHORITY_TIMEOUT_MS = 15_000

function applySshPtyLiveness(id: string, live: boolean, livePtyIds: Set<string>): boolean {
  if (live) {
    livePtyIds.add(id)
  } else {
    livePtyIds.delete(id)
  }
  return live
}

export async function probeSshPtyLiveness(
  mux: SshChannelMultiplexer,
  connectionId: string,
  id: string,
  livePtyIds: Set<string>,
  lateAuthority?: {
    isCurrent: () => boolean
    announce: (id: string) => void
    settled: () => void
  }
): Promise<boolean | null> {
  const timedOut = Symbol('timed-out')
  let timeout: ReturnType<typeof setTimeout> | null = null
  let waitsForLateAuthority = false
  let request: Promise<unknown>
  try {
    request = mux.request(
      'pty.getSize',
      {
        id: toRelaySshPtyId(connectionId, id)
      },
      { timeoutMs: SSH_PTY_LIVENESS_AUTHORITY_TIMEOUT_MS }
    )
  } catch (error) {
    request = Promise.reject(error)
  }
  const probe = request.then((size) => Boolean(size))
  try {
    const result = await Promise.race([
      probe,
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), SSH_PTY_LIVENESS_TIMEOUT_MS)
      })
    ])
    if (result === timedOut) {
      waitsForLateAuthority = true
      void probe.then(
        (live) => {
          try {
            if (lateAuthority && !lateAuthority.isCurrent()) {
              return
            }
            applySshPtyLiveness(id, live, livePtyIds)
            lateAuthority?.announce(id)
          } finally {
            lateAuthority?.settled()
          }
        },
        () => lateAuthority?.settled()
      )
      return null
    }
    if (lateAuthority && !lateAuthority.isCurrent()) {
      return null
    }
    return applySshPtyLiveness(id, result, livePtyIds)
  } catch {
    return null
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
    if (!waitsForLateAuthority) {
      lateAuthority?.settled()
    }
  }
}

export class SshPtyLivenessAuthority {
  private readonly listeners = new Set<(payload: { id: string }) => void>()
  private readonly tokens = new Map<string, object>()
  private readonly inFlight = new Map<string, { token: object; promise: Promise<boolean | null> }>()
  private disposed = false

  probe(
    mux: SshChannelMultiplexer,
    connectionId: string,
    id: string,
    livePtyIds: Set<string>
  ): Promise<boolean | null> {
    const existing = this.inFlight.get(id)
    if (existing) {
      return existing.promise
    }
    const token = {}
    this.tokens.set(id, token)
    let entry: { token: object; promise: Promise<boolean | null> }
    const promise = probeSshPtyLiveness(mux, connectionId, id, livePtyIds, {
      isCurrent: () => !this.disposed && this.tokens.get(id) === token,
      announce: (ptyId) => {
        for (const listener of this.listeners) {
          listener({ id: ptyId })
        }
      },
      settled: () => {
        if (this.inFlight.get(id) === entry) {
          this.inFlight.delete(id)
        }
        if (this.tokens.get(id) === token) {
          this.tokens.delete(id)
        }
      }
    })
    entry = { token, promise }
    this.inFlight.set(id, entry)
    return promise
  }

  invalidate(id: string): void {
    this.tokens.delete(id)
    this.inFlight.delete(id)
  }

  subscribe(listener: (payload: { id: string }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.tokens.clear()
    this.inFlight.clear()
  }
}
