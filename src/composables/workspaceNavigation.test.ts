import { afterEach, expect, it, vi } from 'vitest'
import { rememberWorkspaceRoute, workspaceRoute } from './workspaceNavigation'

afterEach(() => vi.unstubAllGlobals())

it('opens native DSH even when an earlier browser session remembered an ACP conversation', () => {
  const storage = new Map([['codex-remote.workspace.dsh.last-route', '/dsh/session/old-acp-id']])
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) })
  expect(workspaceRoute('dsh')).toBe('/dsh')
  rememberWorkspaceRoute('dsh', '/dsh/native')
  expect(storage.get('codex-remote.workspace.dsh.last-route')).toBe('/dsh')
  rememberWorkspaceRoute('codex', '/thread/keep-this-thread')
  expect(workspaceRoute('codex')).toBe('/thread/keep-this-thread')
})
