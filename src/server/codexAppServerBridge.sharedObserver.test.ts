import { afterEach, describe, expect, it } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer } from './httpServer.js'
import { ThreadSessionBroker } from './threadSessionBroker.js'

type RpcCall = { method: string; params: unknown }

function installFakeSharedBridge(options: {
  blockResume?: boolean
  failFirstTurnStart?: boolean
  rejectDuplicateResume?: boolean
  rejectResumeWithActiveWriter?: boolean
} = {}) {
  const globalScope = globalThis as typeof globalThis & { __codexRemoteSharedBridge__?: unknown }
  const previous = globalScope.__codexRemoteSharedBridge__
  const calls: RpcCall[] = []
  let releaseResume!: () => void
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve
  })
  let turnStartCalls = 0
  let generation = 1
  const appServer = {
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
        return { thread: { id: 'shared-thread', turns: [] } }
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
    getStreamEventsSince: () => ({ events: [], truncated: false }),
    getProcessGeneration: () => generation,
    storeThreadReadSnapshot: () => undefined,
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
