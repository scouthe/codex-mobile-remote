import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge.js'

type FakeChild = {
  killed: boolean
  stdin: { end: () => void }
  kill: (signal?: string) => void
}

function installIdleChild(appServer: AppServerProcess): FakeChild {
  const child: FakeChild = {
    killed: false,
    stdin: { end: vi.fn() },
    kill: vi.fn(() => { child.killed = true }),
  }
  // The child is normally created by the real app-server spawn path.  This
  // test injects only the already-running handle so the release timer can be
  // verified without starting Codex or touching a user's session.
  ;(appServer as unknown as { process: FakeChild }).process = child
  return child
}

describe('idle app-server writer release', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('recycles an idle child after a terminal notification', async () => {
    vi.useFakeTimers()
    const appServer = new AppServerProcess()
    const child = installIdleChild(appServer)

    ;(appServer as unknown as {
      emitNotification: (notification: { method: string; params: unknown }) => void
    }).emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    })

    await vi.advanceTimersByTimeAsync(1200)

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(appServer.getProcessGeneration()).toBe(1)
  })

  it('does not recycle while another local turn is active', async () => {
    vi.useFakeTimers()
    const appServer = new AppServerProcess()
    const child = installIdleChild(appServer)
    const activeTurnThreadIds = (appServer as unknown as { activeTurnThreadIds: Set<string> }).activeTurnThreadIds
    activeTurnThreadIds.add('thread-2')

    ;(appServer as unknown as {
      emitNotification: (notification: { method: string; params: unknown }) => void
    }).emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
    })

    await vi.advanceTimersByTimeAsync(1200)

    expect(child.kill).not.toHaveBeenCalled()
    expect(appServer.getProcessGeneration()).toBe(0)
  })
})
