import { expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { getSleepingAgentRecordsForProviderClaim } from './sleeping-agent-pane-ownership'

function makeRecord(index: number): SleepingAgentSessionRecord {
  return {
    paneKey: `tab-${index}:leaf-${index}`,
    tabId: `tab-${index}`,
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${index}` },
    prompt: 'continue',
    state: 'working',
    capturedAt: index,
    updatedAt: index,
    origin: 'live'
  }
}

it('indexes one hundred provider claims once per sleeping-record generation', () => {
  const records = Array.from({ length: 100 }, (_, index) => makeRecord(index))
  const source = Object.fromEntries(records.map((record) => [record.paneKey, record]))
  let enumeratedRecordCount = 0
  const observed = new Proxy(source, {
    ownKeys(target) {
      const keys = Reflect.ownKeys(target)
      enumeratedRecordCount += keys.length
      return keys
    }
  })
  const state = { sleepingAgentSessionsByPaneKey: observed } as never

  for (const record of records) {
    expect(getSleepingAgentRecordsForProviderClaim(state, record)).toEqual([record])
  }

  expect(enumeratedRecordCount).toBe(100)
})
