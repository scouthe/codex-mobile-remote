import { createServer, request, type Server, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshConnection } from './dshConnection.js'
import { createDshBridge } from './dshBridge.js'
import { createServer as createApp } from './httpServer.js'

const servers: Server[] = []
const disposers: Array<() => void> = []
const directories: string[] = []

afterEach(async () => {
  disposers.splice(0).reverse().forEach(dispose => dispose())
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

async function fixture() {
  let exchanges = 0
  let expectedCookie = 'dsh-auth-test=private-cookie'
  const seen: Array<{ path: string; headers: IncomingHttpHeaders; method?: string }> = []
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname === '/' && url.searchParams.get('token') === 'private-launch-token') {
      exchanges++
      res.writeHead(303, { 'Set-Cookie': `${expectedCookie}; Path=/; HttpOnly; Max-Age=3600`, Location: './' }); res.end(); return
    }
    if (req.headers.cookie !== expectedCookie) { res.writeHead(401); res.end('authentication required'); return }
    seen.push({ path: req.url || '/', headers: req.headers, method: req.method })
    if (url.pathname === '/redirect') {
      res.writeHead(303, { Location: '/api/file?path=example', 'Set-Cookie': 'private-backend-cookie=secret' }); res.end(); return
    }
    if (url.pathname === '/api/upload') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      res.setHeader('Content-Type', 'application/octet-stream'); res.end(Buffer.concat(chunks)); return
    }
    if (url.pathname === '/slow') { res.write('first'); setTimeout(() => res.end('second'), 100); return }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<html><head><base href="./"><title>Original DSH</title></head><body>original plugin interface</body></html>')
  })
  const wsServer = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => {
    seen.push({ path: req.url || '/', headers: req.headers, method: req.method })
    if (req.headers.cookie !== expectedCookie) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    wsServer.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })))
  })
  disposers.push(() => { wsServer.clients.forEach(ws => ws.terminate()); wsServer.close() })
  const target = await listen(upstream)
  const connection = new DshConnection({ config: async () => ({ upstreamUrl: target + '/', launchUrl: target + '/?token=private-launch-token' }) })
  const bridge = createDshBridge(connection)
  disposers.push(() => bridge.dispose())
  const front = createServer((req, res) => bridge.middleware(req, res, () => { res.writeHead(404); res.end() }))
  front.on('upgrade', (req, socket, head) => { void bridge.upgrade(req, socket, head) })
  const base = await listen(front)
  return { base, target, seen, connection, exchanges: () => exchanges, rotate: () => { expectedCookie = 'dsh-auth-test=rotated-cookie' } }
}

async function call(base: string, path: string, headers: IncomingHttpHeaders = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(new URL(path, base), { headers }, res => {
      let body = ''; res.on('data', chunk => { body += chunk }); res.once('error', reject)
      res.once('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }))
    })
    req.once('error', reject); req.end()
  })
}

describe('DSH entry bridge', () => {
  it('preserves the original HTML, strips the mount, and keeps both credentials on their own side', async () => {
    const { base, target, seen, exchanges } = await fixture()
    const response = await call(base, '/dsh/?page=one', { Cookie: 'portal_session=browser-secret', Authorization: 'Bearer browser-secret' })
    expect(response.status).toBe(200)
    expect(response.body).toContain('<base href="./">')
    expect(response.body).toContain('original plugin interface')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).not.toContain('private-launch-token')
    expect(seen.at(-1)).toMatchObject({ path: '/?page=one', headers: { host: new URL(target).host, cookie: 'dsh-auth-test=private-cookie' } })
    expect(seen.at(-1)?.headers.authorization).toBeUndefined()
    await call(base, '/dsh/plugins/example/client.js')
    expect(seen.at(-1)?.path).toBe('/plugins/example/client.js')
    expect(exchanges()).toBe(1)
  })

  it('coalesces the initial authorization across parallel plugin requests', async () => {
    const { base, exchanges } = await fixture()
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => call(base, `/dsh/plugins/${i}/client.js`)))
    expect(responses.every(response => response.status === 200)).toBe(true)
    expect(exchanges()).toBe(1)
  })

  it('preserves the raw combo-loader query used by the original DSH plugins', async () => {
    const { base, seen } = await fixture()
    const path = '/plugins/??@deepseek-ai/dsh-client-modules/client.js,billion-context/client.js&rev=abc123'
    expect((await call(base, '/dsh' + path)).status).toBe(200)
    expect(seen.at(-1)?.path).toBe(path)
  })

  it('streams binary uploads and responses and rebases redirects without forwarding cookies', async () => {
    const { base, seen } = await fixture()
    const bytes = Buffer.from([0, 1, 128, 255])
    const upload = await fetch(base + '/dsh/api/upload?filename=photo.jpg', { method: 'POST', body: bytes })
    expect(Buffer.from(await upload.arrayBuffer())).toEqual(bytes)
    expect(seen.at(-1)?.method).toBe('POST')
    const redirected = await call(base, '/dsh/redirect')
    expect(redirected.headers.location).toBe('/dsh/api/file?path=example')
    expect(redirected.headers['set-cookie']).toBeUndefined()
    const slow = await fetch(base + '/dsh/slow')
    const reader = slow.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('second')
    await reader.cancel()
  })

  it('validates the browser Origin before translating it to the upstream authority', async () => {
    const { base, target, seen, exchanges } = await fixture()
    expect((await call(base, '/dsh/api/test', { Origin: 'https://untrusted.example' })).status).toBe(403)
    expect(exchanges()).toBe(0)
    expect((await call(base, '/dsh/api/test', { Origin: base })).status).toBe(200)
    expect(seen.at(-1)?.headers.origin).toBe(target)
    expect((await call(base, '/dsh/', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
  })

  it('relays multiplexed WebSockets including binary frames and releases them on disposal', async () => {
    const { base, target, seen } = await fixture()
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/dsh/api/remote.mux', { origin: base, headers: { Cookie: 'portal_session=browser-secret' } })
    disposers.push(() => ws.terminate())
    await once(ws, 'open')
    const data = Buffer.from([0, 255, 12])
    const message = once(ws, 'message'); ws.send(data)
    const [received, binary] = await message
    expect(received).toEqual(data); expect(binary).toBe(true)
    expect(seen.at(-1)).toMatchObject({ path: '/api/remote.mux', headers: { host: new URL(target).host, origin: target, cookie: 'dsh-auth-test=private-cookie' } })
    ws.close(); await once(ws, 'close')
  })

  it('invalidates failed backend authentication and reconnects without replaying a POST', async () => {
    const { base, exchanges, rotate } = await fixture()
    expect((await call(base, '/dsh/')).status).toBe(200)
    rotate()
    const failed = await fetch(base + '/dsh/api/upload', { method: 'POST', body: 'once' })
    expect(failed.status).toBe(401)
    expect(exchanges()).toBe(1)
    expect((await call(base, '/dsh/')).status).toBe(200)
    expect(exchanges()).toBe(2)
  })

  it('provides a useful unconfigured status without trying to start or modify DSH', async () => {
    const bridge = createDshBridge(new DshConnection({ config: async () => undefined }))
    disposers.push(() => bridge.dispose())
    const base = await listen(createServer((req, res) => bridge.middleware(req, res, () => res.end())))
    const status = await fetch(base + '/dsh-api/status').then(response => response.json()) as { available: boolean; message: string }
    expect(status).toMatchObject({ available: false })
    expect(status.message).toContain('尚未接入')
    const response = await call(base, '/dsh/')
    expect(response.status).toBe(503)
  })

  it('protects HTML, assets, status, and WebSocket upgrades with the real 5900 authentication', async () => {
    const { target, exchanges } = await fixture()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-entry-auth-')); directories.push(directory)
    vi.stubEnv('CODEX_HOME', directory)
    vi.stubEnv('CODEXUI_DSH_URL', target + '/?token=private-launch-token')
    const app = createApp({ password: 'test-password' })
    disposers.push(() => app.dispose())
    const server = createServer(app.app); app.attachWebSocket(server)
    const base = await listen(server)
    for (const path of ['/dsh/', '/dsh/plugins/example/client.js', '/dsh-api/status']) {
      const response = await call(base, path, { Host: 'public.example' })
      expect(response.body).toContain('<!DOCTYPE html>')
      expect(response.body).not.toContain('original plugin interface')
    }
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/dsh/api/remote.mux', { headers: { Host: 'public.example' } })
    disposers.push(() => ws.terminate())
    const status = await new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode || 0) })
      ws.once('error', reject)
    })
    expect(status).toBe(401)
    expect(exchanges()).toBe(0)
    expect((await call(base, '/dsh/')).status).toBe(200)
    expect(exchanges()).toBe(1)
  })
})
