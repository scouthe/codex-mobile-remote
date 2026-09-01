import { describe, expect, it } from 'vitest'
import {
  APP_SERVER_SOCKET_ENV_KEY,
  buildAppServerArgs,
  buildOfficialAppServerArgs,
  buildAppServerProxyArgs,
  requireSharedAppServerSocket,
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

  it('uses the official socket path derived from CODEX_HOME by default', () => {
    const originalCodexHome = process.env.CODEX_HOME
    delete process.env[APP_SERVER_SOCKET_ENV_KEY]
    process.env.CODEX_HOME = '/tmp/codex-default-home'
    try {
      expect(resolveSharedAppServerSocket()).toBe(
        '/tmp/codex-default-home/app-server-control/app-server-control.sock',
      )
      expect(buildAppServerProxyArgs()).toEqual([
        'app-server',
        'proxy',
        '--sock',
        '/tmp/codex-default-home/app-server-control/app-server-control.sock',
      ])
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
    }
  })

  it('resolves the default official socket for the main Codex bridge', () => {
    const originalCodexHome = process.env.CODEX_HOME
    delete process.env[APP_SERVER_SOCKET_ENV_KEY]
    process.env.CODEX_HOME = '/tmp/codex-missing-default-home'
    try {
      expect(requireSharedAppServerSocket()).toBe(
        '/tmp/codex-missing-default-home/app-server-control/app-server-control.sock',
      )
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
    }
  })

  it('builds the official Unix app-server bootstrap command', () => {
    expect(buildOfficialAppServerArgs('/tmp/codex-official.sock')).toEqual([
      'app-server',
      '--listen',
      'unix:///tmp/codex-official.sock',
    ])
  })

  it('uses the standard Unix transport when no socket override is available', () => {
    expect(buildOfficialAppServerArgs(null)).toEqual([
      'app-server',
      '--listen',
      'unix://',
    ])
  })
})
