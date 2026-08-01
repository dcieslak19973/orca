import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  mergeRejectedTerminalBufferedInput,
  sendMobileTerminalBufferedInput
} from './mobile-terminal-buffered-input-send'
import { TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'

function clientWithResult(result: unknown, rejects = false): Pick<RpcClient, 'sendRequest'> {
  return {
    sendRequest: rejects ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result)
  } as unknown as Pick<RpcClient, 'sendRequest'>
}

const SEND_ARGS = {
  deviceToken: 'device-a',
  targetHandle: 'terminal-a',
  text: 'かき'
} as const

describe('mobile terminal buffered input send', () => {
  it('reports acceptance and sends the command with Enter now-or-never', async () => {
    const client = clientWithResult({
      ok: true,
      result: { send: { accepted: true } }
    })

    await expect(sendMobileTerminalBufferedInput({ ...SEND_ARGS, client })).resolves.toBe(
      'accepted'
    )
    expect(client.sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      {
        terminal: 'terminal-a',
        text: 'かき',
        enter: true,
        client: { id: 'device-a', type: 'mobile' }
      },
      TERMINAL_INPUT_SEND_OPTIONS
    )
  })

  it.each([
    ['host rejection', { ok: true, result: { send: { accepted: false } } }],
    ['RPC failure', { ok: false, error: { message: 'missing terminal' } }]
  ])('reports a definite rejection for %s', async (_label, response) => {
    const client = clientWithResult(response)

    await expect(sendMobileTerminalBufferedInput({ ...SEND_ARGS, client })).resolves.toBe(
      'rejected'
    )
  })

  it('reports an ordinary pre-delivery failure as rejected', async () => {
    const client = clientWithResult(new Error('not connected'), true)

    await expect(sendMobileTerminalBufferedInput({ ...SEND_ARGS, client })).resolves.toBe(
      'rejected'
    )
  })

  it.each([
    ['delivery-unknown failure', markRpcDeliveryUnknown(new Error('response lost'))],
    ['logical cutover', new LogicalClientCutoverError()]
  ])('reports %s without offering a duplicate retry', async (_label, error) => {
    const client = clientWithResult(error, true)

    await expect(sendMobileTerminalBufferedInput({ ...SEND_ARGS, client })).resolves.toBe('unknown')
  })
})

describe('rejected buffered input merge', () => {
  it('restores the rejected command without losing text typed during the request', () => {
    expect(mergeRejectedTerminalBufferedInput('first command', 'new draft')).toBe(
      'first command\nnew draft'
    )
  })

  it('avoids adding separators when either side is empty', () => {
    expect(mergeRejectedTerminalBufferedInput('first command', '')).toBe('first command')
    expect(mergeRejectedTerminalBufferedInput('', 'new draft')).toBe('new draft')
  })
})
