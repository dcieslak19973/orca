import type { TabContentType } from './types'

/**
 * Tab content types backed by the editor surface. Preview replacement and side-split
 * targeting both key off this set, so it lives in one place — adding a member here must
 * not require finding every private copy of the predicate.
 */
export const EDITOR_TAB_CONTENT_TYPES = [
  'editor',
  'diff',
  'conflict-review',
  'check-details'
] as const

export function isEditorTabContentType(contentType: TabContentType): boolean {
  return (EDITOR_TAB_CONTENT_TYPES as readonly string[]).includes(contentType)
}
