import { describe, expect, it } from 'vitest'
import {
  APP_SERVER_SOCKET_ENV_KEY,
  buildAppServerArgs,
  buildAppServerProxyArgs,
  resolveSharedAppServerSocket,
} from './appServerRuntimeConfig'

describe('app-server runtime config', () => {
  it('enables Codex memories by default for spawned app-server processes', () => {
    const args = buildAppServerArgs()
    const featureIndex = args.indexOf('features.memories=true')

    expect(featureIndex).toBeGreaterThan(0)
    expect(args[featureIndex - 1]).toBe('-c')
  })

  it('can disable Codex memories through runtime configuration', () => {
    process.env.CODEXUI_MEMORIES = 'false'
    try {
      const args = buildAppServerArgs()
      const featureIndex = args.indexOf('features.memories=false')

      expect(featureIndex).toBeGreaterThan(0)
      expect(args[featureIndex - 1]).toBe('-c')
      expect(args).not.toContain('features.memories=true')
    } finally {
      delete process.env.CODEXUI_MEMORIES
    }
  })

  it('resolves an explicitly configured Desktop app-server socket', () => {
    process.env[APP_SERVER_SOCKET_ENV_KEY] = '  /tmp/codex-desktop.sock  '
    try {
      expect(resolveSharedAppServerSocket()).toBe('/tmp/codex-desktop.sock')
      expect(buildAppServerProxyArgs()).toEqual([
        'app-server',
        'proxy',
        '--sock',
        '/tmp/codex-desktop.sock',
      ])
      expect(buildAppServerProxyArgs()).not.toContain('sandbox_mode="danger-full-access"')
    } finally {
      delete process.env[APP_SERVER_SOCKET_ENV_KEY]
    }
  })

  it('keeps the legacy launch path when no shared socket is configured', () => {
    delete process.env[APP_SERVER_SOCKET_ENV_KEY]
    expect(resolveSharedAppServerSocket()).toBeNull()
    expect(buildAppServerProxyArgs()).toBeNull()
  })
})
