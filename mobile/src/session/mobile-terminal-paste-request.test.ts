import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { sendMobileTerminalPasteRequest } from './mobile-terminal-paste-request'

it('sends paste bytes now-or-never with the mobile presence tag', async () => {
  const sendRequest = vi.fn(async () => ({ id: '1', ok: true, result: null }))
  const client = { sendRequest } as unknown as Pick<RpcClient, 'sendRequest'>

  await sendMobileTerminalPasteRequest(client, {
    terminal: 'terminal-a',
    text: 'echo ready\n',
    deviceToken: 'device-1'
  })

  expect(sendRequest).toHaveBeenCalledWith(
    'terminal.send',
    {
      terminal: 'terminal-a',
      text: 'echo ready\n',
      enter: false,
      client: { id: 'device-1', type: 'mobile' }
    },
    { failWhenDisconnected: true }
  )
})
