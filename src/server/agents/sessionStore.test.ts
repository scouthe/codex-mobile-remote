import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentSessionStore } from './sessionStore.js'
import type { AgentSession } from '../../types/agent.js'

describe('agent durable display store', () => {
  it('reads history backwards in pages and reloads metadata without replaying prompts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-agent-store-'))
    let store = new AgentSessionStore(directory)
    try {
      await store.initialize()
      const now = new Date().toISOString()
      const session: AgentSession = { id: randomUUID(), nativeId: 'native-id', agentId: 'dsh', cwd: directory, title: '测试', state: 'idle', error: '', runId: '', lastRequestId: '', createdAt: now, updatedAt: now, revision: 125, archived: false }
      await store.save({ session, configOptions: [] })
      for (let seq = 1; seq <= 125; seq++) await store.message(session.id, { seq, message: { id: `message-${seq}`, role: 'assistant', text: `内容-${seq}-${'多字节文本'.repeat(seq === 1 ? 30_000 : 300)}` } })
      const page1 = await store.page(session.id)
      expect(page1.messages).toHaveLength(50)
      expect(page1.messages[0]?.id).toBe('message-76')
      const page2 = await store.page(session.id, page1.nextCursor!)
      expect(page2.messages.map(message => message.id)).toEqual(Array.from({ length: 50 }, (_, index) => `message-${index + 26}`))
      const page3 = await store.page(session.id, page2.nextCursor!)
      expect(page3.messages).toHaveLength(25)
      expect(page3.nextCursor).toBeNull()
      await appendFile(join(directory, `${session.id}.jsonl`), '{"seq":126,"message":')
      expect((await store.page(session.id)).messages).toEqual(page1.messages)
      await store.dispose()
      store = new AgentSessionStore(directory)
      await store.initialize()
      expect(store.list()[0]?.title).toBe('测试')
      expect((await store.page(session.id)).messages).toEqual(page1.messages)
      await store.message(session.id, { seq: 126, message: { id: 'recovered', role: 'assistant', text: '恢复后可继续追加' } })
      expect((await store.page(session.id)).messages.at(-1)?.id).toBe('recovered')
    } finally { await store.dispose(); await rm(directory, { recursive: true, force: true }) }
  })

  it('blocks a second manager and releases its own lock after a failed load', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-agent-lock-'))
    const first = new AgentSessionStore(directory), second = new AgentSessionStore(directory)
    try {
      await first.initialize()
      await expect(second.initialize()).rejects.toThrow('另一个')
      await second.dispose()
      await first.dispose()
      const badPath = join(directory, `${randomUUID()}.json`)
      await writeFile(badPath, '{}')
      const failed = new AgentSessionStore(directory)
      await expect(failed.initialize()).rejects.toThrow('记录无效')
      await rm(badPath)
      const recovered = new AgentSessionStore(directory)
      await recovered.initialize()
      await recovered.dispose()
    } finally { await first.dispose(); await second.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
})
