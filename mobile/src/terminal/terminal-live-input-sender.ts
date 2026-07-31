export type TerminalLiveInputSender = (handle: string, bytes: string) => Promise<boolean>

export type TerminalLiveInputBoundarySender = (
  handle: string,
  sendBoundary: () => Promise<boolean>
) => Promise<boolean>
