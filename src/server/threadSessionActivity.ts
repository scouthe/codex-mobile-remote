import { open, readFile, stat } from 'node:fs/promises'

/**
 * A small read-only view of the activity marker written by the Codex CLI.
 *
 * The desktop app-server and codexapp may be separate processes.  In that
 * setup the app-server notification stream is not shared, but both clients
 * still see the same JSONL session file.  We inspect only marker records and
 * never expose the session contents over HTTP.
 */
export type ThreadSessionActivity = {
  /** Whether the session log contained a definitive start/terminal marker. */
  known: boolean
  inProgress: boolean
  turnId: string
  /** Turn identified by the most recent terminal marker, when available. */
  terminalTurnId: string
  /** Terminal outcome recorded by the session writer, when known. */
  terminalState?: 'completed' | 'failed' | 'canceled' | ''
  /** Human-readable failure reason recorded alongside a failed marker. */
  terminalError?: string
  lastEventAt: number | null
  /** Stable marker for the observed file revision (size/mtime/last event). */
  revision: string
}

type CachedActivity = {
  size: number
  mtimeMs: number
  ctimeMs: number
  dev: number
  ino: number
  activity: ThreadSessionActivity
  /** Byte after the last complete JSONL record, not necessarily the EOF. */
  scanOffset: number
  scanAnchor: Buffer
  /** False for stale files that were deliberately never scanned. */
  canScanAppend: boolean
}

const SESSION_TAIL_BYTES = 4 * 1024 * 1024
const MAX_CACHED_SESSION_ACTIVITIES = 512
const APPEND_ANCHOR_BYTES = 64
// A running Codex task appends to its session log regularly.  Avoid opening
// hundreds of historical multi-megabyte logs on the first list request while
// still covering long-running tasks and laptops that sleep overnight.
const SESSION_ACTIVITY_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000
const TERMINAL_EVENT_TYPES = new Set([
  'task_complete',
  'task_completed',
  'turn_aborted',
  'turn_complete',
  'turn_completed',
  'task_failed',
])

const START_EVENT_TYPES = new Set([
  'task_started',
  // Some app-server versions use the v2 spelling while persisting the same
  // event to the session log.
  'turn_started',
])

function readString(record: Record<string, unknown> | null, ...keys: string[]): string {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function readErrorMessage(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  return readString(record, 'message', 'reason', 'detail') || readErrorMessage(record.error)
}

function readTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Codex event timestamps are normally ISO strings, but tolerate epoch
    // milliseconds and epoch seconds in older session formats.
    return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value)
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function readSessionRange(path: string, start: number, end: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const safeStart = Math.max(0, Math.trunc(start))
    const safeEnd = Math.max(safeStart, Math.trunc(end))
    const length = safeEnd - safeStart
    if (length <= 0) return Buffer.alloc(0)
    const buffer = Buffer.allocUnsafe(length)
    let totalBytesRead = 0
    while (totalBytesRead < length) {
      const { bytesRead } = await file.read(buffer, totalBytesRead, length - totalBytesRead, safeStart + totalBytesRead)
      if (bytesRead === 0) break
      totalBytesRead += bytesRead
    }
    return buffer.subarray(0, totalBytesRead)
  } finally {
    await file.close()
  }
}

function scanCompleteRecords(
  bytes: Buffer,
  start: number,
  contentStart: number,
  initial?: Omit<ThreadSessionActivity, 'revision'>,
): Pick<CachedActivity, 'scanOffset' | 'scanAnchor'> & { parsed: Omit<ThreadSessionActivity, 'revision'> } {
  const completeEnd = bytes.lastIndexOf(0x0a) + 1
  return {
    parsed: parseSessionActivity(bytes.subarray(Math.min(contentStart, completeEnd), completeEnd).toString('utf8'), initial),
    scanOffset: start + completeEnd,
    // Copy the small anchor so the cache does not retain the full read buffer.
    scanAnchor: Buffer.from(bytes.subarray(Math.max(0, completeEnd - APPEND_ANCHOR_BYTES), completeEnd)),
  }
}

function unknownActivity(revision = ''): ThreadSessionActivity {
  return {
    known: false,
    inProgress: false,
    turnId: '',
    terminalTurnId: '',
    terminalState: '',
    terminalError: '',
    lastEventAt: null,
    revision,
  }
}

function parseSessionActivity(
  raw: string,
  initial?: Omit<ThreadSessionActivity, 'revision'>,
): Omit<ThreadSessionActivity, 'revision'> {
  let activity: Omit<ThreadSessionActivity, 'revision'> = initial ?? {
    known: false,
    inProgress: false,
    turnId: '',
    terminalTurnId: '',
    terminalState: '',
    terminalError: '',
    lastEventAt: null,
  }
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      entry = parsed as Record<string, unknown>
    } catch {
      // The first line may be partial when the tail starts in the middle of
      // a large JSONL record.  Ignore it and continue with complete lines.
      continue
    }

    const payload = entry.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    const event = payload as Record<string, unknown>
    if (entry.type !== 'event_msg') continue
    const eventType = readString(event, 'type')
    if (!eventType) continue
    const eventAt = readTimestamp(entry.timestamp)
    if (START_EVENT_TYPES.has(eventType)) {
      activity = {
        known: true,
        inProgress: true,
        turnId: readString(event, 'turn_id', 'turnId'),
        terminalTurnId: '',
        terminalState: '',
        terminalError: '',
        lastEventAt: eventAt,
      }
      continue
    }
    if (TERMINAL_EVENT_TYPES.has(eventType)) {
      const eventStatus = readString(event, 'status', 'state').toLowerCase()
      const eventError = readErrorMessage(event.error) || readErrorMessage(event)
      const terminalState = eventType === 'task_failed' || eventStatus === 'failed' || Boolean(eventError)
        ? 'failed'
        : eventType === 'turn_aborted' || eventStatus === 'interrupted' || eventStatus === 'canceled' || eventStatus === 'cancelled'
          ? 'canceled'
          : 'completed'
      activity = {
        known: true,
        inProgress: false,
        turnId: '',
        terminalTurnId: readString(event, 'turn_id', 'turnId') || activity.turnId,
        terminalState,
        terminalError: terminalState === 'failed' ? eventError : '',
        lastEventAt: eventAt ?? activity.lastEventAt,
      }
    }
  }

  return activity
}

export class ThreadSessionActivityReader {
  private readonly cache = new Map<string, CachedActivity>()
  private readonly inFlight = new Map<string, Promise<ThreadSessionActivity>>()

  read(path: string): Promise<ThreadSessionActivity> {
    const normalizedPath = path.trim()
    if (!normalizedPath) return Promise.resolve(unknownActivity())
    const existing = this.inFlight.get(normalizedPath)
    if (existing) return existing

    // Coalesce stat as well as file reads, but only while a read is in flight.
    // A later caller always stats again and observes newly appended records.
    const pending = this.readCurrent(normalizedPath).finally(() => {
      if (this.inFlight.get(normalizedPath) === pending) this.inFlight.delete(normalizedPath)
    })
    this.inFlight.set(normalizedPath, pending)
    return pending
  }

  private remember(path: string, value: CachedActivity): void {
    this.cache.delete(path)
    this.cache.set(path, value)
    while (this.cache.size > MAX_CACHED_SESSION_ACTIVITIES) {
      const oldestPath = this.cache.keys().next().value
      if (oldestPath === undefined) break
      this.cache.delete(oldestPath)
    }
  }

  private async readCurrent(normalizedPath: string): Promise<ThreadSessionActivity> {
    try {
      // A stat first avoids opening directories and lets us skip rereading a
      // large session file when the desktop task has not appended anything.
      const metadata = await stat(normalizedPath)
      if (!metadata.isFile()) {
        this.cache.delete(normalizedPath)
        return unknownActivity()
      }
      const metadataRevision = `${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.dev}:${metadata.ino}`
      const cached = this.cache.get(normalizedPath)
      if (metadata.mtimeMs < Date.now() - SESSION_ACTIVITY_SCAN_WINDOW_MS) {
        // An old log can tell us nothing reliable about a currently running
        // process.  Preserve the distinction between unknown and an explicit
        // terminal marker so callers do not clear a fresh app-server status.
        const activity = unknownActivity(`${metadataRevision}:stale`)
        this.remember(normalizedPath, {
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          ctimeMs: metadata.ctimeMs,
          dev: metadata.dev,
          ino: metadata.ino,
          activity,
          scanOffset: 0,
          scanAnchor: Buffer.alloc(0),
          canScanAppend: false,
        })
        return activity
      }
      const sameFile = cached && cached.dev === metadata.dev && cached.ino === metadata.ino
      if (sameFile && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs && cached.ctimeMs === metadata.ctimeMs) {
        this.remember(normalizedPath, cached)
        return cached.activity
      }
      let scanned: ReturnType<typeof scanCompleteRecords> | undefined
      const canScanAppend = Boolean(
        sameFile
        && cached.canScanAppend
        && metadata.size > cached.size
        && metadata.mtimeMs >= cached.mtimeMs
      )
      if (canScanAppend && cached) {
        // Session logs are append-only.  Retain the last known marker state
        // and parse only new bytes; otherwise a verbose task can push its
        // original task_started record out of the tail and look unknown.
        const start = cached.scanOffset - cached.scanAnchor.length
        const bytes = await readSessionRange(normalizedPath, start, metadata.size)
        if (bytes.subarray(0, cached.scanAnchor.length).equals(cached.scanAnchor)) {
          scanned = scanCompleteRecords(bytes, start, cached.scanAnchor.length, cached.activity)
        }
      }
      if (!scanned) {
        const start = Math.max(0, metadata.size - SESSION_TAIL_BYTES)
        const bytes = await readSessionRange(normalizedPath, start, metadata.size)
        // A nonzero tail offset can start inside a record. Discard that first
        // fragment; a missing marker below triggers one complete scan.
        scanned = scanCompleteRecords(bytes, start, start > 0 ? bytes.indexOf(0x0a) + 1 : 0)
        if (!scanned.parsed.known && start > 0) {
          // Remember a completed scan even when it finds no activity marker.
          // Later appends then inspect only new bytes, not the entire file.
          const allBytes = await readFile(normalizedPath)
          scanned = scanCompleteRecords(allBytes.subarray(0, metadata.size), 0, 0)
        }
      }
      const parsed = scanned.parsed
      const revision = `${metadataRevision}:${parsed.lastEventAt ?? ''}`
      const activity: ThreadSessionActivity = { ...parsed, revision }
      this.remember(normalizedPath, {
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        dev: metadata.dev,
        ino: metadata.ino,
        activity,
        scanOffset: scanned.scanOffset,
        scanAnchor: scanned.scanAnchor,
        canScanAppend: true,
      })
      return activity
    } catch {
      this.cache.delete(normalizedPath)
      return unknownActivity()
    }
  }
}

export async function readThreadSessionActivity(path: string): Promise<ThreadSessionActivity> {
  return await new ThreadSessionActivityReader().read(path)
}
