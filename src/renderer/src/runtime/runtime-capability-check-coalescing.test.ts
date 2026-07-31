import { beforeEach, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCacheForTests,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'

const runtimeEnvironmentCall = vi.fn()

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    }
  })
})

it('coalesces concurrent missing-capability verdicts onto one status.get', async () => {
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'legacy-runtime',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: []
    },
    _meta: { runtimeId: 'legacy-runtime' }
  })

  const verdicts = await Promise.all(
    Array.from({ length: 100 }, () =>
      runtimeEnvironmentSupportsCapability(
        'env-cap-concurrent-missing',
        'terminal.resolve-pane-handle-authority.v1'
      )
    )
  )

  expect(verdicts).toEqual(Array.from({ length: 100 }, () => false))
  expect(runtimeEnvironmentCall).toHaveBeenCalledOnce()
})

it('does not reuse a pending capability verdict after the runtime changes', async () => {
  const oldStatus = deferred<unknown>()
  runtimeEnvironmentCall
    .mockImplementationOnce(() => oldStatus.promise)
    .mockResolvedValueOnce({
      id: 'status-new',
      ok: true,
      result: {
        runtimeId: 'runtime-new',
        graphStatus: 'ready',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
        capabilities: ['terminal.resolve-pane-handle-authority.v1']
      },
      _meta: { runtimeId: 'runtime-new' }
    })

  const oldVerdict = runtimeEnvironmentSupportsCapability(
    'env-replaced',
    'terminal.resolve-pane-handle-authority.v1'
  )
  await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledOnce())
  clearRecentRuntimeCompatibilityFailure('env-replaced', {
    runtimeId: 'runtime-new',
    graphStatus: 'ready',
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
  } as RuntimeStatus)
  const newVerdict = runtimeEnvironmentSupportsCapability(
    'env-replaced',
    'terminal.resolve-pane-handle-authority.v1'
  )

  await expect(newVerdict).resolves.toBe(true)
  oldStatus.resolve({
    id: 'status-old',
    ok: true,
    result: {
      runtimeId: 'runtime-old',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: []
    },
    _meta: { runtimeId: 'runtime-old' }
  })
  await expect(oldVerdict).resolves.toBe(false)
  expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
})
