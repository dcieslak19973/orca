import { createElement, startTransition, Suspense } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useTerminalInputCommittedSnapshot } from './use-terminal-input-committed-snapshot'

it('keeps the committed transport after a cross-host render is abandoned', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const clientA = { sendRequest: vi.fn(async () => ({ ok: true })) } as unknown as RpcClient
  const clientB = { sendRequest: vi.fn(async () => ({ ok: true })) } as unknown as RpcClient
  const captures = new Map<string, ReturnType<typeof useTerminalInputCommittedSnapshot<string>>>()
  const neverResolves = new Promise<void>(() => undefined)

  function Harness({
    host,
    client,
    suspend
  }: {
    host: string
    client: RpcClient
    suspend?: boolean
  }) {
    const snapshot = useTerminalInputCommittedSnapshot({
      activeSessionTabType: 'terminal',
      client,
      connState: 'connected'
    })
    captures.set(host, snapshot)
    if (suspend) {
      throw neverResolves
    }
    return null
  }

  const render = (host: string, client: RpcClient, suspend = false) =>
    createElement(Suspense, { fallback: null }, createElement(Harness, { host, client, suspend }))
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(render('host-a', clientA), { unstable_isConcurrent: true } as never)
  })
  const committedSnapshot = captures.get('host-a')

  await act(async () => {
    startTransition(() => renderer?.update(render('host-b', clientB, true)))
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(captures.has('host-b')).toBe(true))

  await committedSnapshot?.clientRef.current?.sendRequest('terminal.send')
  expect(clientA.sendRequest).toHaveBeenCalledOnce()
  expect(clientB.sendRequest).not.toHaveBeenCalled()
  expect(committedSnapshot?.connStateRef.current).toBe('connected')
  expect(committedSnapshot?.activeSessionTabTypeRef.current).toBe('terminal')
  act(() => renderer?.unmount())
})
