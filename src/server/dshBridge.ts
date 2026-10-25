import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { DshBridgeError, DshConnection, type DshSession } from './dshConnection.js'

const MOUNT = '/dsh/'
const STATUS = '/dsh-api/status'
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']

function headersWithoutHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers }
  for (const name of String(headers.connection || '').split(',').map(value => value.trim().toLowerCase())) delete result[name]
  for (const name of HOP_HEADERS) delete result[name]
  return result
}

function trustedOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  if (!req.headers.origin) return true
  try {
    const origin = new URL(req.headers.origin)
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host
  } catch { return false }
}

function upstreamHeaders(req: IncomingMessage, session: DshSession, upgrade: boolean): IncomingHttpHeaders {
  const headers = headersWithoutHop(req.headers)
  for (const name of Object.keys(headers)) {
    if (name === 'authorization' || name === 'forwarded' || name.startsWith('x-forwarded-')) delete headers[name]
  }
  headers.host = session.target.host
  headers.cookie = session.cookie
  if (headers.origin) headers.origin = session.target.origin
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket' }
  return headers
}

function upstreamUrl(url: URL, session: DshSession): URL {
  const target = new URL(session.target)
  target.pathname = '/' + url.pathname.slice(MOUNT.length)
  target.search = url.search
  // DSH's combo loader uses /plugins/??entry1,entry2&rev=... . Re-serializing
  // that query as URLSearchParams changes its wire format and breaks plugins.
  if (target.searchParams.has('token')) target.searchParams.delete('token')
  return target
}

function responseHeaders(headers: IncomingHttpHeaders, target: URL): IncomingHttpHeaders {
  const result = headersWithoutHop(headers)
  // The owner's DSH cookie is internal. Only 5900 authenticates the browser.
  delete result['set-cookie']
  if (result.location) {
    const location = new URL(result.location, target)
    if (location.origin === target.origin) {
      if (location.searchParams.has('token')) location.searchParams.delete('token')
      result.location = MOUNT.slice(0, -1) + location.pathname + location.search + location.hash
    }
  }
  return result
}

/** Transparent HTTP/WS transport. No DSH session parsing or UI modifications. */
export function createDshBridge(connection = new DshConnection()) {
  const requests = new Set<ClientRequest>()
  const sockets = new Set<Duplex>()
  let disposed = false

  function trackRequest(request: ClientRequest): ClientRequest {
    requests.add(request)
    request.once('close', () => requests.delete(request))
    return request
  }

  function trackSocket(socket: Duplex): void {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }

  function unavailable(res: ServerResponse, error: unknown): void {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) { res.destroy(); return }
    const known = error instanceof DshBridgeError
    res.writeHead(known ? error.status : 502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(known ? error.message : 'DSH 连接中断，请重新加载。')
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!trustedOrigin(req)) throw new DshBridgeError('请求来源不受信任。', 403)
    if (disposed) throw new DshBridgeError('服务正在关闭。')
    if (url.pathname === STATUS && req.method === 'GET') {
      let available = false, message = ''
      try {
        const session = await connection.ready()
        const probe = await fetch(session.target, { method: 'HEAD', headers: { Cookie: session.cookie }, redirect: 'manual', signal: AbortSignal.timeout(5000) })
        if (!probe.ok) { connection.invalidate(session); throw new Error() }
        available = true
      } catch (error) { message = error instanceof DshBridgeError ? error.message : '暂时无法连接 DSH，请确认服务正在运行后重试。' }
      if (!res.destroyed) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ available, message }))
      }
      return
    }
    if (url.pathname === '/dsh') {
      res.writeHead(307, { Location: MOUNT, 'Cache-Control': 'no-store' }); res.end(); return
    }
    const session = await connection.ready()
    if (res.destroyed || disposed) return
    const target = upstreamUrl(url, session)
    const upstream = trackRequest((target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: req.method, headers: upstreamHeaders(req, session, false),
    }, response => {
      if (response.statusCode === 401) connection.invalidate(session)
      response.once('error', () => res.destroy())
      if (res.destroyed) { response.destroy(); return }
      try { res.writeHead(response.statusCode || 502, responseHeaders(response.headers, target)) }
      catch (error) { response.destroy(); unavailable(res, error); return }
      response.pipe(res)
    }))
    upstream.setTimeout(30000, () => upstream.destroy(new Error('DSH request timeout')))
    upstream.once('error', error => unavailable(res, error))
    const cancel = () => upstream.destroy()
    req.once('aborted', cancel)
    res.once('close', cancel)
    upstream.once('close', () => { req.off('aborted', cancel); res.off('close', cancel) })
    req.pipe(upstream)
  }

  function matches(req: IncomingMessage): boolean {
    const path = new URL(req.url || '/', 'http://localhost').pathname
    return path === '/dsh' || path.startsWith(MOUNT) || path === STATUS
  }

  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    if (!matches(req)) return next()
    void handle(req, res, new URL(req.url || '/', 'http://localhost')).catch(error => unavailable(res, error))
  }

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = (status: number) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} DSH connection unavailable\r\nConnection: close\r\n\r\n`) }
    if (!trustedOrigin(req)) { reject(403); return }
    try {
      const session = await connection.ready()
      if (socket.destroyed || disposed) { socket.destroy(); return }
      const target = upstreamUrl(new URL(req.url || '/', 'http://localhost'), session)
      const request = trackRequest((target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: 'GET', headers: upstreamHeaders(req, session, true),
      }))
      const cancel = () => request.destroy()
      socket.once('close', cancel)
      request.setTimeout(10000, () => request.destroy(new Error('DSH upgrade timeout')))
      request.once('error', () => reject(502))
      request.once('response', response => {
        if (response.statusCode === 401) connection.invalidate(session)
        response.resume(); reject(response.statusCode === 401 ? 503 : 502)
      })
      request.once('upgrade', (response, upstream, upstreamHead) => {
        socket.off('close', cancel)
        if (socket.destroyed || disposed) { upstream.destroy(); return }
        request.setTimeout(0); upstream.setTimeout(0)
        const headers = responseHeaders(response.headers, target)
        headers.connection = 'Upgrade'; headers.upgrade = 'websocket'
        const lines = Object.entries(headers).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [String(value)]).map(value => `${name}: ${value}`))
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`)
        if (upstreamHead.length) socket.write(upstreamHead)
        if (head.length) upstream.write(head)
        trackSocket(socket); trackSocket(upstream)
        socket.once('error', () => upstream.destroy()); upstream.once('error', () => socket.destroy())
        socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy())
        socket.pipe(upstream); upstream.pipe(socket)
      })
      request.end()
    } catch { reject(503) }
  }

  return {
    middleware, matches, upgrade,
    dispose() { disposed = true; for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy() },
  }
}
