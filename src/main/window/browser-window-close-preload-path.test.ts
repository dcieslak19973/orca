import { describe, expect, it } from 'vitest'
import { BROWSER_WINDOW_CLOSE_ALLOWED_PRELOAD } from '../../shared/browser-window-close-policy'
import {
  fileUrlToPathOrNull,
  resolveBrowserWindowCloseAllowedPreloadPath
} from './browser-window-close-preload-path'

describe('fileUrlToPathOrNull', () => {
  it('converts a real file URL', () => {
    const converted = fileUrlToPathOrNull(
      process.platform === 'win32' ? 'file:///C:/tmp/x.js' : 'file:///tmp/x.js'
    )
    expect(converted).toBeTruthy()
    expect(converted).toContain('x.js')
  })

  // Why: this is the guard the window-close marker depends on. A non-file scheme is rejected on
  // every platform, so it exercises the catch without depending on the host being Windows.
  it('returns null instead of throwing for a URL that cannot be a path', () => {
    expect(() => fileUrlToPathOrNull('https://example.com/x.js')).not.toThrow()
    expect(fileUrlToPathOrNull('https://example.com/x.js')).toBeNull()
  })
})

describe('resolveBrowserWindowCloseAllowedPreloadPath', () => {
  // Why: regression guard for the blank-window bug. Converting the sentinel throws on win32
  // (a win32 file URL needs a drive letter), and an unguarded call in createMainWindow aborted
  // window creation, so the app rendered blank on Windows.
  it('never throws, whatever the platform makes of the sentinel', () => {
    expect(() => resolveBrowserWindowCloseAllowedPreloadPath()).not.toThrow()
  })

  it('returns either a path or null, and never the raw marker', () => {
    const resolved = resolveBrowserWindowCloseAllowedPreloadPath()
    expect(resolved === null || typeof resolved === 'string').toBe(true)
    expect(resolved).not.toBe(BROWSER_WINDOW_CLOSE_ALLOWED_PRELOAD)
  })
})
