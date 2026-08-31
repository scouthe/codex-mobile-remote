import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAccountRoutes } from './accountRoutes.js'

function responseCapture() {
  let body = ''
  return {
    statusCode: 200,
    headers: new Map<string, string>(),
    setHeader(name: string, value: string) {
      this.headers.set(name, value)
    },
    end(value?: string) {
      body = value ?? ''
    },
    json() {
      return JSON.parse(body) as Record<string, unknown>
    },
  }
}

const tempHomes: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('account routes with a Codex provider', () => {
  it('shows a read-only configured provider when auth.json has no account_id', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-account-'))
    tempHomes.push(codexHome)
    vi.stubEnv('CODEX_HOME', codexHome)
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
      auth_mode: 'api_key',
      tokens: { access_token: 'third-party-token' },
    }))
    await writeFile(join(codexHome, 'config.toml'), 'model_provider = "my-provider"\nmodel = "gpt-custom"\n')

    const appServer = {
      rpc: vi.fn().mockResolvedValue({
        config: {
          model: 'gpt-custom',
          model_provider: 'my-provider',
          model_providers: {
            'my-provider': { name: 'Private API' },
          },
        },
      }),
      listPendingServerRequests: () => [],
      dispose: () => undefined,
    }
    const res = responseCapture()
    const handled = await handleAccountRoutes(
      { method: 'GET', url: '/codex-api/accounts' } as never,
      res as never,
      new URL('http://localhost/codex-api/accounts'),
      { appServer },
    )

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      activeAccountId: 'codex-provider:my-provider',
      accounts: [{
        accountKind: 'codex-provider',
        providerId: 'my-provider',
        isActive: true,
      }],
    })
  })

  it('makes account refresh a no-op instead of returning missing_account_id', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-account-'))
    tempHomes.push(codexHome)
    vi.stubEnv('CODEX_HOME', codexHome)
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
      auth_mode: 'api_key',
      tokens: { access_token: 'third-party-token' },
    }))
    await writeFile(join(codexHome, 'config.toml'), 'model_provider = "my-provider"\n')

    const appServer = {
      rpc: vi.fn().mockResolvedValue({
        config: {
          model_provider: 'my-provider',
          model_providers: { 'my-provider': { name: 'Private API' } },
        },
      }),
      listPendingServerRequests: () => [],
      dispose: () => undefined,
    }
    const res = responseCapture()
    await handleAccountRoutes(
      { method: 'POST', url: '/codex-api/accounts/refresh' } as never,
      res as never,
      new URL('http://localhost/codex-api/accounts/refresh'),
      { appServer },
    )

    expect(res.statusCode).toBe(200)
    const data = res.json().data as { accounts: unknown[] }
    expect(data.accounts[0]).toMatchObject({ accountKind: 'codex-provider' })
  })

  it('does not expose a nested profile provider as the active top-level Codex provider', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-mobile-account-'))
    tempHomes.push(codexHome)
    vi.stubEnv('CODEX_HOME', codexHome)
    await writeFile(join(codexHome, 'config.toml'), [
      '[profiles.work]',
      'model_provider = "nested-provider"',
      '',
      '[model_providers.nested-provider]',
      'name = "Nested API"',
    ].join('\n'))

    const appServer = {
      rpc: vi.fn().mockResolvedValue({
        config: {
          model_provider: 'nested-provider',
          model_providers: { 'nested-provider': { name: 'Nested API' } },
        },
      }),
      listPendingServerRequests: () => [],
      dispose: () => undefined,
    }
    const res = responseCapture()
    await handleAccountRoutes(
      { method: 'GET', url: '/codex-api/accounts' } as never,
      res as never,
      new URL('http://localhost/codex-api/accounts'),
      { appServer },
    )

    expect(res.statusCode).toBe(200)
    const data = res.json().data as { accounts: unknown[] }
    expect(data.accounts).toEqual([])
  })
})
