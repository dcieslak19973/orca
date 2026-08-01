import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useTerminalBufferedInputSend } from './use-terminal-buffered-input-send'

function createDeferredRejection(): {
  readonly promise: Promise<never>
  readonly reject: (reason: Error) => void
} {
  let rejectPromise: (reason: Error) => void = () => undefined
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject
  })
  return { promise, reject: rejectPromise }
}

it('does not restore or unlock buffered input across a route switch', async () => {
  let inputScope = 'host-a\0worktree-a'
  let runSend: ReturnType<typeof useTerminalBufferedInputSend> | null = null
  let renderer: ReactTestRenderer | null = null

  function Harness(): null {
    runSend = useTerminalBufferedInputSend(inputScope)
    return null
  }

  act(() => {
    renderer = create(createElement(Harness))
  })
  if (!runSend || !renderer) {
    throw new Error('terminal buffered-input hook did not render')
  }

  const routeADeferred = createDeferredRejection()
  const restoreA = vi.fn()
  const routeASend = runSend(() => routeADeferred.promise, restoreA)

  inputScope = 'host-b\0worktree-b'
  act(() => renderer?.update(createElement(Harness)))
  const routeBDeferred = createDeferredRejection()
  const restoreB = vi.fn()
  const routeBSend = runSend(() => routeBDeferred.promise, restoreB)

  routeADeferred.reject(new Error('route A disconnected'))
  await expect(routeASend).resolves.toBe(true)
  expect(restoreA).not.toHaveBeenCalled()
  await expect(runSend(async () => undefined, vi.fn())).resolves.toBe(false)

  routeBDeferred.reject(new Error('route B disconnected'))
  await expect(routeBSend).resolves.toBe(true)
  expect(restoreB).toHaveBeenCalledOnce()
  await expect(runSend(async () => undefined, vi.fn())).resolves.toBe(true)
  act(() => renderer?.unmount())
})
