import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/types'
import {
  _internals,
  forgetCodexPaneAccount,
  getCodexPaneAccount,
  recordCodexPaneAccount
} from './codex-pane-account-registry'
import { forgetStaleCodexPanes, listStaleCodexPanes } from './codex-stale-pane-accounts'
import { __resetShellStartupEnvCache } from '../pty/shell-startup-env'

let userDataPath: string
let previousUserDataPath: string | undefined

function settingsWithSelection(
  host: string | null,
  wsl: Record<string, string | null> = {}
): GlobalSettings {
  return {
    activeCodexManagedAccountId: host,
    activeCodexManagedAccountIdsByRuntime: { host, wsl }
  } as GlobalSettings
}

beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-codex-pane-accounts-'))
  process.env.ORCA_USER_DATA_PATH = userDataPath
  _internals.resetCache()
})

afterEach(() => {
  __resetShellStartupEnvCache()
  rmSync(userDataPath, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  _internals.resetCache()
})

describe('codex pane account registry', () => {
  it('survives a process restart so a daemon-backed shell stays attributable', () => {
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home',
      shellStartupHomeOverride: {
        home: '/pane-home',
        shell: '/bin/zsh',
        codexHome: '/pane-home/custom-codex-home'
      }
    })

    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toEqual({
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home',
      shellStartupHomeOverride: {
        home: '/pane-home',
        shell: '/bin/zsh',
        codexHome: '/pane-home/custom-codex-home'
      }
    })
  })

  it('keeps pre-route records readable without inventing provenance', () => {
    writeFileSync(
      join(userDataPath, 'codex-pane-accounts.json'),
      JSON.stringify({
        version: 1,
        panes: { 'pty-1': { selectionKey: 'host', accountId: null } }
      })
    )
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toEqual({ selectionKey: 'host', accountId: null })
  })

  it('forgets a PTY so a reused id cannot inherit a dead pane account', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })

    forgetCodexPaneAccount('pty-1')
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toBeNull()
  })

  it('keeps every record below the tracking cap', () => {
    for (let index = 0; index < 20; index += 1) {
      recordCodexPaneAccount(`pty-${index}`, { selectionKey: 'host', accountId: 'account-a' })
    }
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-0')).not.toBeNull()
    expect(getCodexPaneAccount('pty-19')).not.toBeNull()
  })

  it('reads back nothing when the registry file is missing', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })
    rmSync(join(userDataPath, 'codex-pane-accounts.json'))
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toBeNull()
  })

  it.each([
    ['unparseable JSON', '{ not json'],
    ['a non-object document', '"panes"'],
    ['an array document', '[]'],
    ['a missing panes map', '{"version":1}'],
    ['a non-object panes map', '{"version":1,"panes":[]}']
  ])('reads back nothing and still records when the file holds %s', (_label, contents) => {
    writeFileSync(join(userDataPath, 'codex-pane-accounts.json'), contents)
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toBeNull()
    // Why: a corrupt file must not wedge the registry — the next spawn has to
    // still be attributable, or fix-3 prompts silently die on one bad write.
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })
    _internals.resetCache()
    expect(getCodexPaneAccount('pty-1')).toEqual({ selectionKey: 'host', accountId: 'account-a' })
  })

  it('drops a malformed record without discarding its valid siblings', () => {
    writeFileSync(
      join(userDataPath, 'codex-pane-accounts.json'),
      JSON.stringify({
        version: 1,
        panes: {
          'pty-bad': { selectionKey: 7, accountId: 'account-a' },
          'pty-good': { selectionKey: 'host', accountId: 'account-a' }
        }
      })
    )
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-bad')).toBeNull()
    expect(getCodexPaneAccount('pty-good')).toEqual({
      selectionKey: 'host',
      accountId: 'account-a'
    })
  })
})

describe('listStaleCodexPanes', () => {
  it('reports a pane launched under a now-deselected account', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })

    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1'],
        settings: settingsWithSelection('account-b')
      })
    ).toEqual([
      {
        ptyId: 'pty-1',
        launchAccountId: 'account-a',
        activeAccountId: 'account-b',
        reason: 'account-change'
      }
    ])
  })

  it('reports a managed pane after the selection drops to the system default', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })

    expect(
      listStaleCodexPanes({ ptyIds: ['pty-1'], settings: settingsWithSelection(null) })
    ).toEqual([
      {
        ptyId: 'pty-1',
        launchAccountId: 'account-a',
        activeAccountId: null,
        reason: 'account-change'
      }
    ])
  })

  it('leaves a pane alone when its launch account is still selected', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })

    expect(
      listStaleCodexPanes({ ptyIds: ['pty-1'], settings: settingsWithSelection('account-a') })
    ).toEqual([])
  })

  it('reports a system-default pane after its home route changes', () => {
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home'
    })

    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1'],
        settings: settingsWithSelection(null),
        activeHostHomeRoute: 'real-home'
      })
    ).toEqual([
      {
        ptyId: 'pty-1',
        launchAccountId: null,
        activeAccountId: null,
        reason: 'home-route-change'
      }
    ])
  })

  it('does not guess a route for panes recorded before route provenance', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: null })

    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1'],
        settings: settingsWithSelection(null),
        activeHostHomeRoute: 'real-home'
      })
    ).toEqual([])
  })

  it('reports a retained pane after its process CODEX_HOME changes', () => {
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home',
      environmentHomeOverride: { codexHome: '/custom/codex-a' }
    })

    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1'],
        settings: settingsWithSelection(null),
        activeHostHomeRoute: 'shared-home',
        activeHostCustomHomeOverride: {
          source: 'environment',
          context: { codexHome: '/custom/codex-b' }
        }
      })
    ).toEqual([
      {
        ptyId: 'pty-1',
        launchAccountId: null,
        activeAccountId: null,
        reason: 'home-route-change'
      }
    ])
  })

  it('leaves a retained pane alone while its process CODEX_HOME is unchanged', () => {
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home',
      environmentHomeOverride: { codexHome: '/custom/codex-home' }
    })

    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1'],
        settings: settingsWithSelection(null),
        activeHostHomeRoute: 'shared-home',
        activeHostCustomHomeOverride: {
          source: 'environment',
          context: { codexHome: '/custom/codex-home' }
        }
      })
    ).toEqual([])
  })

  it.each([
    [
      'environment to shell startup',
      { environmentHomeOverride: { codexHome: '/custom/codex-home' } },
      {
        source: 'shell-startup' as const,
        context: {
          home: '/custom',
          shell: '/bin/zsh',
          codexHome: '/custom/codex-home'
        }
      }
    ],
    [
      'shell startup to environment',
      {
        shellStartupHomeOverride: {
          home: '/custom',
          shell: '/bin/zsh',
          codexHome: '/custom/codex-home'
        }
      },
      {
        source: 'environment' as const,
        context: { codexHome: '/custom/codex-home' }
      }
    ]
  ])('does not report a same-path %s change', (_label, provenance, activeOverride) => {
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home',
      ...provenance
    })

    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1'],
        settings: settingsWithSelection(null),
        activeHostHomeRoute: 'shared-home',
        activeHostCustomHomeOverride: activeOverride
      })
    ).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'reports a retained pane after its shell startup CODEX_HOME is removed',
    () => {
      const paneHome = join(userDataPath, 'pane-home')
      mkdirSync(paneHome, { recursive: true })
      const startupPath = join(paneHome, '.zshrc')
      const customHome = join(paneHome, 'custom-codex-home')
      writeFileSync(startupPath, 'export CODEX_HOME="$HOME/custom-codex-home"\n')
      recordCodexPaneAccount('pty-1', {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'shared-home',
        shellStartupHomeOverride: {
          home: paneHome,
          shell: '/bin/zsh',
          codexHome: customHome
        }
      })

      expect(
        listStaleCodexPanes({
          ptyIds: ['pty-1'],
          settings: settingsWithSelection(null),
          activeHostHomeRoute: 'real-home'
        })
      ).toEqual([])

      writeFileSync(startupPath, '')
      __resetShellStartupEnvCache()
      expect(
        listStaleCodexPanes({
          ptyIds: ['pty-1'],
          settings: settingsWithSelection(null),
          activeHostHomeRoute: 'real-home'
        })
      ).toEqual([
        {
          ptyId: 'pty-1',
          launchAccountId: null,
          activeAccountId: null,
          reason: 'home-route-change'
        }
      ])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a retained pane when the replacement launch context changes',
    () => {
      const paneHome = join(userDataPath, 'pane-home')
      mkdirSync(paneHome, { recursive: true })
      const customHome = join(paneHome, 'custom-codex-home')
      writeFileSync(join(paneHome, '.zshrc'), 'export CODEX_HOME="$HOME/custom-codex-home"\n')
      recordCodexPaneAccount('pty-1', {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'shared-home',
        shellStartupHomeOverride: {
          home: paneHome,
          shell: '/bin/zsh',
          codexHome: customHome
        }
      })

      expect(
        listStaleCodexPanes({
          ptyIds: ['pty-1'],
          settings: settingsWithSelection(null),
          activeHostHomeRoute: 'real-home',
          activeHostCustomHomeOverride: null
        })
      ).toEqual([
        {
          ptyId: 'pty-1',
          launchAccountId: null,
          activeAccountId: null,
          reason: 'home-route-change'
        }
      ])
    }
  )

  it('never reports an unrecorded PTY, so an upgrade cannot invent a prompt', () => {
    expect(
      listStaleCodexPanes({ ptyIds: ['pty-unknown'], settings: settingsWithSelection('account-b') })
    ).toEqual([])
  })

  it('stops reporting a pane the user chose to keep on the old account', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })
    recordCodexPaneAccount('pty-2', { selectionKey: 'host', accountId: 'account-a' })

    forgetStaleCodexPanes(['pty-1'])
    _internals.resetCache()

    // Why: the dismissal must outlive the app, or the startup sweep re-raises it.
    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1', 'pty-2'],
        settings: settingsWithSelection('account-b')
      })
    ).toEqual([
      {
        ptyId: 'pty-2',
        launchAccountId: 'account-a',
        activeAccountId: 'account-b',
        reason: 'account-change'
      }
    ])
  })

  it('compares a WSL pane against its own distro selection', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'wsl:Ubuntu', accountId: 'account-a' })
    recordCodexPaneAccount('pty-2', { selectionKey: 'wsl:Debian', accountId: 'account-c' })

    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1', 'pty-2'],
        // Why: switching the host account must not restart WSL panes, and one
        // distro's switch must not restart another distro's panes.
        settings: settingsWithSelection('account-b', { Ubuntu: 'account-a', Debian: 'account-d' })
      })
    ).toEqual([
      {
        ptyId: 'pty-2',
        launchAccountId: 'account-c',
        activeAccountId: 'account-d',
        reason: 'account-change'
      }
    ])
  })
})
