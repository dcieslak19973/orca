import { fileURLToPath } from 'node:url'
import { BROWSER_WINDOW_CLOSE_ALLOWED_PRELOAD } from '../../shared/browser-window-close-policy'

/**
 * `fileURLToPath` for URLs that may not name a real file. Returns null instead of
 * throwing so a caller can treat "no path form on this platform" as a normal case.
 */
export function fileUrlToPathOrNull(fileUrl: string): string | null {
  try {
    return fileURLToPath(fileUrl)
  } catch {
    return null
  }
}

/**
 * Path form of the window-close allow marker, or null where the platform has none.
 *
 * The marker is a sentinel (`file:///__orca_window_close_allowed__`), not a real file.
 * Electron may hand it back already normalized to a path, so the attach guard compares
 * against both forms — but win32 file URLs require a drive letter, so converting the
 * sentinel throws there. Lives in main only: the shared policy module that owns the
 * marker is also bundled into the renderer, which must not pull in `node:url`.
 */
export function resolveBrowserWindowCloseAllowedPreloadPath(): string | null {
  return fileUrlToPathOrNull(BROWSER_WINDOW_CLOSE_ALLOWED_PRELOAD)
}
