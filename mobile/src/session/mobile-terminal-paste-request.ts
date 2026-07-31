import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../terminal/terminal-send-request'
import type { RpcClient } from '../transport/rpc-client'

type MobileTerminalPasteRequest = {
  readonly terminal: string
  readonly text: string
  readonly deviceToken: string | null
}

export function sendMobileTerminalPasteRequest(
  client: Pick<RpcClient, 'sendRequest'>,
  request: MobileTerminalPasteRequest
) {
  return client.sendRequest(
    'terminal.send',
    buildTerminalSendParams({ ...request, enter: false }),
    TERMINAL_INPUT_SEND_OPTIONS
  )
}
