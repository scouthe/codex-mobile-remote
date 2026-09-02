import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWorkspaceRootsProjectOrderState,
  collectWorkspaceRootPathsForProjectRemoval,
  filterGroupsByWorkspaceRoots,
  findAdjacentThreadId,
  removeThreadFromGroups,
  isThreadUnreadByLastRead,
  useDesktopState,
} from './useDesktopState'
import type { UiProjectGroup } from '../types/codex'
import type { WorkspaceRootsState } from '../api/codexGateway'
import { CodexApiError } from '../api/codexErrors'

const gatewayMocks = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  forkThread: vi.fn(),
  getAccountRateLimits: vi.fn(),
  getAvailableCollaborationModes: vi.fn(),
  getAvailableModelIds: vi.fn(),
  getCurrentModelConfig: vi.fn(),
  getPendingServerRequests: vi.fn(),
  getSkillsList: vi.fn(),
  getThreadDetail: vi.fn(),
  getThreadFastDetail: vi.fn(),
  getThreadGoal: vi.fn(),
  getThreadLiveState: vi.fn(),
  enqueueThreadMessage: vi.fn(),
  removeQueuedThreadMessage: vi.fn(),
  reorderQueuedThreadMessage: vi.fn(),
  getThreadGroupsPage: vi.fn(),
  getThreadQueueState: vi.fn(),
  getThreadTitleCache: vi.fn(),
  getWorkspaceRootsState: vi.fn(),
  generateThreadTitle: vi.fn(),
  interruptThreadTurn: vi.fn(),
  persistThreadTitle: vi.fn(),
  renameThread: vi.fn(),
  replyToServerRequest: vi.fn(),
  resumeThread: vi.fn(),
  revertThreadFileChanges: vi.fn(),
  rollbackThread: vi.fn(),
  setCodexSpeedMode: vi.fn(),
  setThreadGoal: vi.fn(),
  clearThreadGoal: vi.fn(),
  setThreadQueueState: vi.fn(),
  setWorkspaceRootsState: vi.fn(),
  startThread: vi.fn(),
  startThreadTurn: vi.fn(),
  subscribeCodexNotifications: vi.fn(),
}))

vi.mock('../api/codexGateway', () => ({
  ...gatewayMocks,
  getBackgroundThreadListLimit: vi.fn(() => 100),
  pickCodexRateLimitSnapshot: vi.fn(() => null),
}))

function thread(id: string, cwd: string, options: { hasWorktree?: boolean } = {}) {
  return {
    id,
    title: id,
    projectName: cwd ? cwd.split('/').at(-1) || cwd : 'Projectless',
    cwd,
    hasWorktree: options.hasWorktree ?? false,
    createdAtIso: '2026-04-28T00:00:00.000Z',
    updatedAtIso: '2026-04-28T00:00:00.000Z',
    preview: '',
    unread: false,
    inProgress: false,
  }
}

function installTestWindow(initialStorage: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialStorage))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key)
      }),
    },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  gatewayMocks.getThreadFastDetail.mockRejectedValue(new Error('fast snapshot not configured in test'))
  gatewayMocks.getThreadLiveState.mockRejectedValue(new Error('live state not configured in test'))
  gatewayMocks.getThreadQueueState.mockResolvedValue({})
  gatewayMocks.getThreadGoal.mockResolvedValue(null)
  gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
  gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('no workspace roots state'))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('filterGroupsByWorkspaceRoots', () => {
  it('keeps projectless chats visible when workspace roots are configured', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'Projectless',
        threads: [thread('projectless-chat', '')],
      },
      {
        projectName: 'allowed-project',
        threads: [thread('allowed-chat', '/tmp/allowed-project')],
      },
      {
        projectName: 'other-project',
        threads: [thread('other-chat', '/tmp/other-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/allowed-project'],
      labels: {},
      active: ['/tmp/allowed-project'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'Projectless',
      'allowed-project',
    ])
  })

  it('keeps workspace roots with the same folder name as separate projects', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'api',
        threads: [
          thread('first-api-chat', '/tmp/first/api'),
          thread('second-api-chat', '/tmp/second/api'),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {},
      active: ['/tmp/first/api', '/tmp/second/api'],
      projectOrder: [],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      '/tmp/first/api',
      '/tmp/second/api',
    ])
  })

  it('uses Codex project-order when workspace roots are hydrated', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('alpha-chat', '/tmp/alpha')],
      },
      {
        projectName: 'beta',
        threads: [thread('beta-chat', '/tmp/beta')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/alpha', '/tmp/beta'],
      labels: {},
      active: ['/tmp/alpha'],
      projectOrder: ['/tmp/beta', '/tmp/alpha'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => group.projectName)).toEqual([
      'beta',
      'alpha',
    ])
  })

  it('keeps empty duplicate workspace roots visible in Codex project order', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'TestChat',
        threads: [thread('testchat-chat', '/Users/igor/temp/TestChat')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      labels: {},
      active: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
      projectOrder: ['/Users/igor/Documents/New project 2/TestChat', '/Users/igor/temp/TestChat'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['/Users/igor/Documents/New project 2/TestChat', 0],
      ['/Users/igor/temp/TestChat', 1],
    ])
  })

  it('keeps remote projects from Codex project order visible as empty project rows', () => {
    const groups: UiProjectGroup[] = []
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.length])).toEqual([
      ['remote-project-id', 0],
      ['local-project', 0],
    ])
  })

  it('keeps managed worktree threads under the matching workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['codex-web-local', ['main-chat', 'worktree-chat']],
    ])
  })

  it('keeps unregistered managed worktrees under the main root when another managed worktree root is registered', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('registered-worktree-chat', '/Users/igor/.codex/worktrees/a77f/codex-web-local', { hasWorktree: true }),
          thread('unregistered-worktree-chat', '/Users/igor/.codex/worktrees/53e7/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: [
        '/Users/igor/Git-projects/codex-web-local',
        '/Users/igor/.codex/worktrees/a77f/codex-web-local',
      ],
      labels: {
        '/Users/igor/.codex/worktrees/a77f/codex-web-local': 'codex-web-local2',
      },
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat', 'unregistered-worktree-chat']],
      ['/Users/igor/.codex/worktrees/a77f/codex-web-local', ['registered-worktree-chat']],
    ])
  })

  it('does not group unrelated git worktrees under a same-leaf workspace root project', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'codex-web-local',
        threads: [
          thread('main-chat', '/Users/igor/Git-projects/codex-web-local'),
          thread('other-git-worktree-chat', '/tmp/other/.git/worktrees/codex-web-local', { hasWorktree: true }),
        ],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/Users/igor/Git-projects/codex-web-local'],
      labels: {},
      active: ['/Users/igor/Git-projects/codex-web-local'],
      projectOrder: ['/Users/igor/Git-projects/codex-web-local'],
    }

    expect(filterGroupsByWorkspaceRoots(groups, rootsState).map((group) => [group.projectName, group.threads.map((row) => row.id)])).toEqual([
      ['/Users/igor/Git-projects/codex-web-local', ['main-chat']],
    ])
  })
})

describe('removeThreadFromGroups', () => {
  it('removes an archived thread and drops the now-empty project group', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
      {
        projectName: 'archived-project',
        threads: [thread('archive-me', '/tmp/archived-project')],
      },
      {
        projectName: 'beta',
        threads: [thread('keep-beta', '/tmp/beta')],
      },
      {
        projectName: 'empty-workspace-root',
        threads: [],
      },
    ]

    expect(removeThreadFromGroups(groups, 'archive-me').map((group) => [
      group.projectName,
      group.threads.map((row) => row.id),
    ])).toEqual([
      ['alpha', ['keep-alpha']],
      ['beta', ['keep-beta']],
      ['empty-workspace-root', []],
    ])
  })

  it('preserves referential identity when the thread is absent', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'alpha',
        threads: [thread('keep-alpha', '/tmp/alpha')],
      },
    ]

    expect(removeThreadFromGroups(groups, 'missing-thread')).toBe(groups)
  })
})

describe('workspace roots project persistence helpers', () => {
  it('collects duplicate-path project roots by full path when removing a project', () => {
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/first/api', '/tmp/second/api'],
      labels: {
        '/tmp/first/api': 'First API',
        '/tmp/second/api': 'Second API',
      },
      active: ['/tmp/first/api'],
      projectOrder: ['/tmp/first/api', '/tmp/second/api'],
    }

    expect([...collectWorkspaceRootPathsForProjectRemoval(rootsState, '/tmp/first/api')]).toEqual([
      '/tmp/first/api',
    ])
  })

  it('preserves remote project ids in explicit project order when persisting workspace roots', () => {
    const groups: UiProjectGroup[] = [
      {
        projectName: 'local-project',
        threads: [thread('local-chat', '/tmp/local-project')],
      },
    ]
    const rootsState: WorkspaceRootsState = {
      order: ['/tmp/local-project'],
      labels: {},
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
      remoteProjects: [{
        id: 'remote-project-id',
        hostId: 'remote-ssh-discovered:a1',
        remotePath: '/home/ubuntu',
        label: 'ubuntu',
      }],
    }

    expect(buildWorkspaceRootsProjectOrderState(rootsState, ['remote-project-id', 'local-project'], groups)).toEqual({
      order: ['/tmp/local-project'],
      active: ['/tmp/local-project'],
      projectOrder: ['remote-project-id', '/tmp/local-project'],
    })
  })
})

describe('thread unread state helpers', () => {
  const cutoffIso = '2026-05-01T12:00:00.000Z'

  it('uses the initialization cutoff when a thread has no read state', () => {
    expect(isThreadUnreadByLastRead('2026-05-01T11:59:59.000Z', undefined, cutoffIso)).toBe(false)
    expect(isThreadUnreadByLastRead('2026-05-01T12:00:01.000Z', undefined, cutoffIso)).toBe(true)
  })

  it('uses per-thread read state instead of the global cutoff after a thread is read', () => {
    expect(isThreadUnreadByLastRead(
      '2026-05-01T12:30:00.000Z',
      '2026-05-01T12:45:00.000Z',
      cutoffIso,
    )).toBe(false)
    expect(isThreadUnreadByLastRead(
      '2026-05-01T12:50:00.000Z',
      '2026-05-01T12:45:00.000Z',
      cutoffIso,
    )).toBe(true)
  })
})

describe('collaboration mode selection', () => {
  it('can prime an empty selected thread without clearing persisted selection', () => {
    installTestWindow({
      'codex-web-local.selected-thread-id.v1': 'thread-a',
    })

    const state = useDesktopState()

    expect(state.selectedThreadId.value).toBe('thread-a')

    state.primeSelectedThread('', { persist: false })

    expect(state.selectedThreadId.value).toBe('')
    expect(window.localStorage.getItem('codex-web-local.selected-thread-id.v1')).toBe('thread-a')
  })

  it('does not carry plan mode from new chats into existing threads', () => {
    installTestWindow({
      'codex-web-local.collaboration-mode.v1': 'plan',
    })

    const state = useDesktopState()

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')

    expect(state.selectedCollaborationMode.value).toBe('plan')
    expect(window.localStorage.getItem('codex-web-local.collaboration-mode-by-context.v1')).toBe(null)

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.setSelectedCollaborationMode('plan')
    state.primeSelectedThread('thread-b')

    expect(state.selectedCollaborationMode.value).toBe('default')

    state.primeSelectedThread('thread-a')

    expect(state.selectedCollaborationMode.value).toBe('plan')
  })
})

describe('Codex CLI availability', () => {
  it('surfaces a chat runtime error when the app-server bridge cannot find Codex CLI', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockRejectedValue(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })

    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')
  })

  it('clears a previous Codex CLI missing banner when a later refresh fails for another reason', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockRejectedValueOnce(new Error('Codex CLI is not available. Install @openai/codex or set CODEXUI_CODEX_COMMAND.'))
      .mockRejectedValueOnce(new Error('Connection lost'))

    const state = useDesktopState()

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.codexCliMissingError.value).toBe('Codex CLI not found. Install @openai/codex or set CODEXUI_CODEX_COMMAND.')

    await state.refreshAll({ awaitAncillaryRefreshes: true })
    expect(state.error.value).toBe('Connection lost')
    expect(state.codexCliMissingError.value).toBe('')
  })

})

describe('startup request deduplication', () => {
  it('loads older thread pages while another thread is active', async () => {
    installTestWindow()
    const scheduledCallbacks: Array<() => void> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        scheduledCallbacks.push(callback as () => void)
      }
      return scheduledCallbacks.length
    }) as typeof window.setTimeout)
    gatewayMocks.getWorkspaceRootsState.mockResolvedValue({
      order: ['/home/heheheh/common', '/home/heheheh/Documents/coding/Sim2Glia-CL'],
      labels: {},
      active: ['/home/heheheh/common', '/home/heheheh/Documents/coding/Sim2Glia-CL'],
      projectOrder: ['/home/heheheh/common', '/home/heheheh/Documents/coding/Sim2Glia-CL'],
      remoteProjects: [],
    })
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{
          projectName: 'common',
          threads: [{ ...thread('active-thread', '/home/heheheh/common'), inProgress: true }],
        }],
        nextCursor: 'older-page',
      })
      .mockResolvedValueOnce({
        groups: [{
          projectName: 'Sim2Glia-CL',
          threads: [thread('older-thread', '/home/heheheh/Documents/coding/Sim2Glia-CL')],
        }],
        nextCursor: null,
      })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)
    expect(scheduledCallbacks).toHaveLength(1)

    scheduledCallbacks[0]?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledWith('older-page', 100)
    expect(state.projectGroups.value.find((group) => group.projectName === 'Sim2Glia-CL')?.threads.map((row) => row.id))
      .toEqual(['older-thread'])
  })

  it('does not starve older pages when active-task refreshes repeat', async () => {
    installTestWindow()
    const scheduledCallbacks: Array<() => void> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') scheduledCallbacks.push(callback as () => void)
      return scheduledCallbacks.length
    }) as typeof window.setTimeout)
    gatewayMocks.getWorkspaceRootsState.mockResolvedValue({
      order: ['/home/heheheh/common', '/home/heheheh/Documents/coding/Sim2Glia-CL'],
      labels: {},
      active: ['/home/heheheh/common', '/home/heheheh/Documents/coding/Sim2Glia-CL'],
      projectOrder: ['/home/heheheh/common', '/home/heheheh/Documents/coding/Sim2Glia-CL'],
      remoteProjects: [],
    })
    const firstPage = {
      groups: [{
        projectName: 'common',
        threads: [{ ...thread('active-thread', '/home/heheheh/common'), inProgress: true }],
      }],
      nextCursor: 'older-page',
    }
    gatewayMocks.getThreadGroupsPage.mockImplementation(async (cursor?: string | null) => cursor ? {
      groups: [{
        projectName: 'Sim2Glia-CL',
        threads: [thread('older-thread', '/home/heheheh/Documents/coding/Sim2Glia-CL')],
      }],
      nextCursor: null,
    } : firstPage)

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    expect(scheduledCallbacks).toHaveLength(1)

    // The status poll uses force=true and reaches the same scheduling path.
    // It must not replace the existing timer on every pass.
    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true, awaitAncillaryRefreshes: true })
    expect(scheduledCallbacks).toHaveLength(1)

    scheduledCallbacks[0]?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(gatewayMocks.getThreadGroupsPage).toHaveBeenLastCalledWith('older-page', 100)
    expect(state.projectGroups.value.find((group) => group.projectName === 'Sim2Glia-CL')?.threads.map((row) => row.id))
      .toEqual(['older-thread'])
  })

  it('reloads cached thread titles on forced thread refresh', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadTitleCache
      .mockResolvedValueOnce({ titles: {} })
      .mockResolvedValueOnce({ titles: { 'thread-1': 'Imported title' } })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    expect(state.projectGroups.value[0]?.threads[0]?.title).toBe('thread-1')

    await state.refreshAll({ includeSelectedThreadMessages: false, forceThreadRefresh: true })

    expect(gatewayMocks.getThreadTitleCache).toHaveBeenCalledTimes(2)
    expect(state.projectGroups.value[0]?.threads[0]?.title).toBe('Imported title')
  })

  it('reuses a just-loaded thread list during startup refresh bursts', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })

    try {
      const state = useDesktopState()
      await state.refreshAll({ includeSelectedThreadMessages: false })
      await state.refreshAll({ includeSelectedThreadMessages: false })

      expect(gatewayMocks.getThreadGroupsPage).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('reuses a just-loaded skills list for the same selected cwd', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([
      {
        name: 'example',
        description: 'Example skill',
        path: '/tmp/project/.agents/skills/example/SKILL.md',
        scope: 'project',
        enabled: true,
      },
    ])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])

    try {
      const state = useDesktopState()
      state.primeSelectedThread('thread-1')
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

      expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(1)
      expect(gatewayMocks.getSkillsList).toHaveBeenCalledWith(['/tmp/project'])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('reuses a just-loaded empty skills list for the same selected cwd', async () => {
    installTestWindow()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])

    try {
      const state = useDesktopState()
      state.primeSelectedThread('thread-1')
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
      await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

      expect(gatewayMocks.getSkillsList).toHaveBeenCalledTimes(1)
      expect(state.installedSkills.value).toEqual([])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('bypasses recent thread-list reuse for event-driven thread refreshes', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('thread-1', '/tmp/project')] }],
      nextCursor: null,
    })

    try {
      const state = useDesktopState()
      await state.refreshAll({ includeSelectedThreadMessages: false })
      const callsBeforeNotification = gatewayMocks.getThreadGroupsPage.mock.calls.length
      state.startPolling()
      expect(notificationHandler).toBeDefined()
      notificationHandler!({
        method: 'thread/name/updated',
        params: {
          threadId: 'thread-1',
          threadName: 'Updated title',
        },
      })
      await Promise.resolve()
      await Promise.resolve()

      expect(gatewayMocks.getThreadGroupsPage.mock.calls.length).toBeGreaterThan(callsBeforeNotification)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('shared session activity polling', () => {
  function activityThread(
    id: string,
    inProgress: boolean,
    revision: string,
    updatedAtIso = '2026-04-28T00:00:00.000Z',
  ) {
    return {
      ...thread(id, '/tmp/project'),
      inProgress,
      sessionActivityKnown: true,
      sessionRevision: revision,
      updatedAtIso,
    }
  }

  it('refreshes final messages when a desktop-owned session changes active to idle', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [activityThread('shared-thread', true, 'r1')] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [activityThread('shared-thread', false, 'r2')] }],
        nextCursor: null,
      })
    gatewayMocks.getThreadLiveState
      .mockResolvedValueOnce({
        messages: [{ id: 'partial', role: 'assistant', text: 'partial', messageType: 'agentMessage' }],
        inProgress: true,
        activeTurnId: 'turn-1',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        sessionActivityKnown: true,
        sessionRevision: 'r1',
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'final', role: 'assistant', text: 'final answer', messageType: 'agentMessage' }],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        sessionActivityKnown: true,
        sessionRevision: 'r2',
      })

    const state = useDesktopState()
    state.primeSelectedThread('shared-thread')

    await state.syncThreadStatus()
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(true)
    expect(state.messages.value.map((message) => message.text)).toEqual(['partial'])

    await state.syncThreadStatus()

    expect(gatewayMocks.getThreadLiveState).toHaveBeenCalledTimes(2)
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(false)
    expect(state.messages.value.map((message) => message.text)).toEqual(['final answer'])
  })

  it('clears completed non-selected threads from the sidebar immediately', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{
          projectName: 'Project',
          threads: [
            activityThread('selected-thread', true, 'selected-r1'),
            activityThread('background-thread', true, 'background-r1'),
          ],
        }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{
          projectName: 'Project',
          threads: [
            activityThread('selected-thread', false, 'selected-r2'),
            activityThread('background-thread', false, 'background-r2'),
          ],
        }],
        nextCursor: null,
      })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [{ id: 'partial', role: 'assistant', text: 'partial', messageType: 'agentMessage' }],
      inProgress: true,
      activeTurnId: 'turn-1',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getThreadLiveState
      .mockResolvedValueOnce({
        messages: [{ id: 'partial', role: 'assistant', text: 'partial', messageType: 'agentMessage' }],
        inProgress: true,
        activeTurnId: 'turn-1',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        sessionActivityKnown: true,
        sessionRevision: 'selected-r1',
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'final', role: 'assistant', text: 'final', messageType: 'agentMessage' }],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        sessionActivityKnown: true,
        sessionRevision: 'selected-r2',
      })

    const state = useDesktopState()
    state.primeSelectedThread('selected-thread')

    await state.syncThreadStatus()
    expect(state.projectGroups.value[0]?.threads.map((thread) => [thread.id, thread.inProgress])).toEqual([
      ['selected-thread', true],
      ['background-thread', true],
    ])

    await state.syncThreadStatus()

    expect(state.projectGroups.value[0]?.threads.map((thread) => [thread.id, thread.inProgress])).toEqual([
      ['selected-thread', false],
      ['background-thread', false],
    ])
  })

  it('uses a changed session revision to refresh once and reuses the stable result', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [activityThread('shared-thread', false, 'r1')] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [activityThread('shared-thread', false, 'r2')] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [activityThread('shared-thread', false, 'r2')] }],
        nextCursor: null,
      })
    gatewayMocks.getThreadLiveState
      .mockResolvedValueOnce({
        messages: [{ id: 'first', role: 'assistant', text: 'first', messageType: 'agentMessage' }],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        sessionActivityKnown: true,
        sessionRevision: 'r1',
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'second', role: 'assistant', text: 'second', messageType: 'agentMessage' }],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        sessionActivityKnown: true,
        sessionRevision: 'r2',
      })

    const state = useDesktopState()
    state.primeSelectedThread('shared-thread')

    await state.syncThreadStatus()
    await state.syncThreadStatus()
    await state.syncThreadStatus()

    expect(gatewayMocks.getThreadLiveState).toHaveBeenCalledTimes(2)
    expect(state.messages.value.map((message) => message.text)).toEqual(['second'])
  })

  it('uses the live projection when only the thread-list version changes', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [activityThread('version-thread', false, 'r1', '2026-04-28T00:00:00.000Z')] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [activityThread('version-thread', false, 'r1', '2026-04-28T00:01:00.000Z')] }],
        nextCursor: null,
      })
    gatewayMocks.getThreadLiveState.mockResolvedValue({
      messages: [{ id: 'latest', role: 'assistant', text: 'latest projection', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
      sessionActivityKnown: true,
      sessionRevision: 'r1',
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [{ id: 'stale', role: 'assistant', text: 'stale projection', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('version-thread')
    await state.syncThreadStatus()
    await state.syncThreadStatus()

    expect(gatewayMocks.getThreadDetail).not.toHaveBeenCalled()
    expect(gatewayMocks.getThreadLiveState).toHaveBeenCalledTimes(2)
    expect(state.messages.value.map((message) => message.text)).toEqual(['latest projection'])
  })

  it('detects an idle row even when an older bridge omits activity metadata', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [{ ...thread('legacy-thread', '/tmp/project'), inProgress: true }] }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [{ ...thread('legacy-thread', '/tmp/project'), inProgress: false }] }],
        nextCursor: null,
      })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [{ id: 'final', role: 'assistant', text: 'final', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('legacy-thread')
    await state.syncThreadStatus()
    await state.syncThreadStatus()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('legacy-thread')
    expect(state.projectGroups.value[0]?.threads[0]?.inProgress).toBe(false)
  })

  it('retries the live snapshot after a diagnostic fallback instead of consuming the revision', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage
      .mockResolvedValueOnce({
        groups: [{ projectName: 'Project', threads: [activityThread('shared-thread', true, 'r1')] }],
        nextCursor: null,
      })
      .mockResolvedValue({
        groups: [{ projectName: 'Project', threads: [activityThread('shared-thread', false, 'r2')] }],
        nextCursor: null,
      })
    gatewayMocks.getThreadLiveState
      .mockResolvedValueOnce({
        messages: [{ id: 'partial', role: 'assistant', text: 'partial', messageType: 'agentMessage' }],
        inProgress: true,
        activeTurnId: 'turn-1',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        sessionActivityKnown: true,
        sessionRevision: 'r1',
      })
      .mockResolvedValueOnce({
        messages: [],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        sessionActivityKnown: true,
        sessionRevision: 'r2',
        liveStateError: 'app-server unavailable',
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'final', role: 'assistant', text: 'final answer', messageType: 'agentMessage' }],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        sessionActivityKnown: true,
        sessionRevision: 'r2',
      })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [{ id: 'partial', role: 'assistant', text: 'partial', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('shared-thread')

    await state.syncThreadStatus()
    await state.syncThreadStatus()
    expect(state.messages.value.map((message) => message.text)).toEqual(['partial'])

    await state.syncThreadStatus()

    expect(gatewayMocks.getThreadLiveState).toHaveBeenCalledTimes(3)
    expect(state.messages.value.map((message) => message.text)).toEqual(['final answer'])
  })

  it('clears and recreates the status poll timer with the polling lifecycle', async () => {
    installTestWindow()
    const setIntervalMock = vi.fn(() => 17)
    const clearIntervalMock = vi.fn()
    const unsubscribe = vi.fn()
    Object.assign(window, {
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    })
    gatewayMocks.subscribeCodexNotifications.mockReturnValue(unsubscribe)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('retry-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.setThreadQueueState.mockResolvedValue(undefined)

    const state = useDesktopState()
    state.startPolling()
    await Promise.resolve()

    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 1500)
    expect(setIntervalMock).toHaveBeenCalledTimes(1)

    state.stopPolling()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(clearIntervalMock).toHaveBeenCalledWith(17)

    state.startPolling()
    await Promise.resolve()
    expect(setIntervalMock).toHaveBeenCalledTimes(2)

    state.stopPolling()
  })
})

describe('thread selection latency', () => {
  it('does not block the message view on ancillary model refresh', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [{ id: 'message-1', role: 'assistant', text: 'ready', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getCurrentModelConfig.mockImplementation(() => new Promise(() => {}))

    const state = useDesktopState()
    const result = await Promise.race([
      state.selectThread('fast-thread').then(() => 'selected'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ])

    expect(result).toBe('selected')
    expect(state.messages.value.map((message) => message.text)).toEqual(['ready'])
  })

  it('paints a bounded fast snapshot before full thread hydration completes', async () => {
    installTestWindow()
    gatewayMocks.getThreadFastDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [{ id: 'message-fast', role: 'assistant', text: 'fast answer', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: true,
      turnIndexByTurnId: {},
      partial: true,
    })
    gatewayMocks.getThreadDetail.mockImplementation(() => new Promise(() => {}))

    const state = useDesktopState()
    const result = await Promise.race([
      state.selectThread('fast-thread').then(() => 'selected'),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ])

    expect(result).toBe('selected')
    expect(state.messages.value.map((message) => message.text)).toEqual(['fast answer'])
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(gatewayMocks.getThreadFastDetail).toHaveBeenCalledWith('fast-thread')
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('fast-thread')
  })

  it('does not let a stale plain thread read clear a newer active task snapshot', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce({
        messages: [{ id: 'active', role: 'assistant', text: 'working', messageType: 'agentMessage' }],
        inProgress: true,
        activeTurnId: 'turn-new',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'stale', role: 'assistant', text: 'old projection', messageType: 'agentMessage' }],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
        taskState: 'completed',
      })

    const state = useDesktopState()
    state.primeSelectedThread('stale-read-thread')
    await state.loadMessages('stale-read-thread', { force: true })
    await state.loadMessages('stale-read-thread', { force: true })

    expect(state.selectedTaskSnapshot.value).toMatchObject({
      state: 'running',
      activeTurnId: 'turn-new',
    })
  })

  it('does not let an event-driven stale thread read replace a newer fast snapshot', async () => {
    installTestWindow()
    const callbacks: Array<() => void> = []
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        callbacks.push(callback as () => void)
        queueMicrotask(callback as () => void)
      }
      return callbacks.length
    }) as typeof window.setTimeout)
    Object.assign(window, {
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    })

    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{
        projectName: 'Project',
        threads: [{
          ...thread('event-refresh-thread', '/tmp/project'),
          sessionActivityKnown: true,
          sessionRevision: 'r2',
          inProgress: false,
        }],
      }],
      nextCursor: null,
    })
    gatewayMocks.getThreadFastDetail.mockResolvedValue({
      messages: [{ id: 'latest', role: 'assistant', text: 'latest conversation', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: true,
      turnIndexByTurnId: {},
      partial: true,
      fullHydrationDeferred: true,
      sessionActivityKnown: true,
      sessionRevision: 'r2',
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [{ id: 'stale', role: 'assistant', text: 'stale projection', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getThreadLiveState.mockResolvedValue({
      messages: [{ id: 'latest', role: 'assistant', text: 'latest conversation', messageType: 'agentMessage' }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: true,
      turnIndexByTurnId: {},
      sessionActivityKnown: true,
      sessionRevision: 'r2',
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false })
    state.primeSelectedThread('event-refresh-thread')
    await state.selectThread('event-refresh-thread')
    expect(state.messages.value.map((message) => message.text)).toEqual(['latest conversation'])
    gatewayMocks.getThreadDetail.mockClear()
    gatewayMocks.getThreadLiveState.mockClear()

    state.startPolling()
    await Promise.resolve()
    await Promise.resolve()
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/completed',
      params: {
        threadId: 'event-refresh-thread',
        turn: { id: 'turn-1', status: 'completed' },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(state.messages.value.map((message) => message.text)).toContain('latest conversation')
    expect(state.messages.value.map((message) => message.text)).not.toContain('stale projection')
  })

  it('preserves already loaded history when a later projection is partial', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce({
        messages: [
          { id: 'older', role: 'assistant', text: 'older history', messageType: 'agentMessage', turnIndex: 0 },
          { id: 'newer', role: 'assistant', text: 'newer history', messageType: 'agentMessage', turnIndex: 1 },
        ],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'newer', role: 'assistant', text: 'newer history', messageType: 'agentMessage', turnIndex: 1 }],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: true,
        turnIndexByTurnId: {},
      })

    const state = useDesktopState()
    state.primeSelectedThread('partial-refresh-thread')
    await state.loadMessages('partial-refresh-thread', { force: true, fast: false })
    await state.loadMessages('partial-refresh-thread', { force: true, fast: false })

    expect(state.messages.value.map((message) => message.text)).toEqual(['older history', 'newer history'])
  })

  it('keeps full history when an event refresh uses a bounded live tail', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
        messages: [
          { id: 'older', role: 'assistant', text: 'older history', messageType: 'agentMessage', turnIndex: 0 },
          { id: 'newer', role: 'assistant', text: 'newer history', messageType: 'agentMessage', turnIndex: 1 },
      ],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getThreadLiveState.mockResolvedValue({
      messages: [{ id: 'newer', role: 'assistant', text: 'newer history', messageType: 'agentMessage', turnIndex: 1 }],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: true,
      partial: true,
      fullHydrationDeferred: true,
      turnIndexByTurnId: {},
      sessionActivityKnown: true,
      sessionRevision: 'r2',
    })

    const state = useDesktopState()
    state.primeSelectedThread('live-tail-thread')
    await state.loadMessages('live-tail-thread', { force: true, fast: false })
    await state.loadMessages('live-tail-thread', { force: true, preferLiveState: true })

    expect(state.messages.value.map((message) => message.text)).toEqual(['older history', 'newer history'])
  })

  it('removes rows omitted from the indexed partial window while keeping older turns', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail
      .mockResolvedValueOnce({
        messages: [
          { id: 'old', role: 'assistant', text: 'old history', messageType: 'agentMessage', turnIndex: 0 },
          { id: 'kept', role: 'assistant', text: 'kept history', messageType: 'agentMessage', turnIndex: 1 },
          { id: 'removed', role: 'assistant', text: 'rolled back', messageType: 'agentMessage', turnIndex: 2 },
        ],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: false,
        turnIndexByTurnId: {},
      })
      .mockResolvedValueOnce({
        messages: [{ id: 'kept', role: 'assistant', text: 'kept history', messageType: 'agentMessage', turnIndex: 1 }],
        inProgress: false,
        activeTurnId: '',
        hasMoreOlder: true,
        turnIndexByTurnId: {},
      })

    const state = useDesktopState()
    state.primeSelectedThread('partial-window-thread')
    await state.loadMessages('partial-window-thread', { force: true, fast: false })
    await state.loadMessages('partial-window-thread', { force: true, fast: false })

    expect(state.messages.value.map((message) => message.text)).toEqual(['old history', 'kept history'])
  })

  it('ignores late item and completion events from an older turn', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('out-of-order-thread')
    await state.loadMessages('out-of-order-thread')
    gatewayMocks.getThreadDetail.mockImplementation(() => new Promise(() => {}))
    gatewayMocks.getThreadGroupsPage.mockImplementation(() => new Promise(() => {}))
    state.startPolling()

    notificationHandler({
      method: 'turn/started',
      params: { threadId: 'out-of-order-thread', turn: { id: 'turn-new' } },
    })
    notificationHandler({
      method: 'item/agentMessage/delta',
      params: { threadId: 'out-of-order-thread', turnId: 'turn-old', itemId: 'old-item', delta: 'stale' },
    })
    notificationHandler({
      method: 'turn/completed',
      params: {
        threadId: 'out-of-order-thread',
        turnId: 'turn-old',
        turn: { id: 'turn-old', status: 'completed' },
      },
    })

    expect(state.selectedTaskSnapshot.value).toMatchObject({
      state: 'starting',
      activeTurnId: 'turn-new',
    })
    expect(state.selectedLiveOverlay.value?.errorText).toBe('')
  })
})

describe('live error overlay', () => {
  it('loads an existing thread through read-only detail without resuming it', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('observer-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        text: 'already running',
        messageType: 'agentMessage',
      }],
      inProgress: true,
      activeTurnId: 'turn-1',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('observer-thread')
    await state.refreshAll({ includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('observer-thread')
    expect(state.messages.value.map((message) => message.text)).toContain('already running')
  })

  it('shows the default thinking overlay while a selected thread is in progress without activity events', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'create todo list app',
          messageType: 'userMessage',
        },
      ],
      inProgress: true,
      activeTurnId: 'turn-1',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-thinking')
    await state.loadMessages('thread-thinking')

    expect(state.selectedLiveOverlay.value).toMatchObject({
      activityLabel: 'Thinking',
      reasoningText: '',
      errorText: '',
    })
  })

  it('atomically appends queued messages through the bridge', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('queued-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5'])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-1',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.enqueueThreadMessage.mockImplementation(async (_threadId, message) => ({
      inserted: true,
      queue: [message],
    }))

    const state = useDesktopState()
    state.primeSelectedThread('queued-thread')
    await state.refreshAll({ includeSelectedThreadMessages: true, awaitAncillaryRefreshes: true })
    await state.sendMessageToSelectedThread('run after current task', [], [], 'queue')

    expect(gatewayMocks.enqueueThreadMessage).toHaveBeenCalledWith(
      'queued-thread',
      expect.objectContaining({
        text: 'run after current task',
        status: 'queued',
        sourceClientId: expect.stringMatching(/^web-/),
        createdAtIso: expect.any(String),
        attempts: 0,
      }),
    )
    expect(state.selectedThreadQueuedMessages.value).toHaveLength(1)
    expect(state.selectedTaskSnapshot.value?.state).toBe('running')
    expect(state.selectedTaskSnapshot.value?.queueDepth).toBe(1)
  })

  it('sends directly when the local active flag is stale but the live session is idle', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-1',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.resumeThread.mockResolvedValue({ model: 'gpt-5.5', modelProvider: 'openai' })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-2')
    gatewayMocks.enqueueThreadMessage.mockResolvedValue({ inserted: true, queue: [] })
    gatewayMocks.setThreadQueueState.mockResolvedValue(undefined)

    const state = useDesktopState()
    state.primeSelectedThread('stale-active-thread')
    await state.loadMessages('stale-active-thread')

    gatewayMocks.getThreadLiveState.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
      sessionActivityKnown: true,
      sessionRevision: 'idle-revision',
      streamCursor: null,
      liveStateError: null,
      taskState: 'completed',
      currentActivity: { kind: 'idle', label: 'Completed', details: [] },
      queueDepth: 0,
      activeRequest: null,
      writerClient: null,
      startedAt: null,
      finishedAt: '2026-08-31T00:01:00.000Z',
      timeline: [],
    })

    await state.sendTaskMessage('run while session is idle')

    expect(gatewayMocks.getThreadLiveState).toHaveBeenCalledWith('stale-active-thread')
    expect(gatewayMocks.enqueueThreadMessage).not.toHaveBeenCalled()
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'stale-active-thread', 'run while session is idle', [], 'gpt-5.5', 'medium', undefined, [], 'default',
    )
  })

  it('appends behind an existing queue even when the session itself is idle', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('queued-idle-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getThreadQueueState.mockResolvedValue({
      'queued-idle-thread': [{
        id: 'q-existing',
        text: 'existing queued work',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        createdAtIso: '2026-08-31T00:00:00.000Z',
        sourceClientId: 'desktop',
        status: 'queued',
        attempts: 0,
        lastError: '',
      }],
    })
    gatewayMocks.enqueueThreadMessage.mockImplementation(async (_threadId, message) => ({
      inserted: true,
      queue: [{
        id: 'q-existing',
        text: 'existing queued work',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        createdAtIso: '2026-08-31T00:00:00.000Z',
        sourceClientId: 'desktop',
        status: 'queued',
        attempts: 0,
        lastError: '',
      }, message],
    }))

    const state = useDesktopState()
    state.primeSelectedThread('queued-idle-thread')
    await state.refreshAll({ includeSelectedThreadMessages: true })
    await state.sendMessageToSelectedThread('run after existing queue')

    expect(gatewayMocks.enqueueThreadMessage).toHaveBeenCalledWith(
      'queued-idle-thread',
      expect.objectContaining({ text: 'run after existing queue', status: 'queued' }),
    )
    expect(gatewayMocks.startThreadTurn).not.toHaveBeenCalled()
    expect(state.selectedThreadQueuedMessages.value).toHaveLength(2)
  })

  it('keeps normal send and explicit steer as separate task operations', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5', modelProvider: 'openai', messages: [], inProgress: true,
      activeTurnId: 'turn-1', hasMoreOlder: false, turnIndexByTurnId: {},
    })
    gatewayMocks.enqueueThreadMessage.mockResolvedValue({ inserted: true, queue: [{
      id: 'q-1', text: 'normal', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default',
    }] })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-2')
    gatewayMocks.resumeThread.mockResolvedValue({ model: 'gpt-5.5', modelProvider: 'openai' })
    const state = useDesktopState()
    state.primeSelectedThread('operation-thread')
    await state.loadMessages('operation-thread')
    await state.sendTaskMessage('normal')
    expect(gatewayMocks.enqueueThreadMessage).toHaveBeenCalled()
    await state.steerTaskMessage('guide')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'operation-thread', 'guide', [], 'gpt-5.5', 'medium', undefined, [], 'default',
    )
    expect(state.selectedTaskSnapshot.value?.state).toBe('steering')
  })

  it('queues a direct send when a stale browser state hits the active writer lock', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5', modelProvider: 'openai', messages: [], inProgress: false,
      activeTurnId: '', hasMoreOlder: false, turnIndexByTurnId: {},
    })
    gatewayMocks.resumeThread.mockResolvedValue({
      model: 'gpt-5.5', modelProvider: 'openai', messages: [], inProgress: false,
      activeTurnId: '', hasMoreOlder: false, turnIndexByTurnId: {},
    })
    gatewayMocks.startThreadTurn.mockRejectedValue(new CodexApiError(
      'RPC turn/start failed with HTTP 502: thread shared-writer-thread already has an active writer',
      { code: 'http_error', method: 'turn/start', status: 502 },
    ))
    gatewayMocks.enqueueThreadMessage.mockImplementation(async (_threadId, message) => ({
      inserted: true,
      queue: [message],
    }))

    const state = useDesktopState()
    state.primeSelectedThread('shared-writer-thread')
    await state.loadMessages('shared-writer-thread')

    await expect(state.sendMessageToSelectedThread('send after desktop task')).resolves.toBeUndefined()

    expect(gatewayMocks.enqueueThreadMessage).toHaveBeenCalledWith(
      'shared-writer-thread',
      expect.objectContaining({
        text: 'send after desktop task',
        status: 'queued',
        sourceClientId: expect.stringMatching(/^web-/),
      }),
    )
    expect(state.selectedThreadQueuedMessages.value).toHaveLength(1)
    expect(state.selectedTaskSnapshot.value?.queueDepth).toBe(1)
    expect(state.selectedTaskSnapshot.value?.error).toBeNull()
  })

  it('clears the reducer active state when a direct start fails before turn/started', async () => {
    installTestWindow()
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5', modelProvider: 'openai', messages: [], inProgress: false,
      activeTurnId: '', hasMoreOlder: false, turnIndexByTurnId: {},
    })
    gatewayMocks.resumeThread.mockResolvedValue({ model: 'gpt-5.5', modelProvider: 'openai' })
    gatewayMocks.startThreadTurn.mockRejectedValue(new Error('provider unavailable'))

    const state = useDesktopState()
    state.primeSelectedThread('start-failure-thread')
    await state.loadMessages('start-failure-thread')

    await expect(state.sendTaskMessage('should fail')).rejects.toThrow('provider unavailable')

    expect(state.selectedTaskSnapshot.value?.state).toBe('completed')
    expect(state.selectedTaskSnapshot.value?.activeTurnId).toBe('')
  })

  it('uses the shared live turn id when stopping an externally-owned task', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: true,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getThreadLiveState.mockResolvedValueOnce({
      messages: [],
      inProgress: true,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
      sessionActivityKnown: true,
      sessionRevision: 'active-revision',
      streamCursor: null,
      liveStateError: null,
    }).mockResolvedValueOnce({
      messages: [],
      inProgress: true,
      activeTurnId: 'desktop-turn-1',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
      sessionActivityKnown: true,
      sessionRevision: 'active-revision',
      streamCursor: null,
      liveStateError: null,
      taskState: 'running',
      currentActivity: { kind: 'thinking', label: 'Thinking', details: [] },
      queueDepth: 0,
      activeRequest: null,
      writerClient: null,
      startedAt: null,
      finishedAt: null,
      timeline: [],
    })
    gatewayMocks.interruptThreadTurn.mockResolvedValue(undefined)

    const state = useDesktopState()
    state.primeSelectedThread('external-task')
    await state.loadMessages('external-task')
    await state.interruptTask()

    expect(gatewayMocks.interruptThreadTurn).toHaveBeenCalledWith('external-task', 'desktop-turn-1')
  })

  it('keeps a new live error visible when an older persisted turn error exists', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'old-error',
          role: 'system',
          text: 'old persisted failure',
          messageType: 'turnError',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-with-errors')
    await state.loadMessages('thread-with-errors')
    state.startPolling()

    notificationHandler?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-with-errors',
        turnId: 'new-turn',
        turn: {
          id: 'new-turn',
          status: 'failed',
          error: { message: 'new live failure' },
        },
      },
    })

    expect(state.selectedLiveOverlay.value?.errorText).toBe('new live failure')
    expect(state.selectedTaskSnapshot.value).toMatchObject({
      state: 'failed',
      error: 'new live failure',
    })
  })

  it('suppresses a live error only after that same error has persisted', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([])
    gatewayMocks.resumeThread.mockResolvedValue(null)
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [
        {
          id: 'persisted-error',
          role: 'system',
          text: 'same failure',
          messageType: 'turnError',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      turnIndexByTurnId: {},
      hasMoreOlder: false,
    })

    const state = useDesktopState()
    state.primeSelectedThread('thread-with-persisted-error')
    await state.loadMessages('thread-with-persisted-error')
    state.startPolling()

    notificationHandler?.({
      method: 'turn/completed',
      params: {
        threadId: 'thread-with-persisted-error',
        turnId: 'same-turn',
        turn: {
          id: 'same-turn',
          status: 'failed',
          error: { message: 'same failure' },
        },
      },
    })

    expect(state.selectedLiveOverlay.value).toBe(null)
  })
})

describe.sequential('pending request state hydration', () => {
  it('applies sidebar request flags after reconnect hydration', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | null = null
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('pending-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([{
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'pending-thread' },
      receivedAtIso: '2026-08-31T00:00:00.000Z',
    }])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-1',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('pending-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    // Keep the periodic status refresh in flight so this assertion exercises
    // the pending-request replacement path itself rather than a later thread
    // list refresh that happens to re-derive the same flag.
    gatewayMocks.getThreadGroupsPage.mockImplementation(() => new Promise(() => {}))
    state.startPolling()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(state.projectGroups.value[0]?.threads[0]?.pendingRequestState).toBe('approval')
    notificationHandler = null
  })

  it('clears bridge-local pending request flags from an authoritative idle snapshot', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('stale-request-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getPendingServerRequests.mockResolvedValue([{
      id: 43,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'stale-request-thread' },
      receivedAtIso: '2026-08-31T00:00:00.000Z',
    }])
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
      taskState: 'completed',
      activeRequest: null,
      error: null,
    })

    const state = useDesktopState()
    state.primeSelectedThread('stale-request-thread')
    await state.refreshAll({ includeSelectedThreadMessages: true })

    expect(state.selectedThreadServerRequests.value).toEqual([])
    expect(state.projectGroups.value[0]?.threads[0]?.pendingRequestState).toBeNull()
    expect(state.selectedTaskSnapshot.value?.state).toBe('completed')
    expect(state.selectedTaskSnapshot.value?.activeRequest).toBeNull()
  })

  it('does not resurrect a resolved request from a stale reconnect response', async () => {
    installTestWindow()
    let notificationHandler: (notification: { method: string; params?: unknown }) => void = () => {}
    let pendingRequestReadResolve: (value: unknown) => void = () => {}
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockImplementation(() => new Promise(() => {}))
    gatewayMocks.getPendingServerRequests.mockImplementation(() => new Promise((resolve) => {
      pendingRequestReadResolve = resolve
    }))

    const state = useDesktopState()
    state.primeSelectedThread('pending-race-thread')
    state.startPolling()

    const request = {
      id: 44,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'pending-race-thread' },
      receivedAtIso: '2026-08-31T00:00:00.000Z',
    }
    notificationHandler({ method: 'server/request', params: request })
    notificationHandler({
      method: 'server/request/resolved',
      params: { id: request.id, threadId: 'pending-race-thread' },
    })

    pendingRequestReadResolve([request])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(state.selectedThreadServerRequests.value).toEqual([])
    expect(state.selectedTaskSnapshot.value?.activeRequest).toBeNull()
  })

  it('does not turn an emptied queue into a running task', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('queue-drained-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    const queued = {
      id: 'q-drain',
      text: 'queued work',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      createdAtIso: '2026-08-31T00:00:00.000Z',
      sourceClientId: 'web-test',
      status: 'queued' as const,
      attempts: 0,
      lastError: '',
    }
    gatewayMocks.getThreadQueueState
      .mockResolvedValueOnce({ 'queue-drained-thread': [queued] })
      .mockResolvedValueOnce({})

    const state = useDesktopState()
    state.primeSelectedThread('queue-drained-thread')
    await state.refreshAll({ includeSelectedThreadMessages: true })
    expect(state.selectedTaskSnapshot.value?.state).toBe('queued')

    gatewayMocks.removeQueuedThreadMessage.mockResolvedValue([])
    await state.removeQueuedMessage('q-drain')

    expect(state.selectedThreadQueuedMessages.value).toEqual([])
    expect(state.selectedTaskSnapshot.value?.state).toBe('completed')
  })

  it('does not replace an enqueue failure with a destructive whole-queue write', async () => {
    installTestWindow()
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [],
      inProgress: true,
      activeTurnId: 'turn-1',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.enqueueThreadMessage.mockRejectedValue(new Error('queue endpoint unavailable'))
    gatewayMocks.getThreadQueueState.mockResolvedValue({})

    const state = useDesktopState()
    state.primeSelectedThread('queue-write-failure')
    await state.loadMessages('queue-write-failure')

    await expect(state.sendTaskMessage('must not be lost')).rejects.toThrow('queue endpoint unavailable')

    expect(gatewayMocks.setThreadQueueState).not.toHaveBeenCalled()
    expect(state.selectedThreadQueuedMessages.value).toEqual([])
  })

  it('refreshes the queue list when another client emits a queue update', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | null = null
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('remote-queue-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })
    gatewayMocks.getThreadQueueState.mockResolvedValue({})

    const state = useDesktopState()
    state.startPolling()
    await Promise.resolve()
    gatewayMocks.getThreadQueueState.mockClear()
    gatewayMocks.getThreadQueueState.mockResolvedValue({
      'remote-queue-thread': [{
        id: 'q-remote',
        text: 'from another client',
        imageUrls: [],
        skills: [],
        fileAttachments: [],
        collaborationMode: 'default',
        createdAtIso: '2026-08-31T00:00:00.000Z',
        sourceClientId: 'desktop',
        status: 'queued',
        attempts: 0,
        lastError: '',
      }],
    })

    const emitNotification = notificationHandler as ((notification: { method: string; params?: unknown }) => void) | null
    if (emitNotification) {
      emitNotification({
        method: 'queue/updated',
        params: { threadId: 'remote-queue-thread', queueDepth: 1, status: 'enqueued' },
      })
    }
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(gatewayMocks.getThreadQueueState).toHaveBeenCalled()
    expect(state.taskSnapshotsByThreadId.value['remote-queue-thread']).toMatchObject({ state: 'queued', queueDepth: 1 })
  })
})

describe('provider model selection', () => {
  it('ignores global selected-model localStorage when OpenCode Zen is the active provider', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread__': 'gpt-5.5',
      }),
      'codex-web-local.selected-model-id.v1': 'gpt-5.5',
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'big-pickle',
      providerId: 'opencode-zen',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })
    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('big-pickle')
    expect(state.readModelIdForThread('').trim()).toBe('big-pickle')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::opencode-zen': 'big-pickle',
    })
    expect(window.localStorage.getItem('codex-web-local.selected-model-id.v1')).toBe(null)
  })

  it('restores a valid provider-scoped OpenCode Zen selected model from localStorage', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::opencode-zen': 'ring-2.6-1t-free',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'big-pickle',
      providerId: 'opencode-zen',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'deepseek-v4-flash-free',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('ring-2.6-1t-free')
    expect(state.readModelIdForThread('').trim()).toBe('ring-2.6-1t-free')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::opencode-zen': 'ring-2.6-1t-free',
    })
  })

  it('stores the new-thread Codex model in a provider-scoped slot', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::openrouter-free': 'openrouter/free',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::openrouter-free': 'openrouter/free',
      '__new-thread-provider__::codex': 'gpt-5.5',
    })
  })

  it('drops stale non-Codex selected models from the Codex model list', async () => {
    installTestWindow({
      'codex-web-local.selected-model-by-context.v1': JSON.stringify({
        '__new-thread-provider__::codex': 'big-pickle',
      }),
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(state.availableModelIds.value).toEqual([
      'gpt-5.5',
      'gpt-5.4-mini',
    ])
    expect(state.availableModelIds.value).not.toContain('big-pickle')
    expect(state.selectedModelId.value).toBe('gpt-5.5')
    expect(state.readModelIdForThread('').trim()).toBe('gpt-5.5')
    expect(JSON.parse(window.localStorage.getItem('codex-web-local.selected-model-by-context.v1') ?? '{}')).toEqual({
      '__new-thread-provider__::codex': 'gpt-5.5',
    })
  })

  it('keeps an existing OpenCode Zen thread locked to Zen models after Codex auth becomes active', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('legacy-zen-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockImplementation(async (options?: { providerId?: string }) => {
      if (options?.providerId === 'opencode-zen') {
        return ['big-pickle', 'ring-2.6-1t-free']
      }
      return ['gpt-5.5', 'gpt-5.4-mini']
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'opencode_zen',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('legacy-zen-thread')
    await state.loadMessages('legacy-zen-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenLastCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })
    expect(state.availableModelIds.value).toEqual([
      'big-pickle',
      'ring-2.6-1t-free',
    ])
    expect(state.selectedModelId.value).toBe('big-pickle')
    expect(state.readModelIdForThread('legacy-zen-thread')).toBe('big-pickle')
    expect(state.readModelIdForThread('')).toBe('gpt-5.4-mini')
  })

  it('loads provider models for a selected provider-backed thread during scheduled refreshes', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({
      groups: [{ projectName: 'Project', threads: [thread('legacy-zen-thread', '/tmp/project')] }],
      nextCursor: null,
    })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockImplementation(async (options?: { providerId?: string }) => {
      if (options?.providerId === 'opencode-zen') {
        return ['big-pickle', 'ring-2.6-1t-free']
      }
      return ['gpt-5.5', 'gpt-5.4-mini']
    })
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'opencode_zen',
      messages: [],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    state.primeSelectedThread('legacy-zen-thread')
    await state.loadMessages('legacy-zen-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))

    expect(gatewayMocks.getAvailableModelIds).toHaveBeenLastCalledWith({
      includeProviderModels: true,
      requireProviderModels: true,
      providerId: 'opencode-zen',
    })
    expect(state.availableModelIds.value).toEqual(['big-pickle', 'ring-2.6-1t-free'])
    expect(state.selectedModelId.value).toBe('big-pickle')
  })

  it('captures the active provider when creating a new thread', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.4-mini'])
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'codex-thread',
      model: 'gpt-5.5',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.5',
      modelProvider: 'openai',
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi.',
          messageType: 'agentMessage',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.sendMessageToNewThread('hi', '/tmp/project')

    expect(gatewayMocks.startThread).toHaveBeenCalledWith('/tmp/project', 'gpt-5.5')
    expect(gatewayMocks.startThreadTurn).toHaveBeenCalledWith(
      'codex-thread',
      'hi',
      [],
      'gpt-5.5',
      'medium',
      undefined,
      [],
      'default',
    )
    expect(state.readModelIdForThread('codex-thread')).toBe('gpt-5.5')
    expect(state.messages.value.some((message) => (
      message.role === 'user' &&
      message.text === 'hi' &&
      message.messageType === 'userMessage.optimistic'
    ))).toBe(true)

    const modelConfigCallsBeforeLoad = gatewayMocks.getCurrentModelConfig.mock.calls.length
    const availableModelCallsBeforeLoad = gatewayMocks.getAvailableModelIds.mock.calls.length
    await state.loadMessages('codex-thread')
    expect(gatewayMocks.getCurrentModelConfig).toHaveBeenCalledTimes(modelConfigCallsBeforeLoad)
    expect(gatewayMocks.getAvailableModelIds).toHaveBeenCalledTimes(availableModelCallsBeforeLoad)
    expect(state.messages.value.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hi',
      'assistant:Hi.',
    ])
  })

  it('refreshes a loaded optimistic thread when completion events arrive', async () => {
    installTestWindow()
    vi.mocked(window.setTimeout).mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === 'function') {
        void Promise.resolve().then(() => callback())
      }
      return 1
    }) as typeof window.setTimeout)
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.4-mini',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.4-mini'])
    gatewayMocks.startThread.mockResolvedValue({
      threadId: 'mini-thread',
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
    })
    gatewayMocks.startThreadTurn.mockResolvedValue('turn-1')
    gatewayMocks.getThreadDetail.mockResolvedValue({
      model: 'gpt-5.4-mini',
      modelProvider: 'openai',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'hi',
          messageType: 'userMessage',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'Hi.',
          messageType: 'agentMessage',
        },
      ],
      inProgress: false,
      activeTurnId: '',
      hasMoreOlder: false,
      turnIndexByTurnId: {},
    })

    const state = useDesktopState()
    await state.refreshAll({ includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true })
    await state.sendMessageToNewThread('hi', '/tmp/project')
    state.startPolling()
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'turn/completed',
      params: {
        threadId: 'mini-thread',
        turn: { id: 'turn-1', status: 'completed' },
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(gatewayMocks.getThreadDetail).toHaveBeenCalledWith('mini-thread')
    expect(state.messages.value.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hi',
      'system:Worked for <1s',
      'assistant:Hi.',
    ])
  })

  it('surfaces selected thread load failures and still refreshes models', async () => {
    installTestWindow()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }])
    gatewayMocks.getSkillsList.mockResolvedValue([])
    gatewayMocks.getAccountRateLimits.mockResolvedValue(null)
    gatewayMocks.getCurrentModelConfig.mockResolvedValue({
      model: 'gpt-5.5',
      providerId: '',
      reasoningEffort: 'medium',
      speedMode: 'standard',
    })
    gatewayMocks.getAvailableModelIds.mockResolvedValue(['gpt-5.5', 'gpt-5.4-mini'])
    gatewayMocks.getThreadDetail.mockRejectedValue(new Error('thread not found'))

    const state = useDesktopState()
    state.primeSelectedThread('missing-thread')
    await state.refreshAll({
      includeSelectedThreadMessages: true,
      awaitAncillaryRefreshes: true,
    })

    expect(state.selectedLiveOverlay.value?.errorText).toContain('thread not found')
    expect(state.availableModelIds.value).toEqual(['gpt-5.5', 'gpt-5.4-mini'])
    expect(state.selectedModelId.value).toBe('gpt-5.5')

    await state.ensureThreadMessagesLoaded('missing-thread', { silent: true })
    await state.loadMessages('missing-thread')
    expect(gatewayMocks.resumeThread).not.toHaveBeenCalled()
  })
})

describe('official thread goals', () => {
  it('keeps the selected goal synchronized through the shared notification stream', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    const initialGoal = {
      threadId: 'goal-thread',
      objective: 'Keep Desktop and mobile synchronized',
      status: 'active' as const,
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2,
    }
    gatewayMocks.setThreadGoal.mockResolvedValue(initialGoal)
    gatewayMocks.clearThreadGoal.mockResolvedValue(undefined)

    const state = useDesktopState()
    state.primeSelectedThread('goal-thread')
    await state.updateSelectedThreadGoal(initialGoal.objective)

    expect(gatewayMocks.setThreadGoal).toHaveBeenCalledWith('goal-thread', initialGoal.objective)
    expect(state.selectedThreadGoal.value).toEqual(initialGoal)

    state.startPolling()
    expect(notificationHandler).toBeDefined()
    notificationHandler!({
      method: 'thread/goal/updated',
      params: {
        threadId: 'goal-thread',
        turnId: null,
        goal: {
          ...initialGoal,
          status: 'complete',
          tokensUsed: 100,
          updatedAt: 3,
        },
      },
    })

    expect(state.selectedThreadGoal.value).toMatchObject({
      status: 'complete',
      tokensUsed: 100,
    })

    notificationHandler!({
      method: 'thread/goal/cleared',
      params: { threadId: 'goal-thread' },
    })
    expect(state.selectedThreadGoal.value).toBeNull()

    await state.clearSelectedThreadGoal()
    expect(gatewayMocks.clearThreadGoal).toHaveBeenCalledWith('goal-thread')
  })

  it('does not let an older goal read overwrite a newer cross-client notification', async () => {
    installTestWindow()
    let notificationHandler: ((notification: { method: string; params?: unknown }) => void) | undefined
    gatewayMocks.subscribeCodexNotifications.mockImplementation((handler) => {
      notificationHandler = handler as typeof notificationHandler
      return vi.fn()
    })
    let resolveGoalRead: ((value: null) => void) | undefined
    gatewayMocks.getThreadGoal.mockReturnValue(new Promise<null>((resolve) => {
      resolveGoalRead = resolve
    }))

    const state = useDesktopState()
    state.primeSelectedThread('goal-thread')
    state.startPolling()
    const pendingRead = state.loadThreadGoal('goal-thread', { force: true })

    notificationHandler!({
      method: 'thread/goal/updated',
      params: {
        threadId: 'goal-thread',
        goal: {
          threadId: 'goal-thread',
          objective: 'Notification wins',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 42,
          timeUsedSeconds: 5,
          createdAt: 1,
          updatedAt: 3,
        },
      },
    })
    resolveGoalRead?.(null)
    await pendingRead

    expect(state.selectedThreadGoal.value).toMatchObject({
      objective: 'Notification wins',
      tokensUsed: 42,
    })
  })
})

describe('findAdjacentThreadId', () => {
  it('selects the next thread after the archived thread', () => {
    const threads = [
      thread('first-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
      thread('next-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('next-thread')
  })

  it('falls back to the previous thread when the last thread is archived', () => {
    const threads = [
      thread('previous-thread', '/tmp/project'),
      thread('selected-thread', '/tmp/project'),
    ]

    expect(findAdjacentThreadId(threads, 'selected-thread')).toBe('previous-thread')
  })

  it('returns no fallback when there is no adjacent thread', () => {
    expect(findAdjacentThreadId([thread('selected-thread', '/tmp/project')], 'selected-thread')).toBe('')
  })
})
