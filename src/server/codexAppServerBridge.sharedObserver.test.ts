import { afterEach, describe, expect, it } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from './httpServer.js'
import { ThreadSessionBroker } from './threadSessionBroker.js'
import { ThreadSessionActivityReader } from './threadSessionActivity.js'

type RpcCall = { method: string; params: unknown }

function installFakeSharedBridge(options: {
  blockResume?: boolean
  failFirstTurnStart?: boolean
  failThreadRead?: boolean
  rejectDuplicateResume?: boolean
  rejectResumeWithActiveWriter?: boolean
  threadListResult?: unknown
  threadReadResults?: unknown[]
} = {}) {
  const globalScope = globalThis as typeof globalThis & { __codexRemoteSharedBridge__?: unknown }
  const previous = globalScope.__codexRemoteSharedBridge__
  const calls: RpcCall[] = []
  let releaseResume!: () => void
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve
  })
  let turnStartCalls = 0
  let threadReadCalls = 0
  let cacheLiveStateCalls = 0
  let generation = 1
  const appServer = {
    sessionActivityReader: new ThreadSessionActivityReader(),
    async rpc(method: string, params: unknown): Promise<unknown> {
      calls.push({ method, params })
      if (method === 'thread/resume') {
        if (options.rejectResumeWithActiveWriter) {
          throw new Error('thread already has an active writer')
        }
        if (options.rejectDuplicateResume && calls.filter((call) => call.method === 'thread/resume').length > 1) {
          throw new Error('thread already has an active writer')
        }
        if (options.blockResume !== false) await resumeGate
        return { thread: { id: 'shared-thread', turns: [] } }
      }
      if (method === 'turn/start' && options.failFirstTurnStart) {
        turnStartCalls += 1
        if (turnStartCalls === 1) throw new Error('thread not found: shared-thread')
        return { turn: { id: 'turn-2' } }
      }
      if (method === 'thread/read') {
        if (options.failThreadRead) throw new Error('app-server unavailable')
        const configured = options.threadReadResults?.[threadReadCalls]
        threadReadCalls += 1
        return configured ?? options.threadReadResults?.at(-1) ?? { thread: { id: 'shared-thread', turns: [] } }
      }
      if (method === 'thread/list') {
        return options.threadListResult ?? { data: [] }
      }
      if (method === 'config/read') {
        return { config: { model: 'gpt-5.5', model_provider: 'openai', model_providers: {} } }
      }
      return { ok: true }
    },
    onNotification: () => () => undefined,
    listPendingServerRequests: () => [],
    dispose: () => undefined,
    getStreamCursor: () => ({ streamEpoch: 'test-epoch', latestSeq: 0, oldestSeq: null }),
    getStreamEvents: () => [],
    getStreamEventsSince: () => ({ events: [], truncated: false }),
    getProcessGeneration: () => generation,
    getThreadSummarySnapshot: () => null,
    getSessionActivityReader: () => appServer.sessionActivityReader,
    storeThreadReadSnapshot: () => undefined,
    getLastThreadReadSnapshot: () => null,
    mergeItemsIntoTurns: (_threadId: string, turns: unknown[]) => turns,
    getCachedLiveState: () => null,
    cacheLiveState: () => { cacheLiveStateCalls += 1 },
  }
  const threadBroker = new ThreadSessionBroker(() => generation)
  const terminalManager = {
    subscribe: () => () => undefined,
    dispose: () => undefined,
  }
  const backendQueueProcessor = {
    dispose: () => undefined,
    scheduleAllQueuedThreads: async () => undefined,
    scheduleThreadQueueDrain: () => undefined,
  }
  const telegramBridge = {
    configureToken: () => undefined,
    configureAllowedUserIds: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    getStatus: () => ({
      configured: false,
      active: false,
      mappedChats: 0,
      mappedThreads: 0,
      allowedUsers: 0,
      allowAllUsers: false,
      lastError: '',
    }),
  }

  globalScope.__codexRemoteSharedBridge__ = {
    version: 'experimental-api-v3',
    appServer,
    terminalManager,
    methodCatalog: {},
    backendQueueProcessor,
    threadBroker,
    telegramBridge,
  }

  return {
    calls,
    sessionActivityReader: appServer.sessionActivityReader,
    get threadReadCalls() { return threadReadCalls },
    get cacheLiveStateCalls() { return cacheLiveStateCalls },
    get turnStartCalls() { return turnStartCalls },
    releaseResume,
    restore() {
      if (previous === undefined) delete globalScope.__codexRemoteSharedBridge__
      else globalScope.__codexRemoteSharedBridge__ = previous
    },
  }
}

afterEach(() => {
  const globalScope = globalThis as typeof globalThis & { __codexRemoteSharedBridge__?: unknown }
  delete globalScope.__codexRemoteSharedBridge__
})

describe('shared thread observer HTTP path', () => {
  it('serializes queue remove and reorder mutations from concurrent clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-queue-'))
    const previousCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = directory
    await writeFile(join(directory, '.codex-global-state.json'), JSON.stringify({
      'thread-queue-state': {
        'queue-thread': [
          { id: 'q-a', text: 'a', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default', createdAtIso: '2026-08-31T00:00:00.000Z', sourceClientId: 'a', status: 'queued', attempts: 0, lastError: '' },
          { id: 'q-b', text: 'b', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default', createdAtIso: '2026-08-31T00:00:01.000Z', sourceClientId: 'b', status: 'queued', attempts: 0, lastError: '' },
          { id: 'q-c', text: 'c', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default', createdAtIso: '2026-08-31T00:00:02.000Z', sourceClientId: 'c', status: 'queued', attempts: 0, lastError: '' },
        ],
      },
    }), 'utf8')
    const fake = installFakeSharedBridge()
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const endpoint = `http://127.0.0.1:${address.port}`
      await Promise.all([
        fetch(`${endpoint}/codex-api/thread-queue/remove`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: 'queue-thread', messageId: 'q-b' }),
        }),
        fetch(`${endpoint}/codex-api/thread-queue/reorder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: 'queue-thread', messageId: 'q-c', targetId: 'q-a' }),
        }),
      ])

      const response = await fetch(`${endpoint}/codex-api/thread-queue-state`)
      expect(response.status).toBe(200)
      const payload = await response.json() as { data?: Record<string, Array<{ id: string }>> }
      expect(payload.data?.['queue-thread']?.map((row) => row.id)).toEqual(['q-c', 'q-a'])
      const persisted = JSON.parse(await readFile(join(directory, '.codex-global-state.json'), 'utf8')) as Record<string, unknown>
      expect(persisted['thread-queue-state']).toBeDefined()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('adds an active status when a desktop-owned session is still running', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-bridge-'))
    const sessionPath = join(directory, 'rollout-shared-thread.jsonl')
    await writeFile(sessionPath, JSON.stringify({
      timestamp: '2026-08-31T01:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }) + '\n', 'utf8')
    const fake = installFakeSharedBridge({
      threadListResult: {
        data: [{
          id: 'shared-thread',
          path: sessionPath,
          status: { type: 'notLoaded' },
          turns: [],
        }],
      },
      threadReadResults: [{
        thread: {
          id: 'shared-thread',
          path: sessionPath,
          turns: [],
        },
      }],
    })
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'thread/list', params: {} }),
      })

      expect(response.status).toBe(200)
      const payload = await response.json() as { result?: { data?: Array<Record<string, unknown>> } }
      expect(payload.result?.data?.[0]).toMatchObject({
        inProgress: true,
        status: { type: 'inProgress' },
      })

      const liveResponse = await fetch(`http://127.0.0.1:${address.port}/codex-api/thread-live-state?threadId=shared-thread`)
      expect(liveResponse.status).toBe(200)
      const livePayload = await liveResponse.json() as Record<string, unknown>
      expect(livePayload).toMatchObject({
        taskState: 'running',
        activeTurnId: 'turn-1',
        queueDepth: 0,
        activeRequest: null,
        writerClient: expect.objectContaining({ clientType: 'desktop', label: 'Desktop' }),
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retries read-only projection after a terminal marker without resuming the thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-bridge-'))
    const sessionPath = join(directory, 'rollout-shared-thread.jsonl')
    const timestamp = new Date().toISOString()
    await writeFile(sessionPath, [
      { timestamp, type: 'turn_context', payload: { turn_id: 'turn-1' } },
      { timestamp, type: 'response_item', payload: {
        type: 'message', role: 'user', id: 'user-1', content: [{ type: 'input_text', text: 'hello' }],
      } },
      { timestamp, type: 'response_item', payload: {
        type: 'message', role: 'assistant', id: 'assistant-1', content: [{ type: 'output_text', text: 'done' }],
      } },
      { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')

    const stale = {
      thread: {
        id: 'shared-thread',
        path: sessionPath,
        status: { type: 'inProgress' },
        turns: [],
      },
    }
    const caughtUp = {
      thread: {
        id: 'shared-thread',
        path: sessionPath,
        status: { type: 'idle' },
        turns: [{ id: 'turn-1', status: 'completed', items: [{ id: 'assistant-1', type: 'agentMessage', text: 'done' }] }],
      },
    }
    const fake = installFakeSharedBridge({ threadReadResults: [stale, caughtUp] })
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/thread-live-state?threadId=shared-thread`)
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        isInProgress?: boolean
        thread?: { turns?: Array<{ id?: string }> }
      }
      expect(payload.isInProgress).toBe(false)
      expect(payload.thread?.turns?.some((turn) => turn.id === 'turn-1')).toBe(true)
      expect(fake.threadReadCalls).toBeGreaterThanOrEqual(2)
      expect(fake.cacheLiveStateCalls).toBe(1)
      expect(fake.calls.some((call) => call.method === 'thread/resume')).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not convert a transient live-state read failure into a failed task', async () => {
    const fake = installFakeSharedBridge({ failThreadRead: true })
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/thread-live-state?threadId=unavailable-thread`)
      expect(response.status).toBe(200)
      const payload = await response.json() as Record<string, unknown>
      expect(payload.liveStateError).toMatchObject({ message: 'app-server unavailable' })
      expect(payload.taskState).toBe('completed')
      expect(payload.error).toBeNull()
      expect(payload.isInProgress).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
    }
  })

  it('falls back to the terminal assistant response while projection is still stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-bridge-'))
    const sessionPath = join(directory, 'rollout-shared-thread.jsonl')
    const timestamp = new Date().toISOString()
    await writeFile(sessionPath, [
      { timestamp, type: 'turn_context', payload: { turn_id: 'turn-fallback' } },
      { timestamp, type: 'response_item', payload: {
        type: 'message', role: 'assistant', id: 'assistant-fallback', content: [{ type: 'output_text', text: 'final from session' }],
      } },
      { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-fallback' } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')

    const stale = {
      thread: {
        id: 'shared-thread',
        path: sessionPath,
        status: { type: 'inProgress' },
        turns: [],
      },
    }
    const fake = installFakeSharedBridge({ threadReadResults: [stale] })
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/thread-live-state?threadId=shared-thread`)
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        isInProgress?: boolean
        thread?: { turns?: Array<{ id?: string; items?: Array<{ type?: string; text?: string }> }> }
      }
      const turn = payload.thread?.turns?.find((candidate) => candidate.id === 'turn-fallback')
      expect(payload.isInProgress).toBe(false)
      expect(turn?.items).toContainEqual(expect.objectContaining({
        type: 'agentMessage',
        text: 'final from session',
      }))
      expect(fake.threadReadCalls).toBeGreaterThanOrEqual(2)
      expect(fake.cacheLiveStateCalls).toBe(0)
      expect(fake.calls.some((call) => call.method === 'thread/resume')).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps live-state reads bounded to the same recent-turn window as thread/read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-bridge-'))
    const sessionPath = join(directory, 'rollout-shared-thread.jsonl')
    await writeFile(sessionPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-14' },
    }) + '\n', 'utf8')

    const turns = Array.from({ length: 15 }, (_, index) => ({
      id: `turn-${index}`,
      status: 'inProgress',
      items: [{ id: `assistant-${index}`, type: 'agentMessage', text: `message-${index}` }],
    }))
    const fake = installFakeSharedBridge({
      threadReadResults: [{
        thread: {
          id: 'shared-thread',
          path: sessionPath,
          status: { type: 'inProgress' },
          turns,
        },
      }],
    })
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/thread-live-state?threadId=shared-thread`)
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        thread?: { turns?: Array<{ id?: string }> }
      }
      expect(payload.thread?.turns).toHaveLength(10)
      expect(payload.thread?.turns?.[0]?.id).toBe('turn-5')
      expect(fake.calls.some((call) => call.method === 'thread/resume')).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serves a fast recent-message snapshot without requesting full thread turns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-bridge-'))
    const sessionPath = join(directory, 'rollout-fast-thread.jsonl')
    const rows = [
      {
        timestamp: new Date().toISOString(),
        type: 'session_meta',
        payload: {
          id: 'fast-thread',
          cwd: '/tmp/project',
          model_provider: 'openai',
        },
      },
      {
        timestamp: new Date().toISOString(),
        type: 'turn_context',
        payload: { turn_id: 'turn-fast-1' },
      },
      {
        timestamp: new Date().toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'user-fast-1',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello fast path' }],
        },
      },
      {
        timestamp: new Date().toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'assistant-fast-1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'fast answer' }],
        },
      },
      {
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-fast-1' },
      },
    ]
    await writeFile(sessionPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    const fake = installFakeSharedBridge({
      threadReadResults: [{
        thread: {
          id: 'fast-thread',
          path: sessionPath,
          cwd: '/tmp/project',
          modelProvider: 'openai',
          turns: [],
        },
      }],
    })
    const originalRpc = fake.calls
    const globalScope = globalThis as typeof globalThis & { __codexRemoteSharedBridge__?: { appServer?: { rpc: (...args: unknown[]) => Promise<unknown> } } }
    const shared = globalScope.__codexRemoteSharedBridge__
    const appServer = shared?.appServer
    if (!appServer) throw new Error('Shared bridge app-server was not installed')
    const originalAppServerRpc = appServer.rpc
    appServer.rpc = async (method: unknown, params: unknown) => {
      if (method === 'thread/read' && (params as { includeTurns?: boolean })?.includeTurns === true) {
        throw new Error('full thread/read should not be used by fast snapshot')
      }
      return originalAppServerRpc(method, params)
    }

    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/thread-fast-state?threadId=fast-thread`)
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        partial?: boolean
        thread?: { turns?: Array<{ id?: string; items?: Array<{ type?: string; text?: string }> }> }
      }
      expect(payload.partial).toBe(true)
      expect(payload.thread?.turns).toContainEqual(expect.objectContaining({
        id: 'turn-fast-1',
        items: expect.arrayContaining([
          expect.objectContaining({ type: 'userMessage' }),
          expect.objectContaining({ type: 'agentMessage', text: 'fast answer' }),
        ]),
      }))
      expect(originalRpc.some((call) => call.method === 'thread/read')).toBe(true)
      expect(originalRpc.some((call) => call.method === 'thread/read' && (call.params as { includeTurns?: boolean })?.includeTurns === true)).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps live-state reads bounded for a large session without materializing full turns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-bridge-'))
    const sessionPath = join(directory, 'rollout-large-thread.jsonl')
    const timestamp = new Date().toISOString()
    const filler = JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: { id: 'shared-thread', padding: 'x'.repeat(9 * 1024 * 1024) },
    })
    const tailRows = [
      { timestamp, type: 'turn_context', payload: { turn_id: 'turn-large' } },
      { timestamp, type: 'response_item', payload: {
        type: 'message', role: 'user', id: 'user-large', content: [{ type: 'input_text', text: 'large session' }],
      } },
      { timestamp, type: 'response_item', payload: {
        type: 'message', role: 'assistant', id: 'assistant-large', content: [{ type: 'output_text', text: 'large answer' }],
      } },
      { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-large' } },
    ]
    await writeFile(sessionPath, `${filler}\n${tailRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    const fake = installFakeSharedBridge({
      threadReadResults: [{
        thread: {
          id: 'shared-thread',
          path: sessionPath,
          status: { type: 'inProgress' },
          turns: [],
        },
      }],
    })
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/thread-live-state?threadId=shared-thread`)
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        isInProgress?: boolean
        partial?: boolean
        fullHydrationDeferred?: boolean
        hasMoreOlder?: boolean
        thread?: { turns?: Array<{ id?: string }> }
      }
      expect(payload.isInProgress).toBe(true)
      expect(payload.partial).toBe(true)
      expect(payload.fullHydrationDeferred).toBe(true)
      expect(payload.hasMoreOlder).toBe(true)
      expect(payload.thread?.turns).toContainEqual(expect.objectContaining({ id: 'turn-large' }))
      expect(fake.calls.some((call) => call.method === 'thread/read' && (call.params as { includeTurns?: boolean })?.includeTurns === true)).toBe(false)
      expect(fake.calls.some((call) => call.method === 'thread/read' && (call.params as { includeTurns?: boolean })?.includeTurns === false)).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not resume the same thread twice when two clients open it concurrently', async () => {
    const fake = installFakeSharedBridge()
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const endpoint = `http://127.0.0.1:${address.port}/codex-api/rpc`
      const request = () => fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'thread/resume', params: { threadId: 'shared-thread' } }),
      })

      const first = request()
      await Promise.resolve()
      const second = request()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fake.calls.filter((call) => call.method === 'thread/resume')).toHaveLength(1)

      fake.releaseResume()
      const [firstResponse, secondResponse] = await Promise.all([first, second])
      expect(firstResponse.status).toBe(200)
      expect(secondResponse.status).toBe(200)
      expect(fake.calls.map((call) => call.method)).toContain('thread/read')
      expect(fake.calls.filter((call) => call.method === 'thread/resume')).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
    }
  })

  it('does not duplicate resume during turn recovery after the writer is ready', async () => {
    const fake = installFakeSharedBridge({
      blockResume: false,
      failFirstTurnStart: true,
      rejectDuplicateResume: true,
    })
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'turn/start',
          params: { threadId: 'shared-thread', input: [{ type: 'text', text: 'hello' }] },
        }),
      })

      expect(response.status).toBe(200)
      expect(fake.turnStartCalls).toBe(2)
      expect(fake.calls.filter((call) => call.method === 'thread/resume')).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
    }
  })

  it('materializes a read-only thread before a rollback mutation', async () => {
    const fake = installFakeSharedBridge({ blockResume: false })
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'thread/rollback',
          params: { threadId: 'shared-thread', numTurns: 1 },
        }),
      })

      expect(response.status).toBe(200)
      expect(fake.calls.map((call) => call.method)).toEqual(['thread/resume', 'thread/rollback'])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
    }
  })

  it('falls back to a read when another app-server owns the thread writer', async () => {
    const fake = installFakeSharedBridge({ rejectResumeWithActiveWriter: true })
    const instance = createServer()
    const server = await new Promise<Server>((resolve) => {
      const httpServer = createHttpServer(instance.app)
      httpServer.listen(0, '127.0.0.1', () => resolve(httpServer))
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'thread/resume', params: { threadId: 'shared-thread' } }),
      })

      expect(response.status).toBe(200)
      expect(fake.calls.map((call) => call.method)).toEqual(['thread/resume', 'thread/read', 'thread/read'])
      expect((fake.calls[1]?.params as { includeTurns?: boolean })?.includeTurns).toBe(false)
      expect((fake.calls[2]?.params as { includeTurns?: boolean })?.includeTurns).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
    }
  })
})
