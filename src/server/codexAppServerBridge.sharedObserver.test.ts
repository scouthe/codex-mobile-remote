import { afterEach, describe, expect, it } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from './httpServer.js'
import { ThreadSessionBroker } from './threadSessionBroker.js'
import { ThreadSessionActivityReader } from './threadSessionActivity.js'

type RpcCall = { method: string; params: unknown }

function installFakeSharedBridge(options: {
  blockResume?: boolean
  failFirstTurnStart?: boolean
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
    getSessionActivityReader: () => appServer.sessionActivityReader,
    storeThreadReadSnapshot: () => undefined,
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
      expect(fake.calls.map((call) => call.method)).toEqual(['thread/resume', 'thread/read'])
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
      fake.restore()
    }
  })
})
