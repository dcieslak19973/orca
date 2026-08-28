import { describe, expect, it } from 'vitest'
import { getGeneralEditorSearchEntries } from './general-editor-search'
import { matchesSettingsSearch } from './settings-search'

describe('getGeneralEditorSearchEntries', () => {
  // Why: the pane only renders when the section catalog matches, so a setting that ships
  // its own SearchableSetting is still unreachable from search until it is listed here.
  it('makes Collapse Unchanged Regions reachable from settings search', () => {
    const entries = getGeneralEditorSearchEntries()
    for (const query of ['collapse unchanged', 'collapse', 'hide unchanged', 'fold', 'diff']) {
      expect(matchesSettingsSearch(query, [...entries])).toBe(true)
    }
  })
})
