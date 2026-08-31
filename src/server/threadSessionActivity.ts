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
  lastEventAt: number | null
  /** Stable marker for the observed file revision (size/mtime/last event). */
  revision: string
}

type CachedActivity = {
  size: number
  mtimeMs: number
  activity: ThreadSessionActivity
  /** Start offset for the next append scan. */
  scanOffset: number
}

const SESSION_TAIL_BYTES = 4 * 1024 * 1024
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

async function readSessionTail(path: string, size: number): Promise<string> {
  return await readSessionRange(path, Math.max(0, size - SESSION_TAIL_BYTES), size)
}

async function readSessionRange(path: string, start: number, end: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const safeStart = Math.max(0, Math.trunc(start))
    const safeEnd = Math.max(safeStart, Math.trunc(end))
    const length = safeEnd - safeStart
    if (length <= 0) return ''
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await file.read(buffer, 0, length, safeStart)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

function unknownActivity(revision = ''): ThreadSessionActivity {
  return {
    known: false,
    inProgress: false,
    turnId: '',
    terminalTurnId: '',
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
        lastEventAt: eventAt,
      }
      continue
    }
    if (TERMINAL_EVENT_TYPES.has(eventType)) {
      activity = {
        known: true,
        inProgress: false,
        turnId: '',
        terminalTurnId: readString(event, 'turn_id', 'turnId') || activity.turnId,
        lastEventAt: eventAt ?? activity.lastEventAt,
      }
    }
  }

  return activity
}

export class ThreadSessionActivityReader {
  private readonly cache = new Map<string, CachedActivity>()

  async read(path: string): Promise<ThreadSessionActivity> {
    const normalizedPath = path.trim()
    if (!normalizedPath) return unknownActivity()

    try {
      // A stat first avoids opening directories and lets us skip rereading a
      // large session file when the desktop task has not appended anything.
      const metadata = await stat(normalizedPath)
      if (!metadata.isFile()) return unknownActivity()
      const metadataRevision = `${Math.max(0, Math.trunc(metadata.size))}:${Math.max(0, Math.trunc(metadata.mtimeMs))}`
      const cached = this.cache.get(normalizedPath)
      if (cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
        return cached.activity
      }
      if (metadata.mtimeMs < Date.now() - SESSION_ACTIVITY_SCAN_WINDOW_MS) {
        // An old log can tell us nothing reliable about a currently running
        // process.  Preserve the distinction between unknown and an explicit
        // terminal marker so callers do not clear a fresh app-server status.
        const activity = unknownActivity(`${metadataRevision}:stale`)
        this.cache.set(normalizedPath, {
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          activity,
          scanOffset: metadata.size,
        })
        return activity
      }
      let parsed: Omit<ThreadSessionActivity, 'revision'>
      const canScanAppend = Boolean(
        cached
        && metadata.size >= cached.size
        && metadata.mtimeMs >= cached.mtimeMs
        && cached.activity.known,
      )
      if (canScanAppend && cached) {
        // Session logs are append-only.  Retain the last known marker state
        // and parse only new bytes; otherwise a verbose task can push its
        // original task_started record out of the tail and look unknown.
        const delta = parseSessionActivity(await readSessionRange(
          normalizedPath,
          Math.max(0, Math.min(cached.scanOffset, metadata.size)),
          metadata.size,
        ), cached.activity)
        parsed = delta
      } else {
        parsed = parseSessionActivity(await readSessionTail(normalizedPath, metadata.size))
        if (!parsed.known) {
          // The marker can be far from the tail in a long-running session.
          // This full scan happens only once per file revision; subsequent
          // appends use the incremental path above.
          parsed = parseSessionActivity(await readFile(normalizedPath, 'utf8'))
        }
      }
      const revision = `${metadataRevision}:${parsed.lastEventAt ?? ''}`
      const activity: ThreadSessionActivity = { ...parsed, revision }
      this.cache.set(normalizedPath, {
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        activity,
        // Session writes are JSONL records and Codex appends complete records
        // in one write.  Start the next scan exactly at the previous EOF so
        // old terminal markers cannot overwrite a newer active state.  A
        // partial final record is ignored and will be recovered by the next
        // revision read once Codex appends its newline.
        scanOffset: metadata.size,
      })
      return activity
    } catch {
      return unknownActivity()
    }
  }
}

export async function readThreadSessionActivity(path: string): Promise<ThreadSessionActivity> {
  return await new ThreadSessionActivityReader().read(path)
}
