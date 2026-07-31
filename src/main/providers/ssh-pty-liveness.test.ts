import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SshPtyProvider liveness', () => {
  const request = vi.fn()
  let provider: SshPtyProvider
  let emitNotification: (method: string, params: Record<string, unknown>) => void

  beforeEach(() => {
    request.mockReset()
    emitNotification = () => {}
    provider = new SshPtyProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn((callback) => {
        emitNotification = callback
        return vi.fn()
      }),
      dispose: vi.fn(),
      isDisposed: vi.fn(() => false)
    } as never)
  })

  afterEach(() => {
    provider.dispose()
    vi.useRealTimers()
  })

  it('probes exact relay PTY liveness and refreshes the local cache', async () => {
    request.mockResolvedValueOnce({ cols: 80, rows: 24 }).mockResolvedValueOnce(null)
    const id = 'ssh:conn-1@@pty-1'

    await expect(provider.probePtyLiveness(id)).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith('pty.getSize', { id: 'pty-1' }, { timeoutMs: 15_000 })
    expect(provider.hasPty(id)).toBe(true)

    await expect(provider.probePtyLiveness(id)).resolves.toBe(false)
    expect(provider.hasPty(id)).toBe(false)

    request.mockRejectedValueOnce(new Error('relay unavailable'))
    await expect(provider.probePtyLiveness(id)).resolves.toBeNull()
  })

  it('announces exact authority when an unknown probe later resolves live', async () => {
    vi.useFakeTimers()
    let resolveProbe!: (size: { cols: number; rows: number }) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProbe = resolve
      })
    )
    const authorityChanged = vi.fn()
    provider.onPtyLivenessAuthorityChanged(authorityChanged)
    const id = 'ssh:conn-1@@pty-1'

    const pendingProbe = provider.probePtyLiveness(id)
    const coalescedProbe = provider.probePtyLiveness(id)
    expect(request).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(pendingProbe).resolves.toBeNull()
    await expect(coalescedProbe).resolves.toBeNull()
    expect(authorityChanged).not.toHaveBeenCalled()
    expect(provider.hasPty(id)).toBe(false)

    resolveProbe({ cols: 80, rows: 24 })
    await vi.advanceTimersByTimeAsync(0)

    expect(provider.hasPty(id)).toBe(true)
    expect(authorityChanged).toHaveBeenCalledOnce()
    expect(authorityChanged).toHaveBeenCalledWith({ id })

    let resolveAfterDispose!: (size: { cols: number; rows: number }) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAfterDispose = resolve
      })
    )
    const disposedProbe = provider.probePtyLiveness(id)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(disposedProbe).resolves.toBeNull()
    provider.dispose()

    resolveAfterDispose({ cols: 80, rows: 24 })
    await vi.advanceTimersByTimeAsync(0)

    expect(authorityChanged).toHaveBeenCalledOnce()
    expect(provider.hasPty(id)).toBe(false)
  })

  it('ignores late probe results after exact retirement or id reuse', async () => {
    vi.useFakeTimers()
    const id = 'ssh:conn-1@@pty-1'
    const authorityChanged = vi.fn()
    provider.onPtyLivenessAuthorityChanged(authorityChanged)
    let resolveRetired!: (size: { cols: number; rows: number }) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRetired = resolve
      })
    )

    const retiredProbe = provider.probePtyLiveness(id)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(retiredProbe).resolves.toBeNull()
    emitNotification('pty.exit', { id: 'pty-1', code: 0, incarnationId: 'incarnation-old' })
    resolveRetired({ cols: 80, rows: 24 })
    await vi.advanceTimersByTimeAsync(0)

    expect(provider.hasPty(id)).toBe(false)
    expect(authorityChanged).not.toHaveBeenCalled()

    emitNotification('pty.data', {
      id: 'pty-1',
      data: 'old',
      incarnationId: 'incarnation-old'
    })
    let resolveReused!: (size: null) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReused = resolve
      })
    )
    const reusedProbe = provider.probePtyLiveness(id)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(reusedProbe).resolves.toBeNull()
    emitNotification('pty.exit', { id: 'pty-1', code: 0, incarnationId: 'incarnation-old' })
    emitNotification('pty.data', {
      id: 'pty-1',
      data: 'new',
      incarnationId: 'incarnation-new'
    })
    resolveReused(null)
    await vi.advanceTimersByTimeAsync(0)

    expect(provider.hasPty(id)).toBe(true)
    expect(authorityChanged).not.toHaveBeenCalled()
  })
})
