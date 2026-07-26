import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcess from 'node:child_process'
import type { RelayDispatcher } from './dispatcher'
import { GlabExecHandler } from './glab-exec-handler'
import { GLAB_EXEC_METHOD } from '../shared/ssh-types'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn()
  }
})

const spawnMock = vi.mocked(spawn)

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn> }
  pid: number
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  child.pid = 4242
  child.kill = vi.fn()
  return child
}

function createHandler(): {
  get: (
    method: string
  ) => ((params: Record<string, unknown>, context?: unknown) => Promise<unknown>) | undefined
} {
  const handlers = new Map<
    string,
    (params: Record<string, unknown>, context?: unknown) => Promise<unknown>
  >()
  const dispatcher = {
    onRequest: (
      method: string,
      handler: (params: Record<string, unknown>, context?: unknown) => Promise<unknown>
    ) => {
      handlers.set(method, handler)
    }
  } as unknown as RelayDispatcher
  new GlabExecHandler(dispatcher)
  return { get: (method) => handlers.get(method) }
}

describe('GlabExecHandler', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('spawns exactly glab with argv array (no shell)', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandler()

    const pending = handlers.get(GLAB_EXEC_METHOD)!({
      args: ['auth', 'status', '--hostname', 'gitlab.com'],
      cwd: '/home/user/repo',
      timeoutMs: 5_000
    })

    child.stdout.emit('data', Buffer.from('{"ok":true}'))
    child.emit('close', 0)

    await expect(pending).resolves.toEqual({
      stdout: '{"ok":true}',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'glab',
      ['auth', 'status', '--hostname', 'gitlab.com'],
      expect.objectContaining({
        cwd: '/home/user/repo',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    )
  })

  it('never accepts a caller-supplied binary', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as never)
    const handlers = createHandler()

    const pending = handlers.get(GLAB_EXEC_METHOD)!({
      binary: '/tmp/evil',
      args: ['version']
    })
    child.emit('close', 0)
    await pending

    expect(spawnMock).toHaveBeenCalledWith('glab', ['version'], expect.any(Object))
  })

  it('reports spawn errors without throwing', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn glab ENOENT')
    })
    const handlers = createHandler()

    await expect(handlers.get(GLAB_EXEC_METHOD)!({ args: ['version'] })).resolves.toMatchObject({
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      spawnError: expect.stringContaining('ENOENT')
    })
  })
})
