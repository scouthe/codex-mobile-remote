import { afterEach, describe, expect, it } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge.js'
import { APP_SERVER_SOCKET_ENV_KEY } from './appServerRuntimeConfig.js'

const buildConfig = (appServer: AppServerProcess): {
  launchMode: 'shared-proxy'
  sharedSocketPath: string | null
} => (
  appServer as unknown as {
    buildAppServerConfig: () => {
      launchMode: 'shared-proxy'
      sharedSocketPath: string | null
    }
  }
).buildAppServerConfig()

const originalSocketPath = process.env[APP_SERVER_SOCKET_ENV_KEY]
const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalSocketPath === undefined) delete process.env[APP_SERVER_SOCKET_ENV_KEY]
  else process.env[APP_SERVER_SOCKET_ENV_KEY] = originalSocketPath
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
})

describe('shared app-server launch guard', () => {
  it('fails closed instead of falling back to a standalone app-server', () => {
    process.env[APP_SERVER_SOCKET_ENV_KEY] = `/tmp/codex-desktop-missing-${Date.now()}.sock`
    const appServer = new AppServerProcess()

    expect(appServer.getConnectionStatus()).toMatchObject({
      mode: 'shared-proxy',
      running: false,
      socketAvailable: false,
      officialServerStarting: false,
      officialServerManaged: false,
    })
    expect(() => buildConfig(appServer)).toThrow(
      /Shared Codex app-server socket is unavailable/u,
    )
  })

  it('uses the default socket instead of starting a standalone app-server', () => {
    delete process.env[APP_SERVER_SOCKET_ENV_KEY]
    process.env.CODEX_HOME = `/tmp/codex-default-missing-${Date.now()}`
    const appServer = new AppServerProcess()

    expect(() => buildConfig(appServer)).toThrow(
      /Shared Codex app-server socket is unavailable/u,
    )
  })
})
