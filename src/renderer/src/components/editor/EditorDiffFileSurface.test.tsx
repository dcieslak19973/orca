import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { DiffHunkStagingConfig } from './useDiffHunkStaging'

const diffViewerMock = vi.fn(() => null)

// Why: DiffViewer is normally lazy-loaded; stub the lazy-view module so the
// mock above receives every prop EditorDiffFileSurface passes through.
vi.mock('./editor-lazy-views', () => ({
  DiffViewer: (props: unknown) => diffViewerMock(props),
  ImageDiffViewer: () => null,
  MarkdownPreview: () => null
}))

import { EditorDiffFileSurface } from './EditorDiffFileSurface'

function createOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/file.ts',
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    worktreeId: 'repo::/repo',
    language: 'typescript',
    isDirty: false,
    mode: 'diff',
    ...overrides
  }
}

const diffContent: GitDiffResult = {
  kind: 'text',
  originalContent: 'old\n',
  modifiedContent: 'new\n',
  originalIsBinary: false,
  modifiedIsBinary: false
}

const hunkStaging: DiffHunkStagingConfig = {
  scope: 'staged',
  actionLabel: 'Unstage hunk',
  applyHunk: async () => {}
}

const markdownDocuments = {
  markdownDocuments: [],
  openMarkdownDocument: async () => {},
  onOpenDocLink: () => {},
  previewProps: { markdownDocuments: [], onOpenDocument: async () => {} },
  mdSave: async () => true
}

function renderSurface(overrides: Partial<Parameters<typeof EditorDiffFileSurface>[0]> = {}): void {
  renderToStaticMarkup(
    <EditorDiffFileSurface
      activeFile={createOpenFile({ diffSource: 'staged' })}
      diffContent={diffContent}
      editBuffer={undefined}
      resolvedLanguage="typescript"
      sideBySide={false}
      viewStateScopeId="scope"
      diffViewStateKey="key"
      mdViewMode="source"
      isMarkdown={false}
      showMarkdownTableOfContents={false}
      onCloseMarkdownTableOfContents={() => {}}
      markdownAnnotationsEnabled={false}
      markdownDocuments={markdownDocuments}
      onContentChange={() => {}}
      onSave={async () => true}
      reloadContent={() => {}}
      hunkStaging={hunkStaging}
      {...overrides}
    />
  )
}

describe('EditorDiffFileSurface', () => {
  it('forwards hunkStaging to DiffViewer for a staged (read-only) diff', () => {
    diffViewerMock.mockClear()

    renderSurface({ activeFile: createOpenFile({ diffSource: 'staged' }) })

    expect(diffViewerMock).toHaveBeenCalledTimes(1)
    const props = diffViewerMock.mock.calls[0]![0] as { editable: boolean; hunkStaging: unknown }
    // Why: a staged diff is not directly editable, but its hunks are still
    // stage/unstage targets — gating hunkStaging on `editable` silently
    // broke unstaging from the staged view.
    expect(props.editable).toBe(false)
    expect(props.hunkStaging).toBe(hunkStaging)
  })

  it('forwards hunkStaging to DiffViewer for an unstaged (editable) diff', () => {
    diffViewerMock.mockClear()

    renderSurface({ activeFile: createOpenFile({ diffSource: 'unstaged' }) })

    expect(diffViewerMock).toHaveBeenCalledTimes(1)
    const props = diffViewerMock.mock.calls[0]![0] as { editable: boolean; hunkStaging: unknown }
    expect(props.editable).toBe(true)
    expect(props.hunkStaging).toBe(hunkStaging)
  })
})
