/**
 * Freeze repro R1 — Tim (Expand) / Brandon (Uber) class
 *
 * Trigger (trusted Slack):
 *   "just opening my remote sessions again" on Remote Server / SSH with agents.
 *
 * Topology under test:
 *   R1: headless Remote Orca host + paired desktop web client (paired-remote-server)
 *
 * Measurement:
 *   renderer timer drift during hidden flood + bulk worktree/tab open.
 *   soft freeze >= 2s, hard freeze >= 5s.
 *
 * Run:
 *   SKIP_BUILD=1 pnpm exec playwright test \
 *     tests/e2e/remote-session-bulk-open-freeze-repro.spec.ts \
 *     --config tests/playwright.config.ts \
 *     --project electron-headless --workers=1
 *
 * Or:
 *   pnpm run test:e2e:remote-bulk-open-freeze
 */
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  launchPairedWebClient,
  type PairedElectronClient,
  type PairedWebClient
} from './helpers/paired-electron-client'
import {
  HARD_FREEZE_LAG_MS,
  runBulkOpenFreezeOracle,
  seedBulkOpenRemoteSessions,
  SOFT_FREEZE_LAG_MS
} from './helpers/remote-session-bulk-open-oracle'

const REPORT_DIR = path.join(process.cwd(), 'test-results', 'freeze-repro')
const USE_DESKTOP_PAIR = process.env.ORCA_E2E_FREEZE_DESKTOP_PAIR === '1'

test('R1 paired remote bulk-open freeze oracle @freeze-repro', async ({
  testRepoPath,
  testInfo
}) => {
  test.setTimeout(420_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let webClient: PairedWebClient | null = null
  let desktopClient: PairedElectronClient | null = null
  let disposeSessions: (() => void) | null = null
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    await expect
      .poll(
        async () => {
          const listed = await host.client.call<{ totalCount: number }>('worktree.list', {
            repo: `id:${added.result.repo.id}`
          })
          return listed.result.totalCount
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)

    // Prefer full desktop pair when web-client store hydration is flaky in this env.
    const page = await (async () => {
      if (USE_DESKTOP_PAIR) {
        desktopClient = await launchPairedElectronClient(host.offer, testInfo, 'freeze-r1')
        return desktopClient.page
      }
      webClient = await launchPairedWebClient(host.app, host.offer, {
        terminalParkingDelayMs: 500
      })
      return webClient.page
    })()

    await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 60_000 })
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees().length ?? 0), {
        timeout: 90_000
      })
      .toBeGreaterThan(0)

    const seeded = await seedBulkOpenRemoteSessions(page, {
      repoId: added.result.repo.id
    })
    disposeSessions = seeded.dispose

    const report = await runBulkOpenFreezeOracle(page, seeded.sessions, {
      topology: 'paired-remote-server',
      versionHint: process.env.npm_package_version ?? '1.4.163-rc.3',
      reportDir: REPORT_DIR
    })

    // eslint-disable-next-line no-console
    console.log('[freeze-repro R1]', JSON.stringify(report, null, 2))

    if (report.hardFreeze) {
      throw new Error(
        `HARD FREEZE signal: bulkOpenMaxLagMs=${report.bulkOpenMaxLagMs.toFixed(0)} ` +
          `interactionProbeMs=${report.interactionProbeMs.toFixed(0)} ` +
          `(threshold ${HARD_FREEZE_LAG_MS}ms). notes=${report.notes.join('; ')}`
      )
    }
    if (report.softFreeze) {
      throw new Error(
        `SOFT FREEZE signal: bulkOpenMaxLagMs=${report.bulkOpenMaxLagMs.toFixed(0)} ` +
          `interactionProbeMs=${report.interactionProbeMs.toFixed(0)} ` +
          `(threshold ${SOFT_FREEZE_LAG_MS}ms). notes=${report.notes.join('; ')}`
      )
    }

    expect(report.sessionCount).toBeGreaterThanOrEqual(8)
    expect(report.worktreeCount).toBe(3)
  } finally {
    disposeSessions?.()
    await webClient?.dispose()
    await desktopClient?.dispose()
    await host.dispose()
  }
})
