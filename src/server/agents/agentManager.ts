import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ContentBlock, InitializeResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk'
import type { AgentPermission, AgentPromptInput, AgentSession, AgentSessionDetail, AgentSessionView, AgentStatus, AgentUpdate } from '../../types/agent.js'
import { isAgentBusy } from '../../types/agent.js'
import type { UiMessage } from '../../types/codex.js'
import { AcpConnection, type AcpTransport } from './acpConnection.js'
import { normalizeAgentConfigOptions } from './configOptions.js'
import { dshAvailable } from './dshProfile.js'
import { AgentSessionStore } from './sessionStore.js'

export class AgentError extends Error { constructor(message: string, readonly status = 400) { super(message) } }
const text = (value: unknown, limit = 32_000): string => typeof value === 'string' ? value.slice(0, limit) : value === undefined ? '' : JSON.stringify(value).slice(0, limit)

export class AgentManager {
  private readonly transport: AcpTransport
  private readonly listeners = new Set<(update: AgentUpdate) => void>()
  private readonly liveMessages = new Map<string, Map<string, UiMessage>>()
  private readonly owned = new Set<string>()
  private readonly nativeIds = new Map<string, string>()
  private readonly pending = new Map<string, { request: AgentPermission; resolve: (value: RequestPermissionResponse) => void }>()
  private readonly mutations = new Map<string, Promise<unknown>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private initialization?: Promise<void>
  private capabilities?: InitializeResponse
  private connectionReady?: Promise<void>
  private disposed = false
  private updates: Promise<void> = Promise.resolve()
  private readonly runs = new Map<string, Promise<void>>()
  private exiting?: Promise<void>

  constructor(readonly store = new AgentSessionStore(), options: {
    transport?: (handlers: ConstructorParameters<typeof AcpConnection>[0]) => AcpTransport
    available?: () => Promise<boolean>
    idleMs?: number
  } = {}) {
    this.available = options.available || dshAvailable
    this.idleMs = options.idleMs ?? 10 * 60_000
    const handlers = {
      update: (notification: SessionNotification) => {
        this.updates = this.updates.then(() => this.handleUpdate(notification)).catch(error => this.onExit(error instanceof Error ? error : new Error('DSH 更新保存失败。')))
        return this.updates
      },
      permission: (request: RequestPermissionRequest) => this.permission(request),
      exit: (error: Error) => { void this.onExit(error) },
    }
    this.transport = options.transport?.(handlers) || new AcpConnection(handlers)
  }
  private readonly available: () => Promise<boolean>
  private readonly idleMs: number

  private ready(): Promise<void> {
    if (!this.initialization) this.initialization = (async () => {
      await this.store.initialize()
      for (const session of this.store.list()) {
        this.nativeIds.set(session.nativeId, session.id)
        if (isAgentBusy(session.state)) {
          session.state = 'interrupted'; session.error = '服务曾重启，上一任务的结果尚未确认。可查看记录后继续发送新消息。'
          await this.store.save({ ...this.store.get(session.id), session })
        }
      }
    })().catch(error => { this.initialization = undefined; throw error })
    return this.initialization
  }

  private async connect(): Promise<void> {
    await this.exiting
    if (this.disposed) return Promise.reject(new AgentError('DSH 服务正在关闭。', 503))
    if (!this.connectionReady) this.connectionReady = this.transport.initialize().then(result => { this.capabilities = result }).catch(error => { this.connectionReady = undefined; throw error })
    return this.connectionReady
  }

  async status(): Promise<AgentStatus> {
    const available = await this.available()
    return { available, connected: !!this.capabilities, message: available ? '' : '未找到 DSH，请先在这台主机安装并配置 DeepSeek Harness。', imagesSupported: this.capabilities?.agentCapabilities?.promptCapabilities?.image === true }
  }

  async list(): Promise<AgentSession[]> { await this.ready(); return this.store.list().filter(session => !session.archived) }

  async create(cwd: string): Promise<AgentSessionDetail> {
    await this.ready()
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new AgentError('请选择主机上已有的项目目录。')
    await this.connect()
    const result = await this.transport.request<{ sessionId: string; configOptions?: unknown }>('session/new', { cwd, mcpServers: [] })
    if (!result.sessionId) throw new AgentError('DSH 没有返回会话 ID。', 502)
    const now = new Date().toISOString()
    const session: AgentSession = { id: randomUUID(), nativeId: result.sessionId, agentId: 'dsh', title: '新建 DSH 对话', cwd, createdAt: now, updatedAt: now, state: 'idle', error: '', runId: '', lastRequestId: '', revision: 0, archived: false }
    this.owned.add(session.nativeId)
    try { await this.store.save({ session, configOptions: normalizeAgentConfigOptions(result.configOptions) }) }
    catch (error) { this.owned.delete(session.nativeId); await this.transport.request('session/close', { sessionId: session.nativeId }).catch(() => {}); throw error }
    this.nativeIds.set(session.nativeId, session.id)
    this.emit({ session })
    this.scheduleRelease(session)
    return this.detail(session.id)
  }

  async detail(id: string, before?: number): Promise<AgentSessionDetail> {
    await this.ready()
    const record = this.requireSession(id)
    const page = await this.store.page(id, before)
    return { session: { ...record.session }, ...page, configOptions: record.configOptions, permissions: this.permissions(id), imagesSupported: this.capabilities?.agentCapabilities?.promptCapabilities?.image === true }
  }

  async activate(id: string): Promise<AgentSessionView> {
    await this.ready()
    return this.serialize(id, async () => {
      const { session } = this.requireSession(id)
      if (!isAgentBusy(session.state)) {
        await this.resume(session)
        this.scheduleRelease(session)
      }
      const record = this.requireSession(id)
      return { session: { ...session }, configOptions: record.configOptions, permissions: this.permissions(id), imagesSupported: this.capabilities?.agentCapabilities?.promptCapabilities?.image === true }
    })
  }

  async archive(id: string): Promise<void> {
    await this.ready()
    return this.serialize(id, async () => {
      const { session } = this.requireSession(id)
      if (isAgentBusy(session.state)) throw new AgentError('请先停止任务，再归档这条对话。', 409)
      await this.release(session)
      session.archived = true
      await this.change(session)
    })
  }

  private requireSession(id: string) {
    try { return this.store.get(id) } catch { throw new AgentError('DSH 对话不存在。', 404) }
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(id) || Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.mutations.set(id, next)
    void next.finally(() => { if (this.mutations.get(id) === next) this.mutations.delete(id) }).catch(() => {})
    return next
  }

  private async resume(session: AgentSession): Promise<void> {
    await this.connect()
    if (this.owned.has(session.nativeId)) return
    const supported = this.capabilities?.agentCapabilities?.sessionCapabilities?.resume
    if (!supported) throw new AgentError('当前 DSH 版本不支持恢复会话，请升级 DSH；已有显示记录已保留。')
    const response = await this.transport.request<{ configOptions?: unknown }>('session/resume', { sessionId: session.nativeId, cwd: session.cwd, mcpServers: [] })
    this.owned.add(session.nativeId)
    const record = this.requireSession(session.id)
    record.configOptions = normalizeAgentConfigOptions(response.configOptions)
    await this.store.save(record)
    this.emit({ session: record.session, configOptions: record.configOptions })
  }

  async configure(id: string, configId: string, value: string): Promise<AgentSessionDetail> {
    await this.ready()
    return this.serialize(id, async () => {
      const record = this.requireSession(id)
      if (isAgentBusy(record.session.state)) throw new AgentError('请等待当前任务结束后再切换模型或推理强度。', 409)
      await this.resume(record.session)
      const option = record.configOptions.find(option => option.id === configId)
      if (!option?.options.some(item => item.value === value)) throw new AgentError('请选择 DSH 实际提供的配置选项。')
      const result = await this.transport.request<{ configOptions?: unknown }>('session/set_config_option', { sessionId: record.session.nativeId, configId, value })
      record.configOptions = normalizeAgentConfigOptions(result.configOptions)
      await this.change(record.session, { configOptions: record.configOptions })
      this.scheduleRelease(record.session)
      return this.detail(id)
    })
  }

  async prompt(id: string, input: AgentPromptInput): Promise<AgentSession> {
    await this.ready()
    return this.serialize(id, async () => {
      const record = this.requireSession(id), session = record.session
      if (!input.requestId || !/^[\w-]{8,100}$/.test(input.requestId)) throw new AgentError('发送标识无效，请刷新页面后重试。')
      if (session.lastRequestId === input.requestId || session.requestIds?.includes(input.requestId)) return { ...session }
      if (isAgentBusy(session.state)) throw new AgentError('这条 DSH 对话已有任务正在执行。', 409)
      if (!input.text.trim() && !input.images?.length && !input.files?.length) throw new AgentError('请输入消息或添加附件。')
      if (input.text.length > 500_000 || (input.images?.length || 0) > 8 || (input.files?.length || 0) > 20) throw new AgentError('消息或附件过多，请分批发送。')
      clearTimeout(this.timers.get(id))
      session.runId = randomUUID(); session.lastRequestId = input.requestId; session.state = 'starting'; session.error = ''
      session.requestIds = [...(session.requestIds || []), input.requestId].slice(-100)
      session.turnCount = (session.turnCount || 0) + 1
      if (session.title === '新建 DSH 对话') session.title = input.text.trim().split('\n')[0]?.slice(0, 60) || '附件对话'
      const runId = session.runId
      try {
        await this.change(session)
        await this.message(session, { id: `user-${input.requestId}`, role: 'user', text: input.text, turnId: runId,
          images: input.images?.map(item => `/codex-local-image?path=${encodeURIComponent(item.path)}`),
          fileAttachments: input.files?.map(item => ({ label: item.name, path: item.path })), messageType: 'userMessage' })
      } catch (error) {
        // This path never submitted a native prompt, so the same request may
        // be retried. Its user message id stays stable if append succeeded.
        session.requestIds = session.requestIds?.filter(id => id !== input.requestId)
        session.lastRequestId = session.requestIds?.at(-1) || ''
        session.turnCount = Math.max(0, (session.turnCount || 1) - 1)
        session.state = 'failed'; session.error = '任务记录保存失败，消息尚未提交给 DSH。'
        await this.change(session).catch(() => {}); throw error
      }
      const run = this.run(session, runId, input)
      this.runs.set(runId, run)
      void run.finally(() => this.runs.delete(runId)).catch(() => {})
      return { ...session }
    })
  }

  private async content(input: AgentPromptInput): Promise<ContentBlock[]> {
    const content: ContentBlock[] = input.text ? [{ type: 'text', text: input.text }] : []
    for (const image of input.images || []) {
      if (!isAbsolute(image.path) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)) throw new AgentError('DSH 支持 PNG、JPEG、WebP 和 GIF 图片。')
      if (!this.capabilities?.agentCapabilities?.promptCapabilities?.image) throw new AgentError('当前 DSH 路由未声明图片输入能力，请选择支持图片的配置后重新连接。')
      if ((await stat(image.path)).size > 10 * 1024 * 1024) throw new AgentError('单张图片不能超过 10 MB。')
      content.push({ type: 'image', mimeType: image.mimeType, data: (await readFile(image.path)).toString('base64') })
    }
    for (const file of input.files || []) {
      if (!isAbsolute(file.path) || !(await stat(file.path)).isFile()) throw new AgentError('附件文件不存在。')
      content.push({ type: 'resource_link', uri: pathToFileURL(file.path).href, name: file.name })
    }
    return content
  }

  private async run(session: AgentSession, runId: string, input: AgentPromptInput): Promise<void> {
    try {
      await this.resume(session)
      const prompt = await this.content(input)
      if (session.state === 'stopping') { session.state = 'interrupted'; await this.change(session); return }
      session.state = 'running'; await this.change(session)
      const result = await this.transport.request<{ stopReason: string }>('session/prompt', { sessionId: session.nativeId, prompt }, 0)
      await this.updates
      if (session.runId !== runId) return
      const lastReply = Array.from(this.liveMessages.get(session.id)?.values() || []).reverse().find(message => message.id.endsWith('-agent_message_chunk'))
      if (lastReply && result.stopReason !== 'cancelled') await this.message(session, { ...lastReply, messagePhase: 'final_answer', turnStatus: 'completed' })
      session.state = result.stopReason === 'cancelled' || (session.state as string) === 'stopping' ? 'interrupted' : 'completed'
      if (result.stopReason === 'max_tokens') session.error = '本轮达到输出上限，可以继续发送消息。'
      await this.change(session)
    } catch (error) {
      if (session.runId !== runId || session.state === 'interrupted') return
      session.state = session.state === 'stopping' ? 'interrupted' : 'failed'
      session.error = error instanceof Error ? error.message.slice(0, 1200) : 'DSH 请求失败。'
      await this.change(session).catch(() => {})
    } finally {
      if (session.runId === runId) {
        this.cancelPermissions(session.id)
        this.liveMessages.delete(session.id)
        this.scheduleRelease(session)
      }
    }
  }

  async stop(id: string): Promise<AgentSession> {
    await this.ready()
    const { session } = this.requireSession(id)
    if (!isAgentBusy(session.state)) return { ...session }
    session.state = 'stopping'; await this.change(session)
    this.cancelPermissions(id)
    if (this.owned.has(session.nativeId)) await this.transport.notify('session/cancel', { sessionId: session.nativeId })
    return { ...session }
  }

  private permissions(id: string): AgentPermission[] { return Array.from(this.pending.values()).filter(p => p.request.sessionId === id).map(p => p.request) }

  private async permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const id = this.nativeIds.get(params.sessionId)
    if (!id) return { outcome: { outcome: 'cancelled' } }
    const { session } = this.requireSession(id)
    if (!isAgentBusy(session.state) || session.state === 'stopping' || this.disposed) return { outcome: { outcome: 'cancelled' } }
    const request: AgentPermission = { id: randomUUID(), sessionId: session.id, title: params.toolCall.title || 'DSH 请求执行操作', details: text(params.toolCall.rawInput, 8000), options: params.options.map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind })) }
    return new Promise(resolve => {
      this.pending.set(request.id, { request, resolve })
      session.state = 'waiting_approval'
      void this.change(session, { permissions: this.permissions(session.id) }).catch(() => { this.pending.delete(request.id); resolve({ outcome: { outcome: 'cancelled' } }) })
    })
  }

  async respond(id: string, permissionId: string, optionId: string): Promise<void> {
    const item = this.pending.get(permissionId)
    if (!item || item.request.sessionId !== id) throw new AgentError('该审批已结束，请刷新任务状态。', 409)
    if (!item.request.options.some(option => option.optionId === optionId)) throw new AgentError('审批选项无效。')
    this.pending.delete(permissionId)
    const { session } = this.requireSession(id)
    session.state = this.permissions(id).length ? 'waiting_approval' : 'running'
    try {
      await this.change(session, { permissions: this.permissions(id) })
      item.resolve({ outcome: { outcome: 'selected', optionId } })
    } catch (error) {
      item.resolve({ outcome: { outcome: 'cancelled' } })
      throw error
    }
  }

  private cancelPermissions(id: string) {
    for (const [key, item] of this.pending) if (item.request.sessionId === id) { this.pending.delete(key); item.resolve({ outcome: { outcome: 'cancelled' } }) }
    this.emit({ session: { ...this.requireSession(id).session }, permissions: [] })
  }

  private async handleUpdate(params: SessionNotification): Promise<void> {
    const id = this.nativeIds.get(params.sessionId)
    if (!id || !this.owned.has(params.sessionId)) return
    const { session } = this.requireSession(id)
    const update = params.update as unknown as Record<string, unknown>
    const kind = update.sessionUpdate
    if (kind === 'config_option_update') {
      const record = this.requireSession(session.id)
      record.configOptions = normalizeAgentConfigOptions(update.configOptions)
      await this.change(session, { configOptions: record.configOptions }); return
    }
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = update.content as { type?: string; text?: string; data?: string; mimeType?: string }
      if (content.type !== 'text' || !content.text) return
      const id = `${session.runId}-${String(update.messageId || 'assistant')}-${kind}`
      const current = this.liveMessages.get(session.id)?.get(id)
      await this.message(session, { id, role: 'assistant', text: (current?.text || '') + content.text, turnId: session.runId, messageType: 'agentMessage', messagePhase: 'commentary' })
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = `${session.runId}-tool-${String(update.toolCallId)}`
      const current = this.liveMessages.get(session.id)?.get(id)
      const output = Array.isArray(update.content) ? update.content.map(item => { const block = item as { content?: { text?: string }; type?: string }; return block.content?.text || text(item, 4000) }).join('\n') : ''
      const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'inProgress'
      await this.message(session, { id, role: 'system', text: '', turnId: session.runId, messageType: 'commandExecution', commandExecution: { command: text(update.title || current?.commandExecution?.command || '工具操作', 300), cwd: session.cwd, status, aggregatedOutput: text(output || current?.commandExecution?.aggregatedOutput || update.rawOutput || update.rawInput), exitCode: null } })
    }
  }

  private async message(session: AgentSession, message: UiMessage): Promise<void> {
    message = { turnIndex: Math.max(0, (session.turnCount || 1) - 1), ...message }
    const messages = this.liveMessages.get(session.id) || new Map<string, UiMessage>()
    messages.set(message.id, message); this.liveMessages.set(session.id, messages)
    while (messages.size > 200) messages.delete(messages.keys().next().value!)
    session.revision++; session.updatedAt = new Date().toISOString()
    await this.store.message(session.id, { seq: session.revision, message })
    await this.store.save(this.requireSession(session.id))
    this.emit({ session: { ...session }, message })
  }

  private async change(session: AgentSession, extra: Omit<AgentUpdate, 'session'> = {}): Promise<void> {
    session.revision++; session.updatedAt = new Date().toISOString()
    await this.store.save(this.requireSession(session.id))
    this.emit({ session: { ...session }, ...extra })
  }

  private emit(update: AgentUpdate): void {
    for (const listener of this.listeners) {
      try { listener(update) } catch { /* a disconnected subscriber cannot fail a task */ }
    }
  }
  subscribe(listener: (update: AgentUpdate) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  private scheduleRelease(session: AgentSession): void {
    clearTimeout(this.timers.get(session.id))
    if (this.disposed || isAgentBusy(session.state)) return
    const timer = setTimeout(() => { void this.serialize(session.id, () => this.release(session)).catch(() => {}) }, this.idleMs)
    timer.unref(); this.timers.set(session.id, timer)
  }

  private async release(session: AgentSession): Promise<void> {
    if (isAgentBusy(session.state) || !this.owned.has(session.nativeId)) return
    await this.transport.request('session/close', { sessionId: session.nativeId }, 30_000)
    this.owned.delete(session.nativeId)
  }

  private onExit(error: Error): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.exiting) return this.exiting
    this.exiting = this.recoverExit(error).finally(() => { this.exiting = undefined })
    return this.exiting
  }

  private async recoverExit(error: Error): Promise<void> {
    this.capabilities = undefined; this.connectionReady = undefined; this.owned.clear()
    for (const summary of this.store.list()) {
      this.cancelPermissions(summary.id)
      const { session } = this.requireSession(summary.id)
      if (isAgentBusy(session.state)) { session.state = 'interrupted'; session.error = error.message; await this.change(session).catch(() => {}) }
    }
    await this.transport.dispose()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.initialization?.catch(() => {})
    await Promise.allSettled(this.mutations.values())
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const session of this.store.list()) this.cancelPermissions(session.id)
    await this.transport.dispose()
    await Promise.allSettled(this.runs.values())
    await this.updates.catch(() => {})
    await this.store.dispose()
  }
}
