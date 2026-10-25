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
      if (method === 'session/new') return { sessionId: 'native-one', configOptions: options } as T
      if (method === 'session/prompt') return new Promise(resolve => { finish = resolve as (value: unknown) => void })
      return { configOptions: options } as T
    },
    notify: vi.fn(async () => { finish?.({ stopReason: 'cancelled' }) }),
    dispose: vi.fn(async () => { finish?.({ stopReason: 'cancelled' }) }),
  }
  const store = new AgentSessionStore(directory)
  const manager = new AgentManager(store, { transport: value => { handlers = value; return transport }, available: async () => true, idleMs: 60_000 })
  cleanups.push(() => manager.dispose())
  return { directory, manager, store, transport, handlers, calls, finish: () => finish?.({ stopReason: 'end_turn' }) }
}

describe('DSH session lifecycle', () => {
  it('keeps a newly created idle session in the list and preserves opaque model values', async () => {
    const { manager, directory, transport } = await setup()
    expect(await manager.list()).toEqual([])
    expect(transport.initialize).not.toHaveBeenCalled()
    const detail = await manager.create(directory)
    expect((await manager.list())[0]?.id).toBe(detail.session.id)
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
