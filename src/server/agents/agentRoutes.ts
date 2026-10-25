import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { AgentError, AgentManager } from './agentManager.js'

const promptSchema = z.object({
  requestId: z.string().regex(/^[\w-]{8,100}$/), text: z.string().max(500_000),
  images: z.array(z.object({ path: z.string().max(4096), mimeType: z.string().max(100) })).max(8).optional(),
  files: z.array(z.object({ path: z.string().max(4096), name: z.string().max(500) })).max(20).optional(),
})

function trustedOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  if (!req.headers.origin) return true
  try { return new URL(req.headers.origin).host === req.headers.host } catch { return false }
}

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const clean = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted) }
    const failed = (error: Error) => { clean(); reject(error) }
    const aborted = () => failed(new AgentError('请求已中断。'))
    const data = (chunk: Buffer) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 1024 * 1024) { failed(new AgentError('请求内容过大。', 413)); req.resume(); return }
      chunks.push(Buffer.from(chunk))
    }
    const end = () => {
      clean()
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new AgentError('请求格式无效。')) }
    }
    const timer = setTimeout(() => { failed(new AgentError('请求读取超时。', 408)); req.resume() }, 30_000)
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted)
  })
}

export function createAgentBridge(options: {
  isAuthorized: (req: IncomingMessage) => boolean
  manager?: AgentManager
}) {
  const manager = options.manager || new AgentManager()
  const streams = new Set<ServerResponse>()
  let disposed = false

  function json(res: ServerResponse, value: unknown, status = 200): void {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (disposed) throw new AgentError('服务正在关闭。', 503)
    if (!options.isAuthorized(req)) throw new AgentError('请先登录 Codex Remote。', 401)
    if (!trustedOrigin(req)) throw new AgentError('请求来源不受信任。', 403)
    const path = url.pathname.slice('/agent-api/'.length)
    if (path === 'status' && req.method === 'GET') return json(res, await manager.status())
    if (path === 'directories' && req.method === 'GET') {
      const path = url.searchParams.get('path') || homedir()
      if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new AgentError('目录不存在。')
      const entries = await readdir(path, { withFileTypes: true })
      return json(res, { path: resolve(path), parent: dirname(path), directories: entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => ({ name: entry.name, path: resolve(path, entry.name) })).sort((a, b) => a.name.localeCompare(b.name)) })
    }
    if (path === 'sessions' && req.method === 'GET') return json(res, await manager.list())
    if (path === 'sessions' && req.method === 'POST') {
      const input = z.object({ cwd: z.string().min(1).max(4096) }).parse(await body(req))
      return json(res, await manager.create(input.cwd), 201)
    }
    if (path === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' })
      streams.add(res)
      const write = (event: string, value: unknown) => {
        if (res.destroyed || res.writableEnded) return
        if (res.writableLength > 1024 * 1024) { res.destroy(); return }
        res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
      }
      const unsubscribe = manager.subscribe(update => write('update', update))
      // Reconnects reconcile with durable state, never replay a prompt.
      write('ready', {})
      const timer = setInterval(() => { if (!options.isAuthorized(req)) res.end(); else write('ping', {}) }, 25_000)
      timer.unref()
      res.once('close', () => { clearInterval(timer); unsubscribe(); streams.delete(res) })
      return
    }
    const match = /^sessions\/([a-f0-9-]{36})(?:\/(activate|config|prompt|stop|permission|archive))?$/.exec(path)
    if (!match) throw new AgentError('接口不存在。', 404)
    const id = match[1]!, action = match[2]
    if (!action && req.method === 'GET') {
      const raw = url.searchParams.get('before')
      const before = raw === null ? undefined : Number(raw)
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new AgentError('历史分页位置无效。')
      return json(res, await manager.detail(id, before))
    }
    if (req.method !== 'POST') throw new AgentError('请求方法不支持。', 405)
    if (action === 'activate') return json(res, await manager.activate(id))
    if (action === 'stop') return json(res, await manager.stop(id))
    if (action === 'archive') { await manager.archive(id); return json(res, { ok: true }) }
    const input = await body(req)
    if (action === 'prompt') return json(res, await manager.prompt(id, promptSchema.parse(input)), 202)
    if (action === 'config') {
      const value = z.object({ configId: z.string().min(1).max(200), value: z.string().max(2000) }).parse(input)
      return json(res, await manager.configure(id, value.configId, value.value))
    }
    if (action === 'permission') {
      const value = z.object({ permissionId: z.string().uuid(), optionId: z.string().min(1).max(1000) }).parse(input)
      await manager.respond(id, value.permissionId, value.optionId)
      return json(res, { ok: true })
    }
    throw new AgentError('接口不存在。', 404)
  }

  return {
    manager,
    middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
      const url = new URL(req.url || '/', 'http://localhost')
      if (!url.pathname.startsWith('/agent-api/')) return next()
      void handle(req, res, url).catch(error => json(res, { error: error instanceof AgentError ? error.message : error instanceof z.ZodError ? '请求参数无效。' : 'DSH 操作失败，请检查主机的 DSH 配置或稍后重试。' }, error instanceof AgentError ? error.status : error instanceof z.ZodError ? 400 : 500))
    },
    async dispose(): Promise<void> {
      disposed = true
      for (const stream of streams) stream.end()
      await manager.dispose()
    },
  }
}
