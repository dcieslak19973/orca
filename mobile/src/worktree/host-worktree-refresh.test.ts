import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { HostWorktreeRequestGate, startHostWorktreeRefresh } from './host-worktree-refresh'

const appState = vi.hoisted(() => ({
  currentState: 'active',
  listener: null as ((state: string) => void) | null,
  remove: vi.fn()
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listener = listener
      return { remove: appState.remove }
    }
  }
}))

describe('startHostWorktreeRefresh', () => {
  let eventListener: ((payload: unknown) => void) | null
  let fetchWorktrees: ReturnType<typeof vi.fn>
  let fetchRepoMetadata: ReturnType<typeof vi.fn>
  let unsubscribe: ReturnType<typeof vi.fn>
  let stop: (() => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    appState.currentState = 'active'
    appState.listener = null
    appState.remove.mockClear()
    eventListener = null
    fetchWorktrees = vi.fn().mockResolvedValue(undefined)
    fetchRepoMetadata = vi.fn().mockResolvedValue(undefined)
    unsubscribe = vi.fn()
    stop = null
  })

  function start(): void {
    const client = {
      subscribe: vi.fn(
        (_method: string, _params: unknown, listener: (payload: unknown) => void) => {
          eventListener = listener
          return unsubscribe
        }
      )
    } as unknown as RpcClient
    stop = startHostWorktreeRefresh({ client, fetchWorktrees, fetchRepoMetadata })
  }

  afterEach(() => {
    stop?.()
    vi.useRealTimers()
  })

  it('keeps the worktree poll active but skips ticks while backgrounded', async () => {
    start()
    expect(fetchWorktrees).toHaveBeenCalledTimes(1)

    appState.currentState = 'background'
    await vi.advanceTimersByTimeAsync(6_000)
    expect(fetchWorktrees).toHaveBeenCalledTimes(1)

    appState.currentState = 'active'
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
  })

  it('refreshes both snapshots immediately on foreground return', () => {
    start()
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()

    appState.currentState = 'active'
    appState.listener?.('active')

    expect(fetchWorktrees).toHaveBeenCalledWith({
      allowDuringModal: true,
      queueIfInFlight: true
    })
    expect(fetchRepoMetadata).toHaveBeenCalledWith({ queueIfInFlight: true })
  })

  it('polls repo metadata on the interval while foregrounded and skips it while backgrounded', async () => {
    start()
    // Mount force-fetch.
    expect(fetchRepoMetadata).toHaveBeenCalledTimes(1)

    // Foregrounded: repo.list rides the interval as a convergence safety-net for desktop
    // Settings edits that never emit a runtime reposChanged (the callee self-throttles).
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fetchWorktrees).toHaveBeenCalledTimes(4)
    expect(fetchRepoMetadata).toHaveBeenCalledTimes(4)

    // Backgrounded: neither snapshot is polled.
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()
    appState.currentState = 'background'
    await vi.advanceTimersByTimeAsync(9_000)
    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(fetchRepoMetadata).not.toHaveBeenCalled()
  })

  it('refreshes worktrees and repo metadata on reposChanged', () => {
    start()
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()

    eventListener?.({ type: 'reposChanged' })

    expect(fetchWorktrees).toHaveBeenCalledOnce()
    expect(fetchWorktrees).toHaveBeenCalledWith({
      allowDuringModal: true,
      queueIfInFlight: true
    })
    expect(fetchRepoMetadata).toHaveBeenCalledOnce()
    expect(fetchRepoMetadata).toHaveBeenCalledWith({ force: true, queueIfInFlight: true })
  })

  it('refreshes worktrees on worktreesChanged and both snapshots after stream replay', () => {
    start()
    fetchWorktrees.mockClear()
    fetchRepoMetadata.mockClear()

    eventListener?.({ type: 'worktreesChanged', repoId: 'repo-1' })
    expect(fetchWorktrees).toHaveBeenCalledTimes(1)
    expect(fetchWorktrees).toHaveBeenLastCalledWith({ queueIfInFlight: true })

    eventListener?.({ type: 'ready', subscriptionId: 'events-1' })
    eventListener?.({ type: 'ready', subscriptionId: 'events-2' })
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchWorktrees).toHaveBeenLastCalledWith({ queueIfInFlight: true })
    expect(fetchRepoMetadata).toHaveBeenCalledWith({ force: true, queueIfInFlight: true })
  })
})

describe('HostWorktreeRequestGate', () => {
  it('coalesces a trailing refresh without sharing state across hosts', () => {
    const gate = new HostWorktreeRequestGate()
    const firstClient = {} as RpcClient
    const secondClient = {} as RpcClient

    expect(gate.begin(firstClient, {})).toBe(true)
    expect(gate.begin(firstClient, {})).toBe(false)
    expect(gate.isSuperseded(firstClient)).toBe(false)

    expect(gate.begin(firstClient, { queueIfInFlight: true })).toBe(false)
    expect(gate.isSuperseded(firstClient)).toBe(true)
    expect(gate.begin(secondClient, {})).toBe(true)

    expect(gate.finish(secondClient)).toBeNull()
    expect(gate.finish(firstClient)).toEqual({ queueIfInFlight: true })
    expect(gate.begin(firstClient, {})).toBe(true)
  })

  it('preserves the strongest queued modal refresh policy', () => {
    const gate = new HostWorktreeRequestGate()
    const client = {} as RpcClient

    expect(gate.begin(client, {})).toBe(true)
    expect(gate.begin(client, { queueIfInFlight: true })).toBe(false)
    expect(gate.begin(client, { allowDuringModal: true, queueIfInFlight: true })).toBe(false)

    expect(gate.isSuperseded(client)).toBe(true)
    expect(gate.finish(client)).toEqual({
      allowDuringModal: true,
      queueIfInFlight: true
    })
  })

  it('keeps an urgent response when only an ordinary refresh is queued behind it', () => {
    const gate = new HostWorktreeRequestGate()
    const client = {} as RpcClient

    expect(gate.begin(client, { allowDuringModal: true })).toBe(true)
    expect(gate.begin(client, { queueIfInFlight: true })).toBe(false)

    expect(gate.isSuperseded(client)).toBe(false)
    expect(gate.finish(client)).toEqual({ queueIfInFlight: true })
  })
})
