import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeStarbridgeControlUrl } from './controlPlaneClient.js'
import { getStarbridgePaths, readActivationAttempt, readDevice, writeDevice, writeFrpcConfig, type StarbridgeDevice } from './credentialStore.js'
import { StarbridgeManager } from './starbridgeManager.js'
import { createServer } from '../httpServer.js'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  delete process.env.CODEXUI_STARBRIDGE_HOME
  delete process.env.CODEXUI_STARBRIDGE_CONTROL_URL
})

describe('StarBridge host module', () => {
  it('accepts HTTPS production control planes and private HTTP test addresses only', () => {
    expect(normalizeStarbridgeControlUrl('https://relay.example.com/')).toBe('https://relay.example.com')
    expect(normalizeStarbridgeControlUrl('http://192.168.1.148:5920/')).toBe('http://192.168.1.148:5920')
    expect(() => normalizeStarbridgeControlUrl('http://relay.example.com')).toThrow(/HTTPS/u)
  })

  it('writes credentials and FRPC configuration with private permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-starbridge-test-'))
    tempDirectories.push(root)
    const paths = getStarbridgePaths(root)
    const device: StarbridgeDevice = {
      deviceName: 'test-host', deviceSecret: 'xj_dev_test', controlUrl: 'https://relay.example.com',
      clientId: 'device-1', domain: 'test.relay.example.com', subdomain: 'test', username: 'test',
      subscription: { plan: 'monthly', status: 'active', expiresAt: 2_000_000_000 },
      frpcConfig: 'auth.method = "oidc"\n', frpcVersion: '0.71.0', updatedAt: Date.now(),
    }
    await writeDevice(device, paths)
    await writeFrpcConfig(device.frpcConfig, paths)
    expect(await readDevice(paths)).toMatchObject(device)
    expect((await stat(paths.device)).mode & 0o777).toBe(0o600)
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600)
    expect(await readFile(paths.config, 'utf8')).toContain('auth.method')
  })

  it('reports an unconfigured host without starting a process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-starbridge-status-'))
    tempDirectories.push(root)
    process.env.CODEXUI_STARBRIDGE_HOME = root
    const manager = new StarbridgeManager(true)
    const status = await manager.status()
    expect(status.state).toBe('unconfigured')
    expect(status.passwordProtected).toBe(true)
  })

  it('persists one device secret before redemption and reuses it after a lost response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-starbridge-retry-'))
    tempDirectories.push(root)
    process.env.CODEXUI_STARBRIDGE_CONTROL_URL = 'https://relay.example.com'
    const paths = getStarbridgePaths(root)
    const observedSecrets: string[] = []
    let failRequest = true
    const manager = new StarbridgeManager(true, paths, {
      redeemActivation: async (_url, _code, _name, secret) => {
        observedSecrets.push(secret)
        if (failRequest) throw new Error('lost response')
        return {
          user: { username: 'alice' },
          device: { domain: 'alice.relay.example.com', subdomain: 'alice' },
          deviceToken: secret,
          clientId: 'device-alice',
          subscription: { plan: 'monthly', status: 'active', expiresAt: 2_000_000_000 },
          frpcConfig: 'auth.method = "oidc"\n[[proxies]]\ntype = "http"\nlocalIP = "127.0.0.1"\nlocalPort = 5900\nsubdomain = "alice"\n',
        }
      },
      ensureFrpcInstalled: async () => ({ path: paths.binary, version: '0.71.0' }),
      startFrpc: async () => ({ active: true, mode: 'systemd' }),
      isFrpcActive: async () => true,
    })

    await expect(manager.activate({ redemptionCode: 'xj_act_once' })).rejects.toThrow('lost response')
    const pending = await readActivationAttempt(paths)
    expect(pending?.deviceSecret).toMatch(/^xj_dev_/u)
    failRequest = false
    const status = await manager.activate({ redemptionCode: 'xj_act_once' })
    expect(status.state).toBe('online')
    expect(observedSecrets).toEqual([pending?.deviceSecret, pending?.deviceSecret])
    expect(await readActivationAttempt(paths)).toBeNull()
    expect((await readDevice(paths))?.deviceSecret).toBe(pending?.deviceSecret)
  })

  it('rejects activation when the local Codex web server has no password', async () => {
    const instance = createServer()
    const server = createHttpServer(instance.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not start')
      const response = await fetch(`http://127.0.0.1:${address.port}/codex-api/starbridge/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redemptionCode: 'xj_act_test' }),
      })
      expect(response.status).toBe(409)
      expect((await response.json() as { error?: string }).error).toMatch(/访问密码/u)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
    }
  })

  it('rejects unsafe replacement configuration returned during renewal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-starbridge-renew-'))
    tempDirectories.push(root)
    const paths = getStarbridgePaths(root)
    const safeConfig = 'auth.method = "oidc"\n[[proxies]]\ntype = "http"\nlocalIP = "127.0.0.1"\nlocalPort = 5900\nsubdomain = "alice"\n'
    await writeDevice({
      deviceName: 'alice-host', deviceSecret: 'xj_dev_test', controlUrl: 'https://relay.example.com',
      clientId: 'device-alice', domain: 'alice.relay.example.com', subdomain: 'alice', username: 'alice',
      subscription: { plan: 'monthly', status: 'active', expiresAt: 2_000_000_000 },
      frpcConfig: safeConfig, frpcVersion: '0.71.0', updatedAt: Date.now(),
    }, paths)
    let started = false
    const manager = new StarbridgeManager(true, paths, {
      redeemRenewal: async () => ({
        subscription: { plan: 'monthly', status: 'active', expiresAt: 2_100_000_000 },
        frpcConfig: `${safeConfig}\n[[proxies]]\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 22\n`,
      }),
      startFrpc: async () => {
        started = true
        return { active: true, mode: 'systemd' }
      },
    })

    await expect(manager.renew({ redemptionCode: 'xj_renew_once' })).rejects.toThrow(/不安全/u)
    expect(started).toBe(false)
    expect((await readDevice(paths))?.frpcConfig).toBe(safeConfig)
  })

  it('exposes only redacted status through the local HTTP bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-starbridge-http-'))
    tempDirectories.push(root)
    process.env.CODEXUI_STARBRIDGE_HOME = root
    const instance = createServer({ password: 'local-only-password' })
    const server = createHttpServer(instance.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not start')
      const endpoint = `http://127.0.0.1:${address.port}`
      const statusResponse = await fetch(`${endpoint}/codex-api/starbridge/status`)
      expect(statusResponse.status).toBe(200)
      const statusBody = await statusResponse.text()
      expect(statusBody).not.toContain('deviceSecret')
      expect(statusBody).not.toContain('frpcConfig')

      const malformed = await fetch(`${endpoint}/codex-api/starbridge/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
      expect(malformed.status).toBe(400)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      instance.dispose()
    }
  })
})
