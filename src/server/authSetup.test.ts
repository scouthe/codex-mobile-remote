import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from './httpServer.js'

const servers: Server[] = []
const instances: Array<ReturnType<typeof createServer>> = []
const tempDirectories: string[] = []
const originalCodexHome = process.env.CODEX_HOME

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
  instances.splice(0).forEach((instance) => instance.dispose())
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
})

async function listen(options: Parameters<typeof createServer>[0]): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), 'codexapp-auth-session-'))
  tempDirectories.push(codexHome)
  process.env.CODEX_HOME = codexHome
  const instance = createServer(options)
  instances.push(instance)
  const server = createHttpServer(instance.app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not start')
  return `http://127.0.0.1:${address.port}`
}

async function requestWithHost(endpoint: string, host: string): Promise<{ status: number; body: string }> {
  const url = new URL(endpoint)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/codex-api/starbridge/status',
      headers: { Host: host },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

describe('first-run web password setup', () => {
  it('shows setup choices before exposing the app', async () => {
    const endpoint = await listen({ passwordSetupRequired: true })
    const response = await fetch(endpoint)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('首次使用设置')
    expect(html).toContain('设置密码并继续')
    expect(html).toContain('暂不设置，仅局域网使用')
    expect(html).not.toContain('<div id="app"></div>')

    const publicResponse = await requestWithHost(endpoint, 'public-relay.example.com')
    expect(publicResponse.status).toBe(403)
  })

  it('sets the chosen password and signs in the initializing browser', async () => {
    let persistedPassword = ''
    const endpoint = await listen({
      passwordSetupRequired: true,
      persistPassword: async (password) => { persistedPassword = password },
    })

    const response = await fetch(`${endpoint}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'correct-horse-battery' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, passwordProtected: true, lanOnly: false })
    expect(response.headers.get('set-cookie')).toContain('portal_session=')
    expect(persistedPassword).toBe('correct-horse-battery')

    const starbridgeResponse = await fetch(`${endpoint}/codex-api/starbridge/status`)
    expect((await starbridgeResponse.json() as { data: { passwordProtected: boolean } }).data.passwordProtected).toBe(true)
  })

  it('allows an explicit LAN-only choice without enabling password protection', async () => {
    let skipped = false
    const endpoint = await listen({
      passwordSetupRequired: true,
      persistPasswordSkip: async () => { skipped = true },
    })

    const response = await fetch(`${endpoint}/auth/setup/skip`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, passwordProtected: false })
    expect(skipped).toBe(true)

    const appResponse = await fetch(`${endpoint}/codex-api/starbridge/status`)
    expect(appResponse.status).toBe(200)
    expect((await appResponse.json() as { data: { passwordProtected: boolean } }).data.passwordProtected).toBe(false)

    const publicResponse = await requestWithHost(endpoint, 'public-relay.example.com')
    expect(publicResponse.status).toBe(403)
    expect(publicResponse.body).toContain('仅允许从本机或局域网访问')
  })

  it('lets a LAN-only user enable password protection later', async () => {
    let persistedPassword = ''
    const endpoint = await listen({
      lanOnly: true,
      persistPassword: async (password) => { persistedPassword = password },
    })

    const before = await fetch(`${endpoint}/auth/status`)
    expect(await before.json()).toEqual({ passwordProtected: false, lanOnly: true })

    const response = await fetch(`${endpoint}/auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'new-secure-password' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, passwordProtected: true, lanOnly: false })
    expect(response.headers.get('set-cookie')).toContain('portal_session=')
    expect(persistedPassword).toBe('new-secure-password')

    const starbridgeResponse = await fetch(`${endpoint}/codex-api/starbridge/status`)
    expect((await starbridgeResponse.json() as { data: { passwordProtected: boolean } }).data.passwordProtected).toBe(true)
  })
})
