import { appendFile, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadListSupplementCache } from './threadListSupplementCache.js'

const probes = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      probes.paths.push(String(args[0]))
      return actual.stat(...args)
    },
  }
})

const directories: string[] = []

async function database(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-thread-list-cache-'))
  directories.push(directory)
  const path = join(directory, 'state_5.sqlite')
  await writeFile(path, 'fixture')
  return path
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => { probes.paths = [] })
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('thread list SQLite supplement cache', () => {
  it('shares both metadata probes and the loader across simultaneous requests', async () => {
    const path = await database()
    const cache = new ThreadListSupplementCache()
    const loader = vi.fn(() => [{ id: 'thread-1' }])
    const rows = await Promise.all(Array.from({ length: 20 }, () => cache.get(path, loader)))
    expect(loader).toHaveBeenCalledTimes(1)
    expect(probes.paths).toEqual([path, `${path}-wal`])
    expect(rows.every((row) => row === rows[0])).toBe(true)

    expect(await cache.get(path, loader)).toBe(rows[0])
    expect(loader).toHaveBeenCalledTimes(1)
    expect(probes.paths).toHaveLength(4)
    console.info('[thread-list cache perf] 20 concurrent requests: 2 stat calls, 1 loader; subsequent unchanged read: 2 stat calls, 0 loaders')
  })

  it('reloads after database and WAL edits, creation, removal and same-size database replacement', async () => {
    const path = await database()
    const cache = new ThreadListSupplementCache()
    let calls = 0
    const loader = () => [{ call: ++calls }]
    expect(await cache.get(path, loader)).toEqual([{ call: 1 }])
    await appendFile(path, '-updated')
    expect(await cache.get(path, loader)).toEqual([{ call: 2 }])
    await writeFile(`${path}-wal`, 'wal')
    expect(await cache.get(path, loader)).toEqual([{ call: 3 }])
    await appendFile(`${path}-wal`, '-updated')
    expect(await cache.get(path, loader)).toEqual([{ call: 4 }])
    await rm(`${path}-wal`)
    expect(await cache.get(path, loader)).toEqual([{ call: 5 }])

    // Keep size and mtime the same: inode/ctime must still detect replacement.
    const timestamp = new Date('2026-01-01T00:00:00.000Z')
    await utimes(path, timestamp, timestamp)
    await cache.get(path, loader)
    const beforeReplacement = calls
    const replacement = `${path}.replacement`
    await writeFile(replacement, 'fixture-updated')
    await utimes(replacement, timestamp, timestamp)
    await rename(replacement, path)
    expect(await cache.get(path, loader)).toEqual([{ call: beforeReplacement + 1 }])
    await rm(path)
    expect(await cache.get(path, loader)).toEqual([{ call: beforeReplacement + 2 }])
    await writeFile(path, 'fixture-updated')
    expect(await cache.get(path, loader)).toEqual([{ call: beforeReplacement + 3 }])
  })

  it('expires unchanged files after one second without extending the lifetime on hits', async () => {
    const path = await database()
    const cache = new ThreadListSupplementCache()
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const loader = vi.fn(() => [{ id: 'thread-1' }])
    await cache.get(path, loader)
    now.mockReturnValue(1_999)
    await cache.get(path, loader)
    expect(loader).toHaveBeenCalledTimes(1)
    now.mockReturnValue(2_000)
    await cache.get(path, loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('evicts the least recently used path at its result capacity', async () => {
    const paths = await Promise.all([database(), database(), database()])
    const cache = new ThreadListSupplementCache({ maxEntries: 2 })
    const loaders = paths.map((path) => vi.fn(() => [{ path }]))
    await cache.get(paths[0]!, loaders[0]!)
    await cache.get(paths[1]!, loaders[1]!)
    await cache.get(paths[0]!, loaders[0]!)
    await cache.get(paths[2]!, loaders[2]!)
    await cache.get(paths[0]!, loaders[0]!)
    await cache.get(paths[1]!, loaders[1]!)
    expect(loaders.map((loader) => loader.mock.calls.length)).toEqual([1, 2, 1])
  })

  it('shares a failed load but retries it on the next request', async () => {
    const path = await database()
    const cache = new ThreadListSupplementCache()
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('fixture query failed'))
      .mockResolvedValueOnce([{ id: 'recovered' }])
    const results = await Promise.allSettled([cache.get(path, loader), cache.get(path, loader)])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(loader).toHaveBeenCalledTimes(1)
    expect(await cache.get(path, loader)).toEqual([{ id: 'recovered' }])
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('does not let invalidated pending work cache data or clear its replacement', async () => {
    const path = await database()
    const cache = new ThreadListSupplementCache()
    const old = deferred<Array<Record<string, unknown>>>()
    const fresh = deferred<Array<Record<string, unknown>>>()
    const oldStarted = deferred<void>()
    const freshStarted = deferred<void>()
    const loader = vi.fn()
      .mockImplementationOnce(() => { oldStarted.resolve(); return old.promise })
      .mockImplementationOnce(() => { freshStarted.resolve(); return fresh.promise })
    const oldRead = cache.get(path, loader)
    await oldStarted.promise
    cache.invalidate(path)
    const freshRead = cache.get(path, loader)
    await freshStarted.promise
    old.resolve([{ id: 'old' }])
    await oldRead
    expect(cache.get(path, loader)).toBe(freshRead)
    fresh.resolve([{ id: 'fresh' }])
    expect(await freshRead).toEqual([{ id: 'fresh' }])
    expect(await cache.get(path, loader)).toEqual([{ id: 'fresh' }])
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
