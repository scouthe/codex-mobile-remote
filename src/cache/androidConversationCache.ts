import { getCodexAndroidBridge } from '../native/codexAndroid'
import type { UiMessage } from '../types/codex'

/**
 * A small, Android-only conversation snapshot cache.
 *
 * The browser bundle is shared with desktop and ordinary browsers.  The
 * bridge check is therefore part of this module's public contract: without
 * the Android WebView bridge every operation is a no-op.
 */
export type AndroidConversationCacheRecord = {
  threadId: string
  sessionRevision: string
  updatedAtIso: string
  hasMoreOlder: boolean
  messages: UiMessage[]
  savedAt: number
}

const DATABASE_NAME = 'codex-remote-android'
const DATABASE_VERSION = 1
const STORE_NAME = 'conversation-snapshots'
const MAX_CACHED_THREADS = 20
const MAX_CACHED_MESSAGES = 120
const MAX_TEXT_LENGTH = 200_000
const MAX_RAW_PAYLOAD_LENGTH = 64_000
const MAX_COMMAND_OUTPUT_LENGTH = 128_000

type StoredRecord = AndroidConversationCacheRecord & { key: string; origin: string }

function isAndroidWebView(scope?: unknown): boolean {
  return getCodexAndroidBridge(scope) !== null
}

function currentOrigin(): string {
  if (typeof window === 'undefined' || !window.location?.origin) return ''
  return window.location.origin
}

function cacheKey(origin: string, threadId: string): string {
  return `${origin}\u0000${threadId}`
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

function sanitizeMessage(message: UiMessage): UiMessage {
  const sanitized: UiMessage = {
    ...message,
    text: boundedText(message.text, MAX_TEXT_LENGTH) ?? '',
    rawPayload: boundedText(message.rawPayload, MAX_RAW_PAYLOAD_LENGTH),
  }
  if (message.commandExecution) {
    sanitized.commandExecution = {
      ...message.commandExecution,
      aggregatedOutput: boundedText(message.commandExecution.aggregatedOutput, MAX_COMMAND_OUTPUT_LENGTH) ?? '',
    }
  }
  return sanitized
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

function closeQuietly(database: IDBDatabase | null): void {
  try {
    database?.close()
  } catch {
    // Storage errors must never affect conversation loading.
  }
}

export function isAndroidConversationCacheEnabled(scope?: unknown): boolean {
  return isAndroidWebView(scope) && currentOrigin().length > 0
}

/** Read one cached snapshot. Returns null for browsers, missing data, or storage errors. */
export async function readAndroidConversationCache(threadId: string): Promise<AndroidConversationCacheRecord | null> {
  const origin = currentOrigin()
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId || !isAndroidWebView() || !origin) return null

  const database = await openDatabase()
  if (!database) return null
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(cacheKey(origin, normalizedThreadId))
      request.onsuccess = () => {
        const value = request.result as StoredRecord | undefined
        if (!value || value.origin !== origin || value.threadId !== normalizedThreadId) {
          resolve(null)
          return
        }
        resolve({
          threadId: value.threadId,
          sessionRevision: value.sessionRevision,
          updatedAtIso: value.updatedAtIso,
          hasMoreOlder: value.hasMoreOlder === true,
          messages: Array.isArray(value.messages) ? value.messages : [],
          savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
        })
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    } finally {
      // Closing after the request has completed is safe; browsers queue it
      // until active transactions finish.
      setTimeout(() => closeQuietly(database), 0)
    }
  })
}

/** Save a bounded snapshot. This operation is deliberately best-effort. */
export async function writeAndroidConversationCache(
  threadId: string,
  snapshot: Pick<AndroidConversationCacheRecord, 'sessionRevision' | 'updatedAtIso' | 'hasMoreOlder' | 'messages'>,
): Promise<void> {
  const origin = currentOrigin()
  const normalizedThreadId = threadId.trim()
  if (!normalizedThreadId || !isAndroidWebView() || !origin) return

  const database = await openDatabase()
  if (!database) return
  const messages = snapshot.messages
    .filter((message) => message.messageType !== 'userMessage.optimistic')
    .slice(-MAX_CACHED_MESSAGES)
    .map(sanitizeMessage)
  const record: StoredRecord = {
    key: cacheKey(origin, normalizedThreadId),
    origin,
    threadId: normalizedThreadId,
    sessionRevision: snapshot.sessionRevision.trim(),
    updatedAtIso: snapshot.updatedAtIso.trim(),
    hasMoreOlder: snapshot.hasMoreOlder === true,
    messages,
    savedAt: Date.now(),
  }

  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(record)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    } catch {
      resolve()
    } finally {
      setTimeout(() => closeQuietly(database), 0)
    }
  })

  // Keep storage bounded across threads. Failure to prune is harmless.
  const pruneDatabase = await openDatabase()
  if (!pruneDatabase) return
  await new Promise<void>((resolve) => {
    try {
      const transaction = pruneDatabase.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAll()
      request.onsuccess = () => {
        const records = (request.result as StoredRecord[])
          .filter((item) => item.origin === origin)
          .sort((a, b) => b.savedAt - a.savedAt)
        for (const stale of records.slice(MAX_CACHED_THREADS)) store.delete(stale.key)
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    } catch {
      resolve()
    } finally {
      setTimeout(() => closeQuietly(pruneDatabase), 0)
    }
  })
}

export async function clearAndroidConversationCache(): Promise<void> {
  if (!isAndroidWebView()) return
  const database = await openDatabase()
  if (!database) return
  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAll()
      request.onsuccess = () => {
        const origin = currentOrigin()
        for (const record of (request.result as StoredRecord[])) {
          if (record.origin === origin) store.delete(record.key)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    } catch {
      resolve()
    } finally {
      setTimeout(() => closeQuietly(database), 0)
    }
  })
}

export const ANDROID_CONVERSATION_CACHE_LIMITS = {
  maxThreads: MAX_CACHED_THREADS,
  maxMessagesPerThread: MAX_CACHED_MESSAGES,
} as const
