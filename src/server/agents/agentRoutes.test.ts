import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createAgentBridge } from './agentRoutes.js'
import { AgentManager } from './agentManager.js'
import { AgentSessionStore } from './sessionStore.js'

it('authenticates ACP routes, rejects cross-origin writes, validates and bounds input before dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-agent-http-'))
  let authorized = false
  const manager = new AgentManager(new AgentSessionStore(directory), { available: async () => false })
  const bridge = createAgentBridge({ manager, isAuthorized: () => authorized })
  const server = createServer((req, res) => bridge.middleware(req, res, () => { res.writeHead(404); res.end() }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    expect((await fetch(`${base}/agent-api/status`)).status).toBe(401)
    authorized = true
    const status = await fetch(`${base}/agent-api/status`)
    expect(status.status).toBe(200)
    expect((await status.json() as { available: boolean }).available).toBe(false)
    expect((await fetch(`${base}/agent-api/sessions?cwd=relative`)).status).toBe(400)
    expect((await fetch(`${base}/agent-api/sessions?cursor=${'a'.repeat(4097)}`)).status).toBe(400)
    expect((await fetch(`${base}/agent-api/sessions`, { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403)
    expect((await fetch(`${base}/agent-api/sessions`, { method: 'POST', body: '{' })).status).toBe(400)
    expect((await fetch(`${base}/agent-api/sessions`, { method: 'POST', body: JSON.stringify({ cwd: 42 }) })).status).toBe(400)
    expect((await fetch(`${base}/agent-api/sessions`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413)
    expect((await fetch(`${base}/agent-api/sessions/missing`)).status).toBe(404)
  } finally {
    await bridge.dispose()
    server.closeAllConnections(); server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
