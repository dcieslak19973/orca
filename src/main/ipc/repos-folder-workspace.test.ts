import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  getFolderWorkspacePathStatusForPathMock,
  scheduleWatcherSyncMock,
  folderWorkspaceChangeNotifier,
  mockStore
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getFolderWorkspacePathStatusForPathMock: vi.fn(),
  scheduleWatcherSyncMock: vi.fn(),
  folderWorkspaceChangeNotifier: { notifyFolderWorkspaceChanged: vi.fn() },
  mockStore: {
    getProjectGroups: vi.fn(),
    getRepos: vi.fn(),
    createFolderWorkspace: vi.fn()
  }
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: vi.fn()
  }
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(),
  gitSpawn: vi.fn()
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn(),
  getRepoName: vi.fn(),
  getBaseRefDefault: vi.fn(),
  searchBaseRefs: vi.fn()
}))

vi.mock('./filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

vi.mock('../project-groups/folder-workspace-path-status', () => ({
  assertFolderWorkspacePathUsable: vi.fn(),
  getFolderWorkspacePathStatus: vi.fn(),
  getFolderWorkspacePathStatusForPath: getFolderWorkspacePathStatusForPathMock
}))

vi.mock('./worktree-base-directory-watcher', () => ({
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: scheduleWatcherSyncMock
}))

import { registerRepoHandlers } from './repos'

describe('folder workspace repo IPC', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
    })
    getFolderWorkspacePathStatusForPathMock.mockReset().mockResolvedValue({ kind: 'available' })
    scheduleWatcherSyncMock.mockReset()
    folderWorkspaceChangeNotifier.notifyFolderWorkspaceChanged.mockReset()
    mainWindow.webContents.send.mockReset()
    mockStore.getProjectGroups.mockReset().mockReturnValue([
      {
        id: 'group-1',
        name: 'Runtime folders',
        parentPath: '/tmp/runtime-folders',
        connectionId: null
      }
    ])
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.createFolderWorkspace.mockReset().mockReturnValue({
      id: 'folder-1',
      projectGroupId: 'group-1',
      folderPath: '/tmp/runtime-folder'
    })

    registerRepoHandlers(mainWindow as never, mockStore as never, folderWorkspaceChangeNotifier)
  })

  it('publishes a runtime catalog notification after desktop folder creation', async () => {
    const create = handlers.get('folderWorkspaces:create')
    expect(create).toBeDefined()

    await create?.(null, {
      projectGroupId: 'group-1',
      name: 'Runtime folder',
      folderPath: '/tmp/runtime-folder'
    })

    expect(mockStore.createFolderWorkspace).toHaveBeenCalledOnce()
    expect(folderWorkspaceChangeNotifier.notifyFolderWorkspaceChanged).toHaveBeenCalledOnce()
    expect(scheduleWatcherSyncMock).toHaveBeenCalledOnce()
    expect(mainWindow.webContents.send).not.toHaveBeenCalledWith('repos:changed')
  })
})
