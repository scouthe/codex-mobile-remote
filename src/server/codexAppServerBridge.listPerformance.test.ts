import { describe, expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge'

describe('thread list request coalescing', () => {
  it.each([false, true])('does not cache an older duplicate rollout or roll the cache back on a later page (reverse=%s)', async (reverse) => {
    const server = new AppServerProcess()
    const internals = server as unknown as {
      ensureOfficialAppServer(): Promise<void>
      ensureInitialized(): Promise<void>
      disposeIfConfigChanged(): void
      call(method: string, params: unknown): Promise<unknown>
    }
    vi.spyOn(internals, 'ensureOfficialAppServer').mockResolvedValue()
    vi.spyOn(internals, 'ensureInitialized').mockResolvedValue()
    vi.spyOn(internals, 'disposeIfConfigChanged').mockImplementation(() => {})
    const current = { id: 'shared-thread', path: '/sessions/current.jsonl', updatedAt: 200 }
    const stale = { ...current, path: '/sessions/old.jsonl', updatedAt: 100 }
    const call = vi.spyOn(internals, 'call')
      .mockResolvedValueOnce({ data: reverse ? [stale, current] : [current, stale] })
      .mockResolvedValueOnce({ data: [stale] })

    await server.rpc('thread/list', { cursor: null })
    expect(server.getThreadSummarySnapshot(current.id)).toEqual({ thread: { ...current, turns: [] } })
    await server.rpc('thread/list', { cursor: 'next-page' })
    expect(server.getThreadSummarySnapshot(current.id)).toEqual({ thread: { ...current, turns: [] } })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('shares concurrent identical reads without caching completed list state', async () => {
    const server = new AppServerProcess()
    const execute = vi.spyOn(server as unknown as { executeRpc(method: string, params: unknown): Promise<unknown> }, 'executeRpc')
      .mockImplementation(async () => ({ data: [], nextCursor: null }))
    await Promise.all(Array.from({ length: 10 }, () => server.rpc('thread/list', { cursor: null, limit: 50 })))
    expect(execute).toHaveBeenCalledTimes(1)
    await server.rpc('thread/list', { cursor: null, limit: 50 })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('keeps different pages separate and does not reuse a list across a mutation', async () => {
    const server = new AppServerProcess()
    let finish!: (value: unknown) => void
    const execute = vi.spyOn(server as unknown as { executeRpc(method: string, params: unknown): Promise<unknown> }, 'executeRpc')
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockImplementation(async () => ({ data: [], nextCursor: null }))
    const stale = server.rpc('thread/list', { cursor: null })
    await server.rpc('thread/list', { cursor: 'next-page' })
    await server.rpc('thread/fork', { threadId: 'source' })
    await server.rpc('thread/list', { cursor: null })
    expect(execute).toHaveBeenCalledTimes(4)
    finish({ data: [] })
    await stale
  })

  it('retries a failed list instead of retaining a rejected promise', async () => {
    const server = new AppServerProcess()
    const execute = vi.spyOn(server as unknown as { executeRpc(method: string, params: unknown): Promise<unknown> }, 'executeRpc')
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ data: [] })
    await expect(server.rpc('thread/list', {})).rejects.toThrow('offline')
    await expect(server.rpc('thread/list', {})).resolves.toEqual({ data: [] })
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
