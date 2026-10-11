import { stat } from 'node:fs/promises'

type ThreadListSupplement = Array<Record<string, unknown>>

type CacheEntry = {
  revision: string
  expiresAt: number
  rows: ThreadListSupplement
}

async function fileRevision(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true })
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
    throw error
  }
}

/** Cache the SQLite supplement, including changes committed only to its WAL. */
export class ThreadListSupplementCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly pending = new Map<string, Promise<ThreadListSupplement>>()
  private readonly maxEntries: number
  private readonly maxAgeMs: number

  constructor(options: { maxEntries?: number; maxAgeMs?: number } = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 8))
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? 1_000)
  }

  get(path: string, loader: () => ThreadListSupplement | Promise<ThreadListSupplement>): Promise<ThreadListSupplement> {
    const existing = this.pending.get(path)
    if (existing) return existing

    const request: Promise<ThreadListSupplement> = Promise.resolve().then(async (): Promise<ThreadListSupplement> => {
      // Share the metadata probes too: simultaneous clients should not each
      // perform their own pair of stats before discovering a pending load.
      const revision = (await Promise.all([fileRevision(path), fileRevision(`${path}-wal`)])).join('|')
      const ownsPending = this.pending.get(path) === request
      const cached = ownsPending ? this.entries.get(path) : undefined
      if (cached && cached.revision === revision && cached.expiresAt > Date.now()) {
        this.entries.delete(path)
        this.entries.set(path, cached)
        return cached.rows
      }

      if (ownsPending) this.entries.delete(path)
      const rows = await loader()
      if (this.pending.get(path) === request) {
        this.entries.set(path, { revision, rows, expiresAt: Date.now() + this.maxAgeMs })
        while (this.entries.size > this.maxEntries) {
          const oldestPath = this.entries.keys().next().value
          if (oldestPath !== undefined) this.entries.delete(oldestPath)
        }
      }
      return rows
    }).finally(() => {
      if (this.pending.get(path) === request) this.pending.delete(path)
    })
    this.pending.set(path, request)
    return request
  }

  invalidate(path?: string): void {
    if (path === undefined) {
      this.entries.clear()
      this.pending.clear()
      return
    }
    this.entries.delete(path)
    this.pending.delete(path)
  }
}
