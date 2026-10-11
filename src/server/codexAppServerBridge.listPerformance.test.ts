import { describe, expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge'

describe('thread list request coalescing', () => {
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
