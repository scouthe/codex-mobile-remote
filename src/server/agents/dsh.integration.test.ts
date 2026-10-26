import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentManager } from './agentManager.js'
import { AgentSessionStore } from './sessionStore.js'
import { AcpConnection } from './acpConnection.js'

it.skipIf(!process.env.CODEXUI_DSH_DISCOVERY_TEST)('discovers installed native sessions read-only, without claiming or creating any session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-dsh-readonly-'))
  const calls: string[] = []
  const manager = new AgentManager(new AgentSessionStore(directory), { transport: handlers => {
    const connection = new AcpConnection(handlers)
    return {
      initialize: () => connection.initialize(),
      async request<T>(method: string, params: unknown, timeout?: number): Promise<T> { calls.push(method); return connection.request<T>(method, params, timeout) },
      notify: (method, params) => connection.notify(method, params),
      dispose: () => connection.dispose(),
    }
  } })
  try {
    const page = await manager.list()
    expect(page.warning).toBe('')
    expect(page.capabilities).toMatchObject({ listSessions: true, resumeSession: true, closeSession: true, loadSession: false })
    expect(new Set(page.sessions.map(row => row.nativeId)).size).toBe(page.sessions.length)
    for (const row of page.sessions) expect(await manager.detail(row.id)).toMatchObject({ attached: false, messages: [], session: { source: 'native', historyUnavailable: true } })
    expect(calls).toEqual(['session/list'])
    console.log('Read-only DSH ACP discovery verified:', { sessions: page.sessions.length, more: !!page.nextCursor, capabilities: page.capabilities })
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 60_000)

it.skipIf(!process.env.CODEXUI_TEST_DSH)('connects to installed DSH, creates, closes and resumes its native session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-real-dsh-'))
  let manager = new AgentManager(new AgentSessionStore(join(directory, 'display')))
  try {
    const detail = await manager.create(directory)
    expect(detail.session.nativeId).toBeTruthy()
    expect(detail.configOptions.some(option => option.category === 'model')).toBe(true)
    expect((await manager.list()).sessions.some(row => row.id === detail.session.id)).toBe(true)
    await manager.dispose()
    manager = new AgentManager(new AgentSessionStore(join(directory, 'display')))
    const resumed = await manager.activate(detail.session.id)
    expect(resumed.session.nativeId).toBe(detail.session.nativeId)
    expect(resumed.configOptions.length).toBeGreaterThan(0)
    console.log('DSH ACP verified:', { models: resumed.configOptions.find(option => option.category === 'model')?.options.map(option => option.label), optionCategories: resumed.configOptions.map(option => option.category), imageInput: resumed.imagesSupported })
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 90_000)

it.skipIf(!process.env.CODEXUI_DSH_LIVE_TEST)('runs native tools and continues the same DSH context after a host-service restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-real-dsh-tools-'))
  let manager = new AgentManager(new AgentSessionStore(join(directory, 'display')))
  const proof = `ACP_PROOF_${Date.now().toString(36)}`
  await writeFile(join(directory, 'ACP_PROOF.txt'), proof)
  async function settle(id: string) {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const detail = await manager.detail(id)
      for (const permission of detail.permissions) {
        const allowed = /ACP_PROOF\.txt|ACP_RESULT\.txt/.test(permission.details)
        const option = permission.options.find(option => option.kind === (allowed ? 'allow_once' : 'reject_once'))
        if (!option) throw new Error('Unexpected native permission options')
        await manager.respond(id, permission.id, option.optionId)
      }
      if (['completed', 'failed', 'interrupted'].includes(detail.session.state)) return detail
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    throw new Error('DSH live tools test timed out')
  }
  try {
    const detail = await manager.create(directory)
    const reasoning = detail.configOptions.find(option => option.category === 'thought_level' && option.options.some(value => value.value === 'off'))
    if (reasoning) await manager.configure(detail.session.id, reasoning.id, 'off')
    await manager.prompt(detail.session.id, { requestId: `live-tools-${Date.now()}`, text: '这是隔离目录内的验收。请用工具读取当前目录的 ACP_PROOF.txt，把原文写入同目录的 ACP_RESULT.txt，最后直接回复文件中的字符串。只操作这两个文件。' })
    const finished = await settle(detail.session.id)
    expect(finished.session.error).toBe('')
    expect(finished.session.state).toBe('completed')
    expect(finished.messages.some(message => message.messageType === 'commandExecution')).toBe(true)
    expect((await readFile(join(directory, 'ACP_RESULT.txt'), 'utf8')).trim()).toBe(proof)
    await manager.dispose()
    manager = new AgentManager(new AgentSessionStore(join(directory, 'display')))
    expect((await manager.detail(detail.session.id)).messages.some(message => message.text.includes(proof))).toBe(true)
    await manager.activate(detail.session.id)
    await manager.prompt(detail.session.id, { requestId: `live-resume-${Date.now()}`, text: '不要调用工具，直接凭之前对话的上下文，回复刚才文件中的完整 ACP_PROOF 字符串。' })
    const continued = await settle(detail.session.id)
    expect(continued.session.error).toBe('')
    expect(continued.messages.filter(message => message.messagePhase === 'final_answer').at(-1)?.text).toContain(proof)
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 300_000)
