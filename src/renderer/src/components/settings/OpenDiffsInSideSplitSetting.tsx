import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'

export const OPEN_DIFFS_IN_SIDE_SPLIT_KEYWORDS = [
  'diff split',
  'side split',
  'split right',
  'preview split',
  'diff preview',
  'open diff',
  'review layout',
  'tab group',
  'source control'
]

function getOpenDiffsInSideSplitTitle(): string {
  return translate(
    'auto.components.settings.GitPane.openDiffsInSideSplitTitle',
    'Open Diffs in a Side Split'
  )
}

function getOpenDiffsInSideSplitDescription(): string {
  return translate(
    'auto.components.settings.GitPane.openDiffsInSideSplitDescription',
    'Source Control diff previews open in a dedicated split beside your current tabs instead of covering the active tab group. Clicking through changed files keeps recycling the preview in that split.'
  )
}

export function openDiffsInSideSplitMatchesSearch(searchQuery: string): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getOpenDiffsInSideSplitTitle(),
    description: getOpenDiffsInSideSplitDescription(),
    keywords: OPEN_DIFFS_IN_SIDE_SPLIT_KEYWORDS
  })
}

export function OpenDiffsInSideSplitSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const title = getOpenDiffsInSideSplitTitle()
  const description = getOpenDiffsInSideSplitDescription()
  const enabled = settings.sourceControlOpenDiffsInSideSplit ?? false

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={OPEN_DIFFS_IN_SIDE_SPLIT_KEYWORDS}
      className="max-w-none"
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={enabled}
        onChange={() => {
          void updateSettings({ sourceControlOpenDiffsInSideSplit: !enabled })
        }}
      />
    </SearchableSetting>
  )
}
