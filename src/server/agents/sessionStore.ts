import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentConfigOption, AgentSession } from '../../types/agent.js'
import type { UiMessage } from '../../types/codex.js'
import { agentDataHome } from './dshProfile.js'

export type SessionRecord = { session: AgentSession; configOptions: AgentConfigOption[] }
type MessageRecord = { seq: number; message: UiMessage }

/** Append-only display projection. DSH continues to own its native conversation. */
export class AgentSessionStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly writes = new Map<string, Promise<void>>()
  private init?: Promise<void>
  private ownsLock = false
  private disposed = false
  readonly owner = `${process.pid}-${randomUUID()}`

  constructor(readonly directory = agentDataHome()) {}

  initialize(): Promise<void> {
    if (!this.init) this.init = this.load().catch(async error => {
      await this.releaseLock(); this.sessions.clear(); this.init = undefined; throw error
    })
    return this.init
  }

  private async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const lockPath = join(this.directory, 'owner.json')
    try { await writeFile(lockPath, JSON.stringify({ owner: this.owner, pid: process.pid }), { flag: 'wx', mode: 0o600 }); this.ownsLock = true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const old = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number }
      let alive = true
      try { process.kill(old.pid, 0) } catch (err) { alive = (err as NodeJS.ErrnoException).code !== 'ESRCH' }
      if (alive) throw new Error('另一个 Codex Remote 服务正在管理 DSH 会话；测试实例请设置独立 CODEXUI_AGENT_HOME。')
      await unlink(lockPath)
      await writeFile(lockPath, JSON.stringify({ owner: this.owner, pid: process.pid }), { flag: 'wx', mode: 0o600 }); this.ownsLock = true
    }
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const record = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as SessionRecord
      if (record.session?.id !== name.slice(0, -5) || !record.session.nativeId || !Array.isArray(record.configOptions)) throw new Error('DSH 展示记录无效，请检查会话存储。')
      this.sessions.set(record.session.id, record)
    }
  }

  list(): AgentSession[] { return Array.from(this.sessions.values()).map(r => ({ ...r.session })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }
  get(id: string): SessionRecord {
    const record = this.sessions.get(id)
    if (!record) throw new Error('DSH 对话不存在。')
    return record
  }

  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('DSH 会话存储已关闭。'))
    const previous = this.writes.get(id) || Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.writes.set(id, next)
    void next.finally(() => { if (this.writes.get(id) === next) this.writes.delete(id) }).catch(() => {})
    return next
  }

  async save(record: SessionRecord): Promise<void> {
    this.sessions.set(record.session.id, record)
    const serialized = JSON.stringify(record)
    await this.enqueue(record.session.id, async () => {
      const target = join(this.directory, `${record.session.id}.json`)
      const temp = `${target}.${this.owner}.tmp`
      await writeFile(temp, serialized + '\n', { mode: 0o600 })
      await rename(temp, target)
    })
  }

  async message(id: string, entry: MessageRecord): Promise<void> {
    await this.enqueue(id, async () => {
      const file = await open(join(this.directory, `${id}.jsonl`), 'a', 0o600)
      try { await file.writeFile(JSON.stringify(entry) + '\n'); await file.sync() }
      finally { await file.close() }
    })
  }

  /** Read backwards only until a page is filled, without parsing the whole transcript. */
  async page(id: string, before = Number.MAX_SAFE_INTEGER, limit = 50): Promise<{ messages: UiMessage[]; nextCursor: number | null }> {
    this.get(id)
    await this.writes.get(id)
    let file
    try { file = await open(join(this.directory, `${id}.jsonl`), 'r') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { messages: [], nextCursor: null }; throw error }
    try {
      let position = (await file.stat()).size
      let tail = Buffer.alloc(0), oldest = before
      const found = new Map<string, UiMessage>()
      let hasMore = false
      while (position > 0) {
        const length = Math.min(position, 64 * 1024)
        position -= length
        const chunk = Buffer.alloc(length)
        await file.read(chunk, 0, length, position)
        const combined = Buffer.concat([chunk, tail])
        const firstNewline = combined.indexOf(10)
        if (firstNewline < 0 && position > 0) {
          if (combined.length > 16 * 1024 * 1024) throw new Error('DSH 历史记录单条消息超过读取上限。')
          tail = combined; continue
        }
        const start = position === 0 ? 0 : firstNewline + 1
        const lines = combined.subarray(start).toString('utf8').split('\n')
        tail = combined.subarray(0, start === 0 ? 0 : firstNewline)
        for (let index = lines.length - 1; index >= 0; index--) {
          const line = lines[index]!.trim()
          if (!line) continue
          const entry = JSON.parse(line) as MessageRecord
          if (entry.seq >= before) continue
          if (found.size >= limit && !found.has(entry.message.id)) { hasMore = true; break }
          oldest = Math.min(oldest, entry.seq)
          if (!found.has(entry.message.id)) found.set(entry.message.id, entry.message)
        }
        if (hasMore) break
      }
      return { messages: Array.from(found.values()).reverse(), nextCursor: hasMore ? oldest : null }
    } finally { await file.close() }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled(this.writes.values())
    await this.releaseLock()
  }

  private async releaseLock(): Promise<void> {
    if (this.ownsLock) {
      const path = join(this.directory, 'owner.json')
      try { const current = JSON.parse(await readFile(path, 'utf8')); if (current.owner === this.owner) await unlink(path) } catch { /* another owner may already have recovered the lock */ }
      this.ownsLock = false
    }
  }
}
