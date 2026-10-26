import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InitializeResponse, RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk'
import { AgentManager } from './agentManager.js'
import { AgentSessionStore } from './sessionStore.js'
import type { AcpConnection, AcpTransport } from './acpConnection.js'

const capabilities: InitializeResponse = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, close: {}, list: {} }, promptCapabilities: { image: true } } }
const options = [{ id: 'model', name: '模型', type: 'select', category: 'model', currentValue: 'provider/model', options: [{ group: 'provider', name: 'Provider', options: [{ value: 'provider/model', name: '真实模型' }] }] }]

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-agent-test-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  let handlers!: ConstructorParameters<typeof AcpConnection>[0]
  let finish: ((value: unknown) => void) | undefined
  const calls: string[] = []
  const transport: AcpTransport = {
    initialize: vi.fn(async () => capabilities),
    async request<T>(method: string): Promise<T> {
      calls.push(method)
      if (method === 'session/list') return { sessions: [] } as T
      if (method === 'session/new') return { sessionId: 'native-one', configOptions: options } as T
      if (method === 'session/prompt') return new Promise(resolve => { finish = resolve as (value: unknown) => void })
      return { configOptions: options } as T
    },
    notify: vi.fn(async () => { finish?.({ stopReason: 'cancelled' }) }),
    dispose: vi.fn(async () => { finish?.({ stopReason: 'cancelled' }) }),
  }
  const store = new AgentSessionStore(directory)
  const manager = new AgentManager(store, { transport: value => { handlers = value; return transport }, available: async () => true, idleMs: 60_000, mcpServers: async () => [] })
  cleanups.push(() => manager.dispose())
  return { directory, manager, store, transport, handlers, calls, finish: (stopReason = 'end_turn') => finish?.({ stopReason }) }
}

describe('DSH session lifecycle', () => {
  it('keeps a newly created idle session in the list and preserves opaque model values', async () => {
    const { manager, directory, transport } = await setup()
    expect((await manager.list()).sessions).toEqual([])
    expect(transport.initialize).toHaveBeenCalledTimes(1)
    const detail = await manager.create(directory)
    expect((await manager.list()).sessions[0]?.id).toBe(detail.session.id)
    expect(detail.configOptions[0]?.options).toEqual([{ value: 'provider/model', label: '真实模型' }])
  })

  it('admits a request once, persists semantic updates and stops without replaying the prompt', async () => {
    const test = await setup(), { manager, directory, handlers, calls } = test
    const { session } = await manager.create(directory)
    const input = { requestId: 'request-first-one', text: '记住这个测试' }
    await Promise.all([manager.prompt(session.id, input), manager.prompt(session.id, input)])
    await expect.poll(() => calls.filter(call => call === 'session/prompt').length).toBe(1)
    await handlers.update({ sessionId: 'native-one', update: { sessionUpdate: 'agent_message_chunk', messageId: 'reply', content: { type: 'text', text: '测试结果' } } } as SessionNotification)
    expect((await manager.detail(session.id)).messages.map(message => message.text)).toEqual(['记住这个测试', '测试结果'])
    await manager.stop(session.id)
    await expect.poll(async () => (await manager.detail(session.id)).session.state).toBe('interrupted')
    expect(calls.filter(call => call === 'session/prompt')).toHaveLength(1)
  })

  it('makes launch failure terminal instead of leaving a loading task', async () => {
    const { manager, directory, transport } = await setup()
    const { session } = await manager.create(directory)
    await manager.dispose()
    const replacement = new AgentManager(new AgentSessionStore(directory), { transport: () => ({ ...transport, initialize: async () => { throw new Error('启动失败') } }) })
    cleanups.push(() => replacement.dispose())
    await replacement.prompt(session.id, { requestId: 'request-fail-one', text: '继续' })
    await expect.poll(async () => (await replacement.detail(session.id)).session.state).toBe('failed')
    expect((await replacement.detail(session.id)).session.error).toBe('启动失败')
  })

  it('keeps a token-limited answer visible as the final response', async () => {
    const test = await setup()
    const { session } = await test.manager.create(test.directory)
    await test.manager.prompt(session.id, { requestId: 'request-token-limit', text: '输出内容' })
    await expect.poll(() => test.calls.includes('session/prompt')).toBe(true)
    await test.handlers.update({ sessionId: 'native-one', update: { sessionUpdate: 'agent_message_chunk', messageId: 'limited', content: { type: 'text', text: '已生成的部分结果' } } } as SessionNotification)
    test.finish('max_tokens')
    await expect.poll(async () => (await test.manager.detail(session.id)).session.state).toBe('completed')
    const detail = await test.manager.detail(session.id)
    expect(detail.messages.at(-1)?.messagePhase).toBe('final_answer')
    expect(detail.session.error).toContain('输出上限')
  })

  it('can retry an admission write failure without duplicate native prompts or user messages', async () => {
    const { manager, directory, store, calls } = await setup()
    const { session } = await manager.create(directory)
    const input = { requestId: 'request-disk-retry', text: '这是一条可重试消息' }
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'))
    await expect(manager.prompt(session.id, input)).rejects.toThrow('disk full')
    expect(calls.includes('session/prompt')).toBe(false)
    await manager.prompt(session.id, input)
    await expect.poll(() => calls.filter(call => call === 'session/prompt').length).toBe(1)
    expect((await manager.detail(session.id)).messages.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('approves exact ACP option IDs and cancels approvals if persistence fails', async () => {
    const { manager, directory, handlers, calls, store } = await setup()
    const { session } = await manager.create(directory)
    await manager.prompt(session.id, { requestId: 'request-approval-one', text: '检查文件' })
    await expect.poll(() => calls.includes('session/prompt')).toBe(true)
    const request: RequestPermissionRequest = { sessionId: 'native-one', toolCall: { toolCallId: 'tool', title: '写入文件' }, options: [{ optionId: 'allow-once-opaque', name: '仅本次允许', kind: 'allow_once' }] }
    const response = handlers.permission(request)
    await expect.poll(async () => (await manager.detail(session.id)).session.state).toBe('waiting_approval')
    const permission = (await manager.detail(session.id)).permissions[0]!
    await manager.respond(session.id, permission.id, 'allow-once-opaque')
    expect(await response).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once-opaque' } })
    const next = handlers.permission(request)
    await expect.poll(async () => (await manager.detail(session.id)).permissions.length).toBe(1)
    const second = (await manager.detail(session.id)).permissions[0]!
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'))
    await expect(manager.respond(session.id, second.id, 'allow-once-opaque')).rejects.toThrow('disk full')
    expect(await next).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('marks interrupted tasks after restart and resumes the native session only on demand', async () => {
    const test = await setup(), { manager, directory, store, transport, calls } = test
    const { session } = await manager.create(directory)
    const record = store.get(session.id)
    record.session.state = 'running'
    await store.save(record)
    await manager.dispose()
    calls.length = 0
    const next = new AgentManager(new AgentSessionStore(directory), { transport: () => transport })
    cleanups.push(() => next.dispose())
    expect((await next.detail(session.id)).session.state).toBe('interrupted')
    expect(calls).toEqual([])
    await next.activate(session.id)
    expect(calls).toEqual(['session/resume'])
  })
})

describe('ACP native session discovery', () => {
  it('imports paginated native IDs once, keeps managed sessions, and resumes the original native ID', async () => {
    const test = await setup()
    const managed = await test.manager.create(test.directory)
    const original = test.transport.request.bind(test.transport)
    const request = vi.spyOn(test.transport, 'request').mockImplementation(async (method, params) => {
      if (method !== 'session/list') return original(method, params)
      return (params as { cursor?: string }).cursor
        ? { sessions: [{ sessionId: 'native-second-page', cwd: test.directory }], nextCursor: null }
        : { sessions: [{ sessionId: 'native-one', cwd: test.directory }, { sessionId: 'session-original-web', cwd: test.directory }, { sessionId: 'session-original-web', cwd: test.directory }], nextCursor: 'opaque-next' }
    })
    const first = await test.manager.list()
    expect(first.nextCursor).toBe('opaque-next')
    expect(first.sessions.filter(row => row.nativeId === 'native-one').map(row => row.id)).toEqual([managed.session.id])
    const imported = first.sessions.find(row => row.nativeId === 'session-original-web')!
    expect(imported).toMatchObject({ source: 'native', historyUnavailable: true, state: 'idle' })
    expect(imported.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(first.sessions).toHaveLength(2)
    expect(first.capabilities).toMatchObject({ listSessions: true, resumeSession: true, closeSession: true, loadSession: false })
    expect((await test.manager.detail(imported.id)).messages).toEqual([])
    expect(request.mock.calls.some(([method]) => method === 'session/resume' || method === 'session/load' || method === 'session/prompt')).toBe(false)
    const second = await test.manager.list({ cursor: first.nextCursor! })
    expect(second.nextCursor).toBeNull()
    expect(second.sessions.map(row => row.nativeId)).toEqual(['native-second-page'])
    await test.manager.activate(imported.id)
    expect(request).toHaveBeenCalledWith('session/resume', { sessionId: 'session-original-web', cwd: test.directory, mcpServers: [] })
    expect((await test.manager.detail(imported.id)).attached).toBe(true)
    await test.manager.close(imported.id)
    expect(request).toHaveBeenCalledWith('session/close', { sessionId: 'session-original-web' }, 30_000)
    expect((await test.manager.detail(imported.id)).attached).toBe(false)
    await test.manager.dispose()
    const next = new AgentManager(new AgentSessionStore(test.directory), { transport: () => test.transport, available: async () => true })
    cleanups.push(() => next.dispose())
    expect((await next.list()).sessions.find(row => row.nativeId === imported.nativeId)?.id).toBe(imported.id)
  })

  it('coalesces and briefly caches discovery, and bypasses the cache for an explicit refresh', async () => {
    const test = await setup()
    const request = vi.spyOn(test.transport, 'request').mockResolvedValue({ sessions: [] })
    await Promise.all(Array.from({ length: 12 }, () => test.manager.list()))
    expect(request).toHaveBeenCalledTimes(1)
    await test.manager.list()
    expect(request).toHaveBeenCalledTimes(1)
    await test.manager.list({ refresh: true })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('expires discovery ten seconds after the native read, even with frequent cache hits', async () => {
    const test = await setup()
    const clock = vi.spyOn(Date, 'now')
    const request = vi.spyOn(test.transport, 'request').mockResolvedValue({ sessions: [] })
    try {
      clock.mockReturnValue(1000); await test.manager.list()
      clock.mockReturnValue(9000); await test.manager.list()
      expect(request).toHaveBeenCalledTimes(1)
      clock.mockReturnValue(11001); await test.manager.list()
      expect(request).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
  })

  it('persists valid usage updates without adding transcript messages', async () => {
    const test = await setup()
    const { session } = await test.manager.create(test.directory)
    await test.handlers.update({ sessionId: session.nativeId, update: { sessionUpdate: 'usage_update', used: 1200, size: 128000 } } as SessionNotification)
    expect((await test.manager.detail(session.id)).session.usage).toEqual({ used: 1200, size: 128000 })
    await test.handlers.update({ sessionId: session.nativeId, update: { sessionUpdate: 'usage_update', used: -1, size: 0 } } as SessionNotification)
    const detail = await test.manager.detail(session.id)
    expect(detail.session.usage).toEqual({ used: 1200, size: 128000 })
    expect(detail.messages).toEqual([])
  })

  it('passes host MCP declarations to create/resume and rejects undeclared remote transports', async () => {
    const test = await setup()
    vi.spyOn(test.transport, 'initialize').mockResolvedValue({ ...capabilities, agentCapabilities: { ...capabilities.agentCapabilities, mcpCapabilities: { http: true } } })
    const request = vi.spyOn(test.transport, 'request')
    const mcpServers = [{ name: 'local', command: '/usr/bin/node', args: ['mcp.cjs'], env: [] }, { name: 'remote', type: 'http' as const, url: 'http://localhost:3000/mcp', headers: [] }]
    const manager = new AgentManager(new AgentSessionStore(join(test.directory, 'mcp-display')), { transport: () => test.transport, mcpServers: async () => mcpServers })
    cleanups.push(() => manager.dispose())
    const { session } = await manager.create(test.directory)
    expect(request).toHaveBeenCalledWith('session/new', { cwd: test.directory, mcpServers })
    await manager.close(session.id)
    await manager.activate(session.id)
    expect(request).toHaveBeenCalledWith('session/resume', { cwd: test.directory, sessionId: session.nativeId, mcpServers })
    const unsupported = new AgentManager(new AgentSessionStore(join(test.directory, 'unsupported-mcp')), { transport: () => test.transport, mcpServers: async () => [{ name: 'old', type: 'sse', url: 'http://localhost:3001', headers: [] }] })
    cleanups.push(() => unsupported.dispose())
    await expect(unsupported.create(test.directory)).rejects.toThrow('未声明')
  })

  it('closes a busy session and cancels pending approvals without deleting its display history', async () => {
    const test = await setup()
    const { session } = await test.manager.create(test.directory)
    await test.manager.prompt(session.id, { requestId: 'request-close-busy', text: '保留这条消息' })
    await expect.poll(() => test.calls.includes('session/prompt')).toBe(true)
    const approval = test.handlers.permission({ sessionId: session.nativeId, toolCall: { toolCallId: 'one', title: '确认' }, options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }] })
    await expect.poll(async () => (await test.manager.detail(session.id)).permissions.length).toBe(1)
    const before = (await test.manager.detail(session.id)).session.revision
    await test.manager.close(session.id)
    expect(await approval).toEqual({ outcome: { outcome: 'cancelled' } })
    const detail = await test.manager.detail(session.id)
    expect(detail).toMatchObject({ attached: false, permissions: [], session: { state: 'interrupted', archived: false } })
    expect(detail.session.revision).toBeGreaterThan(before)
    expect(detail.messages.map(row => row.text)).toEqual(['保留这条消息'])
    test.finish('end_turn')
    await test.manager.dispose()
    expect((await test.manager.detail(session.id)).session.state).toBe('interrupted')
  })

  it('revises idle attachment state on process exit so a delayed read cannot restore a closed connection', async () => {
    const test = await setup()
    const before = await test.manager.create(test.directory)
    expect(before.attached).toBe(true)
    test.handlers.exit(new Error('test disconnected'))
    await expect.poll(async () => (await test.manager.detail(before.session.id)).session.revision).toBeGreaterThan(before.session.revision)
    expect((await test.manager.detail(before.session.id)).attached).toBe(false)
  })

  it('keeps saved sessions usable after discovery fails, and retries a failed page', async () => {
    const test = await setup()
    const { session } = await test.manager.create(test.directory)
    const request = vi.spyOn(test.transport, 'request').mockRejectedValueOnce(new Error('native list offline')).mockResolvedValue({ sessions: [] })
    const failed = await test.manager.list()
    expect(failed.sessions.map(row => row.id)).toEqual([session.id])
    expect(failed.warning).toContain('native list offline')
    expect((await test.manager.detail(session.id)).session.id).toBe(session.id)
    expect((await test.manager.list()).warning).toBe('')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('honors capability negotiation and does not call unsupported lifecycle methods', async () => {
    const test = await setup()
    vi.spyOn(test.transport, 'initialize').mockResolvedValue({ protocolVersion: 1, agentCapabilities: {} })
    const page = await test.manager.list()
    expect(page.capabilities?.listSessions).toBe(false)
    expect(test.calls).toEqual([])
    const { session } = await test.manager.create(test.directory)
    await expect(test.manager.close(session.id)).rejects.toThrow('不支持')
    expect(test.calls).not.toContain('session/close')
  })

  it('keeps a locally archived native row hidden without deleting the original session', async () => {
    const test = await setup()
    const request = vi.spyOn(test.transport, 'request').mockResolvedValue({ sessions: [{ sessionId: 'native-archived', cwd: test.directory }] })
    const imported = (await test.manager.list()).sessions[0]!
    await test.manager.archive(imported.id)
    expect((await test.manager.list({ refresh: true })).sessions).toEqual([])
    expect(request.mock.calls.some(([method]) => method === 'session/delete' || method === 'session/close')).toBe(false)
  })
})
