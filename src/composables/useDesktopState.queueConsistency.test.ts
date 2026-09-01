import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDesktopState } from './useDesktopState'

const gatewayMocks = vi.hoisted(() => ({
  getThreadGroupsPage: vi.fn(),
  getThreadQueueState: vi.fn(),
  getThreadTitleCache: vi.fn(),
  getWorkspaceRootsState: vi.fn(),
}))

vi.mock('../api/codexGateway', () => ({
  ...gatewayMocks,
  getBackgroundThreadListLimit: vi.fn(() => 100),
  pickCodexRateLimitSnapshot: vi.fn(() => null),
}))

function installTestWindow(): void {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      removeItem: vi.fn((key: string) => store.delete(key)),
    },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  })
}

describe('queue hydration consistency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gatewayMocks.getThreadGroupsPage.mockResolvedValue({ groups: [], nextCursor: null })
    gatewayMocks.getThreadTitleCache.mockResolvedValue({ titles: {} })
    gatewayMocks.getWorkspaceRootsState.mockRejectedValue(new Error('no workspace roots'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries startup queue hydration after a transient bridge failure', async () => {
    installTestWindow()
    const queued = {
      id: 'q-retry',
      text: 'recover me',
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
    let queueReadCount = 0
    gatewayMocks.getThreadQueueState.mockImplementation(async () => {
      queueReadCount += 1
      if (queueReadCount === 1) throw new Error('bridge unavailable')
      return { 'retry-thread': [queued] }
    })

    const state = useDesktopState()
    state.primeSelectedThread('retry-thread')
    await state.refreshAll({ includeSelectedThreadMessages: false })
    expect(state.taskSnapshotsByThreadId.value['retry-thread']).toBeUndefined()

    await state.refreshAll({ includeSelectedThreadMessages: false })

    expect(queueReadCount).toBe(2)
    expect(state.taskSnapshotsByThreadId.value['retry-thread']).toMatchObject({
      state: 'queued',
      queueDepth: 1,
    })
  })
})
