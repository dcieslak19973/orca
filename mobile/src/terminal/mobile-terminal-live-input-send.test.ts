import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { sendMobileTerminalLiveInput } from './mobile-terminal-live-input-send'

function captureClient() {
  const sendRequest = vi.fn(async () => ({
    id: '1',
    ok: true,
    result: { send: { accepted: true, bytesWritten: 1 } }
  }))
  return { client: { sendRequest } as unknown as Pick<RpcClient, 'sendRequest'>, sendRequest }
}

const CURRENT_SEND = {
  connState: 'connected',
  targetHandle: 'terminal-a',
  activeHandle: 'terminal-a',
  activeSessionTabType: 'terminal',
  text: 'こ',
  deviceToken: 'device-1'
} as const

describe('mobile terminal live input send', () => {
  it('sends while a current terminal tab type is temporarily unknown', async () => {
    const { client, sendRequest } = captureClient()

    await expect(
      sendMobileTerminalLiveInput({ ...CURRENT_SEND, client, activeSessionTabType: null })
    ).resolves.toBe(true)
    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'terminal-a',
        text: 'こ',
        enter: false,
        client: { id: 'device-1', type: 'mobile' }
      },
      { failWhenDisconnected: true }
    )
  })

  it.each([
    { connState: 'reconnecting', activeHandle: 'terminal-a', activeSessionTabType: 'terminal' },
    { connState: 'connected', activeHandle: 'terminal-b', activeSessionTabType: 'terminal' },
    { connState: 'connected', activeHandle: 'terminal-a', activeSessionTabType: 'browser' }
  ] as const)('rejects a stale target without sending: %o', async (state) => {
    const { client, sendRequest } = captureClient()

    await expect(sendMobileTerminalLiveInput({ ...CURRENT_SEND, ...state, client })).resolves.toBe(
      false
    )
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
