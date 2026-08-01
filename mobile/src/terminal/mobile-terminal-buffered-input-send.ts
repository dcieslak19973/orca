import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { isTerminalSendRpcAccepted } from './terminal-send-rpc-response'
import { buildTerminalSendParams, TERMINAL_INPUT_SEND_OPTIONS } from './terminal-send-request'

export type MobileTerminalBufferedInputSendOutcome = 'accepted' | 'rejected' | 'unknown'

export async function sendMobileTerminalBufferedInput(args: {
  readonly client: Pick<RpcClient, 'sendRequest'>
  readonly deviceToken: string | null
  readonly targetHandle: string
  readonly text: string
}): Promise<MobileTerminalBufferedInputSendOutcome> {
  try {
    const response = await args.client.sendRequest(
      'terminal.send',
      buildTerminalSendParams({
        terminal: args.targetHandle,
        text: args.text,
        enter: true,
        deviceToken: args.deviceToken
      }),
      TERMINAL_INPUT_SEND_OPTIONS
    )
    return isTerminalSendRpcAccepted(response) ? 'accepted' : 'rejected'
  } catch (error) {
    return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
      ? 'unknown'
      : 'rejected'
  }
}

export function mergeRejectedTerminalBufferedInput(sentText: string, currentText: string): string {
  if (currentText.length === 0) {
    return sentText
  }
  if (sentText.length === 0) {
    return currentText
  }
  return `${sentText}\n${currentText}`
}
