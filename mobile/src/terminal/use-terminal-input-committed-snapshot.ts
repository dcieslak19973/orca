import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

type TerminalInputCommittedSnapshotOptions<TTabType extends string> = {
  readonly activeSessionTabType: TTabType | null
  readonly client: RpcClient | null
  readonly connState: ConnectionState
}

type TerminalInputCommittedSnapshot<TTabType extends string> = {
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly clientRef: RefObject<RpcClient | null>
  readonly connStateRef: RefObject<ConnectionState>
}

export function useTerminalInputCommittedSnapshot<TTabType extends string>({
  activeSessionTabType,
  client,
  connState
}: TerminalInputCommittedSnapshotOptions<TTabType>): TerminalInputCommittedSnapshot<TTabType> {
  const activeSessionTabTypeRef = useRef(activeSessionTabType)
  const clientRef = useRef(client)
  const connStateRef = useRef(connState)

  useLayoutEffect(() => {
    activeSessionTabTypeRef.current = activeSessionTabType
    clientRef.current = client
    connStateRef.current = connState
  }, [activeSessionTabType, client, connState])

  return { activeSessionTabTypeRef, clientRef, connStateRef }
}
