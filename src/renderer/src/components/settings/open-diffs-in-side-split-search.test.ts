import { afterEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { openDiffsInSideSplitMatchesSearch } from './OpenDiffsInSideSplitSetting'

const SIDE_SPLIT_KEY = 'auto.components.settings.git.search.sideSplit'

describe('openDiffsInSideSplitMatchesSearch', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('matches English keywords', () => {
    expect(openDiffsInSideSplitMatchesSearch('side split')).toBe(true)
    expect(openDiffsInSideSplitMatchesSearch('diff preview')).toBe(true)
  })

  it('does not match unrelated queries', () => {
    expect(openDiffsInSideSplitMatchesSearch('branch prefix')).toBe(false)
  })

  // Why: the Git pane's search catalog indexes localized aliases, so a localized query can match
  // the catalog. If this matcher knew only English, the pane would report a hit and then render
  // nothing. The translation is injected here because these keys are not yet in the locale files,
  // which would otherwise make the assertion vacuous (translate() returning its English fallback).
  it('matches a localized alias once one exists for the UI locale', async () => {
    i18n.addResourceBundle('zh', 'translation', { [SIDE_SPLIT_KEY]: '侧边分栏' }, true, true)
    await i18n.changeLanguage('zh')

    expect(openDiffsInSideSplitMatchesSearch('侧边分栏')).toBe(true)
    // English aliases stay searchable for devs who type them regardless of UI locale.
    expect(openDiffsInSideSplitMatchesSearch('side split')).toBe(true)
  })
})
