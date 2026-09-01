import { afterEach, describe, expect, it } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge.js'
import { APP_SERVER_SOCKET_ENV_KEY } from './appServerRuntimeConfig.js'

const buildConfig = (appServer: AppServerProcess): {
  launchMode: 'standalone' | 'shared-proxy'
  sharedSocketPath: string | null
} => (
  appServer as unknown as {
    buildAppServerConfig: () => {
      launchMode: 'standalone' | 'shared-proxy'
      sharedSocketPath: string | null
    }
  }
).buildAppServerConfig()

const originalSocketPath = process.env[APP_SERVER_SOCKET_ENV_KEY]

afterEach(() => {
  if (originalSocketPath === undefined) delete process.env[APP_SERVER_SOCKET_ENV_KEY]
  else process.env[APP_SERVER_SOCKET_ENV_KEY] = originalSocketPath
})

describe('shared app-server launch guard', () => {
  it('fails closed instead of falling back to a standalone app-server', () => {
    process.env[APP_SERVER_SOCKET_ENV_KEY] = `/tmp/codex-desktop-missing-${Date.now()}.sock`
    const appServer = new AppServerProcess()

    expect(appServer.getConnectionStatus()).toMatchObject({
      mode: 'shared-proxy',
      running: false,
      socketAvailable: false,
    })
    expect(() => buildConfig(appServer)).toThrow(
      /Shared Codex app-server socket is unavailable/u,
    )
  })

  it('keeps standalone mode when no shared socket is configured', () => {
    delete process.env[APP_SERVER_SOCKET_ENV_KEY]
    const appServer = new AppServerProcess()

    expect(buildConfig(appServer)).toMatchObject({
      launchMode: 'standalone',
      sharedSocketPath: null,
    })
  })
})
