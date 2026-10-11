import { describe, expect, it, vi } from 'vitest'
import { countTurnsFromTarget, invalidateThreadHistoryPages, readOfficialThreadPage } from './threadHistoryPager'

const turn = (id: string) => ({ id, items: [{ type: 'agentMessage', text: id }], itemsView: 'full' })

describe('official history pagination', () => {
  it('counts an edit target through metadata pages, including empty turns', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [{ id: 'new' }, { id: 'empty' }], nextCursor: 'old' })
      .mockResolvedValueOnce({ data: [{ id: 'target' }], nextCursor: null })
    await expect(countTurnsFromTarget({ rpc }, 't', 'target')).resolves.toBe(3)
    expect(rpc.mock.calls.every(([method, params]) => method === 'thread/turns/list' && params.itemsView === 'notLoaded')).toBe(true)
  })

  it('never turns an absent edit target into a rollback of all turns', async () => {
    const server = { rpc: vi.fn().mockResolvedValue({ data: [{ id: 'existing' }], nextCursor: null }) }
    await expect(countTurnsFromTarget(server, 't', 'deleted')).rejects.toThrow('no longer exists')
  })
  it('reads bounded full-item pages and reuses the opaque cursor for older history', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [turn('4'), turn('3')], nextCursor: 'older-2' })
      .mockResolvedValueOnce({ data: [turn('2'), turn('1')], nextCursor: null })
    const server = { rpc }
    await expect(readOfficialThreadPage(server, 't', 2)).resolves.toEqual({ turns: [turn('3'), turn('4')], hasMoreOlder: true })
    await expect(readOfficialThreadPage(server, 't', 2, '3')).resolves.toEqual({ turns: [turn('1'), turn('2')], hasMoreOlder: false })
    expect(rpc.mock.calls).toEqual([
      ['thread/turns/list', { threadId: 't', cursor: null, limit: 2, sortDirection: 'desc', itemsView: 'full' }],
      ['thread/turns/list', { threadId: 't', cursor: 'older-2', limit: 2, sortDirection: 'desc', itemsView: 'full' }],
    ])
    await expect(readOfficialThreadPage(server, 't', 2, '1')).resolves.toEqual({ turns: [], hasMoreOlder: false })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('finds an anchor from an Android snapshot without loading the whole thread', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [turn('6'), turn('5')], nextCursor: 'c4' })
      .mockResolvedValueOnce({ data: [turn('4'), turn('3')], nextCursor: 'c2' })
      .mockResolvedValueOnce({ data: [turn('2'), turn('1')], nextCursor: null })
    const server = { rpc }
    await expect(readOfficialThreadPage(server, 't', 2, '3')).resolves.toEqual({ turns: [turn('1'), turn('2')], hasMoreOlder: false })
    expect(rpc.mock.calls.every(([method]) => method === 'thread/turns/list')).toBe(true)
  })

  it('preserves older turns in the same page as an anchor', async () => {
    const server = { rpc: vi.fn().mockResolvedValue({ data: [turn('4'), turn('3'), turn('2')], nextCursor: 'c1' }) }
    await expect(readOfficialThreadPage(server, 't', 3, '3')).resolves.toEqual({ turns: [turn('2')], hasMoreOlder: true })
  })

  it('merges concurrent reads but rereads completed requests for fresh active output', async () => {
    const rpc = vi.fn().mockImplementation(async () => ({ data: [turn('1')], nextCursor: null }))
    const server = { rpc }
    await Promise.all(Array.from({ length: 10 }, () => readOfficialThreadPage(server, 't', 10)))
    expect(rpc).toHaveBeenCalledTimes(1)
    await readOfficialThreadPage(server, 't', 10)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('uses legacy fallback only for missing methods and probes again after reconnect', async () => {
    let generation = 1
    const server = { rpc: vi.fn().mockRejectedValue(new Error('Method not found')), getProcessGeneration: () => generation }
    await expect(readOfficialThreadPage(server, 't', 10)).resolves.toBeNull()
    await expect(readOfficialThreadPage(server, 'other', 10)).resolves.toBeNull()
    expect(server.rpc).toHaveBeenCalledTimes(1)
    generation++
    server.rpc.mockResolvedValue({ data: [], nextCursor: null })
    await expect(readOfficialThreadPage(server, 't', 10)).resolves.toEqual({ turns: [], hasMoreOlder: false })
  })

  it('propagates network failures and malformed pages instead of doing a full history read', async () => {
    const server = { rpc: vi.fn().mockRejectedValueOnce(new Error('503 unavailable')).mockResolvedValueOnce({ ok: true }) }
    await expect(readOfficialThreadPage(server, 't', 10)).rejects.toThrow('503')
    await expect(readOfficialThreadPage(server, 't', 10)).rejects.toThrow('invalid page')
    expect(server.rpc.mock.calls.every(([method]) => method === 'thread/turns/list')).toBe(true)
  })

  it('invalidates anchors after rollback and prevents cursor loops', async () => {
    const server = { rpc: vi.fn().mockResolvedValue({ data: [turn('4'), turn('3')], nextCursor: 'old' }) }
    await readOfficialThreadPage(server, 't', 2)
    invalidateThreadHistoryPages(server, 't')
    server.rpc.mockResolvedValue({ data: [turn('2'), turn('1')], nextCursor: null })
    await expect(readOfficialThreadPage(server, 't', 2, '3')).resolves.toEqual({ turns: [], hasMoreOlder: false })
    expect(server.rpc.mock.lastCall?.[1]).toMatchObject({ cursor: null })
    server.rpc.mockResolvedValue({ data: [turn('4')], nextCursor: 'repeat' })
    await expect(readOfficialThreadPage(server, 't', 2, 'missing')).rejects.toThrow('repeated cursor')
  })
})
