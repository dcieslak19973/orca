import { AppState } from 'react-native'
import type { RuntimeClientEventStreamMessage } from '../../../src/shared/runtime-client-events'
import type { RpcClient } from '../transport/rpc-client'

const WORKTREE_REFRESH_MS = 3000

type WorktreeRefreshOptions = { allowDuringModal?: boolean; queueIfInFlight?: boolean }
type RepoRefreshOptions = { force?: boolean; queueIfInFlight?: boolean }

type HostWorktreeRefreshArgs = {
  client: RpcClient
  fetchWorktrees: (options?: WorktreeRefreshOptions) => Promise<void>
  fetchRepoMetadata: (options?: RepoRefreshOptions) => Promise<void>
}

export class HostWorktreeRequestGate {
  private readonly inFlight = new WeakSet<RpcClient>()
  private readonly pending = new WeakMap<RpcClient, WorktreeRefreshOptions>()

  begin(client: RpcClient, options: WorktreeRefreshOptions): boolean {
    if (this.inFlight.has(client)) {
      if (options.queueIfInFlight) {
        const pending = this.pending.get(client)
        this.pending.set(client, {
          queueIfInFlight: true,
          ...(pending?.allowDuringModal || options.allowDuringModal
            ? { allowDuringModal: true }
            : {})
        })
      }
      return false
    }
    this.inFlight.add(client)
    return true
  }

  isSuperseded(client: RpcClient): boolean {
    return this.pending.has(client)
  }

  finish(client: RpcClient): WorktreeRefreshOptions | null {
    const pending = this.pending.get(client) ?? null
    this.pending.delete(client)
    this.inFlight.delete(client)
    return pending
  }
}

export function startHostWorktreeRefresh({
  client,
  fetchWorktrees,
  fetchRepoMetadata
}: HostWorktreeRefreshArgs): () => void {
  let stale = false
  let eventStreamReady = false

  const refreshOnForeground = (): void => {
    if (AppState.currentState !== 'active') {
      return
    }
    void fetchWorktrees({ allowDuringModal: true, queueIfInFlight: true })
    void fetchRepoMetadata({ queueIfInFlight: true })
  }

  const appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      refreshOnForeground()
    }
  })
  const interval = setInterval(() => {
    if (AppState.currentState !== 'active') {
      return
    }
    void fetchWorktrees()
    // Why: desktop Settings repo edits (icon/color/name, repo removal) notify only the
    // renderer IPC, not the runtime clientEvents stream, so `reposChanged` never reaches
    // mobile. Keep a periodic repo.list as the convergence safety-net; fetchRepoMetadata
    // self-throttles to REPO_METADATA_REFRESH_MS (60s), so this is ~1 request/min while
    // foregrounded — the AppState gate is what removes the waste (both stop while backgrounded).
    void fetchRepoMetadata()
  }, WORKTREE_REFRESH_MS)
  const unsubscribe = client.subscribe(
    'runtime.clientEvents.subscribe',
    null,
    (payload: unknown) => {
      if (stale || !payload || typeof payload !== 'object') {
        return
      }
      const event = payload as RuntimeClientEventStreamMessage | { type: 'error' }
      if (event.type === 'ready') {
        const replayedAfterReconnect = eventStreamReady
        eventStreamReady = true
        if (replayedAfterReconnect) {
          // Why: client events are not queued while disconnected, so re-read both snapshots after replay.
          void fetchWorktrees({ queueIfInFlight: true })
          void fetchRepoMetadata({ force: true, queueIfInFlight: true })
        }
        return
      }
      if (event.type === 'end' || event.type === 'error') {
        eventStreamReady = false
        return
      }
      if (event.type === 'reposChanged') {
        // Why: folder workspace mutations publish reposChanged, and worktree.ps owns this catalog.
        void fetchWorktrees({ allowDuringModal: true, queueIfInFlight: true })
        void fetchRepoMetadata({ force: true, queueIfInFlight: true })
      } else if (event.type === 'worktreesChanged') {
        void fetchWorktrees({ queueIfInFlight: true })
      }
    }
  )

  void fetchWorktrees()
  void fetchRepoMetadata({ force: true, queueIfInFlight: true })

  return () => {
    stale = true
    clearInterval(interval)
    appStateSubscription.remove()
    unsubscribe()
  }
}
