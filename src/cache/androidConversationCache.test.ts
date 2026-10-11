import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANDROID_CONVERSATION_CACHE_LIMITS,
  boundAndroidConversationMessages,
  clearAndroidConversationCache,
  isAndroidConversationCacheEnabled,
  isCurrentAndroidConversationCacheRecord,
  readAndroidConversationCache,
  writeAndroidConversationCache,
} from './androidConversationCache'
import type { UiMessage } from '../types/codex'

const globalScope = globalThis as unknown as Record<string, unknown>
const originalWindow = globalScope.window

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
  else globalScope.window = originalWindow
})

function message(id: number, overrides: Partial<UiMessage> = {}): UiMessage {
  return { id: `message-${id}`, role: 'assistant', text: `Message ${id}`, turnId: `turn-${id}`, ...overrides }
}

function installAndroidWindow(origin = 'https://example.test'): void {
  globalScope.window = {
    location: { origin },
    CodexAndroid: { getClientInfo: () => JSON.stringify({ clientId: 'android-1', clientType: 'android' }) },
  }
}

/** Memory-only IndexedDB adapter: exercise the public read/write contract without browser storage. */
function installMemoryDatabase() {
  const records = new Map<string, { key: string; renderFormatVersion: number }>()
  const database = {
    close: vi.fn(),
    transaction() {
      const transaction = {
        oncomplete: null as (() => void) | null,
        objectStore: () => ({
          put(record: { key: string; renderFormatVersion: number }) {
            records.set(record.key, structuredClone(record))
            queueMicrotask(() => transaction.oncomplete?.())
          },
          get(key: string) {
            const request = { result: records.get(key), onsuccess: null as (() => void) | null }
            queueMicrotask(() => request.onsuccess?.())
            return request
          },
          getAll() {
            const request = { result: [...records.values()], onsuccess: null as (() => void) | null }
            queueMicrotask(() => {
              request.onsuccess?.()
              transaction.oncomplete?.()
            })
            return request
          },
          delete(key: string) { records.delete(key) },
        }),
      }
      return transaction
    },
  }
  vi.stubGlobal('indexedDB', {
    open() {
      const request = { result: database, onsuccess: null as (() => void) | null }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
  })
  return records
}

describe('android conversation cache', () => {
  it('invalidates older snapshots without reliable completeness metadata', () => {
    expect(isCurrentAndroidConversationCacheRecord({})).toBe(false)
    expect(isCurrentAndroidConversationCacheRecord({ renderFormatVersion: 1 })).toBe(false)
    expect(isCurrentAndroidConversationCacheRecord({ renderFormatVersion: 2 })).toBe(false)
    expect(isCurrentAndroidConversationCacheRecord({ renderFormatVersion: 3 })).toBe(true)
  })

  it('keeps enough cached rows for several mobile history pages', () => {
    expect(ANDROID_CONVERSATION_CACHE_LIMITS.maxMessagesPerThread).toBe(200)
  })

  it('stays disabled in ordinary browsers', async () => {
    globalScope.window = { location: { origin: 'https://example.test' } }

    expect(isAndroidConversationCacheEnabled()).toBe(false)
    await expect(readAndroidConversationCache('thread-1')).resolves.toBeNull()
    await expect(writeAndroidConversationCache('thread-1', {
      sessionRevision: 'rev-1',
      updatedAtIso: '2026-09-11T00:00:00.000Z',
      hasMoreOlder: false,
      messages: [],
    })).resolves.toBeUndefined()
  })

  it('is enabled only when the Android bridge is injected', () => {
    globalScope.window = {
      location: { origin: 'https://example.test' },
      CodexAndroid: {
        getClientInfo: () => JSON.stringify({ clientId: 'android-1', clientType: 'android' }),
      },
    }

    expect(isAndroidConversationCacheEnabled()).toBe(true)
  })

  it('retains the latest 200 persisted rows and leaves whole older turns pageable', () => {
    const messages = Array.from({ length: 205 }, (_, index) => message(index))
    messages.push(message(205, { messageType: 'userMessage.optimistic' }))
    const bounded = boundAndroidConversationMessages(messages)

    expect(bounded.messages.map((item) => item.id)).toEqual(messages.slice(5, 205).map((item) => item.id))
    expect(bounded.hasDroppedMessages).toBe(true)
    expect(bounded.requiresHydration).toBe(false)
    expect(messages).toHaveLength(206)
  })

  it('requires hydration when the retained suffix starts within a turn', () => {
    const messages = Array.from({ length: 201 }, (_, index) => message(index, { turnId: 'same-turn' }))
    expect(boundAndroidConversationMessages(messages)).toMatchObject({
      hasDroppedMessages: true,
      requiresHydration: true,
    })
  })

  it('marks clipped text, payloads and command output incomplete without mutating the source', () => {
    const original = message(1, {
      text: 't'.repeat(64_001),
      rawPayload: 'r'.repeat(16_001),
      commandExecution: {
        command: 'example', cwd: null, status: 'completed', exitCode: 0,
        aggregatedOutput: 'o'.repeat(32_001),
      },
    })
    const bounded = boundAndroidConversationMessages([original])
    expect(bounded.requiresHydration).toBe(true)
    expect(bounded.hasDroppedMessages).toBe(false)
    expect(bounded.messages[0]?.text).toHaveLength(64_000)
    expect(bounded.messages[0]?.rawPayload).toHaveLength(16_000)
    expect(bounded.messages[0]?.commandExecution?.aggregatedOutput).toHaveLength(32_000)
    expect(original.text).toHaveLength(64_001)
    expect(original.commandExecution?.aggregatedOutput).toHaveLength(32_001)
    expect(boundAndroidConversationMessages([message(2)])).toMatchObject({ requiresHydration: false, hasDroppedMessages: false })
  })

  it('uses the UTF-8 JSON size including escapes and array punctuation at the exact boundary', () => {
    const messages = [message(1, { text: '汉😀\\\"\n' }), message(2, { text: '汉😀\\\"\n' })]
    const exactBytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength
    expect(boundAndroidConversationMessages(messages, exactBytes).messages).toEqual(messages)
    const bounded = boundAndroidConversationMessages(messages, exactBytes - 1)
    expect(bounded.messages.map((item) => item.id)).toEqual(['message-2'])
    expect(bounded.hasDroppedMessages).toBe(true)
  })

  it('never exceeds the budget for a single row with oversized unbounded metadata', () => {
    const oversized = message(2, { images: ['x'.repeat(ANDROID_CONVERSATION_CACHE_LIMITS.maxBytesPerThread)] })
    expect(boundAndroidConversationMessages([message(1), oversized])).toEqual({
      messages: [], hasDroppedMessages: true, requiresHydration: true,
    })
  })

  it('persists pagination and completeness flags and bounds the whole stored UTF-8 record', async () => {
    installAndroidWindow()
    const records = installMemoryDatabase()
    const snapshot = {
      sessionRevision: 'rev-1', updatedAtIso: '2026-10-11T00:00:00Z', hasMoreOlder: false,
      messages: Array.from({ length: 200 }, (_, index) => message(index, { text: '汉😀'.repeat(12_800) })),
    }
    await writeAndroidConversationCache('thread-1', snapshot)
    const restored = await readAndroidConversationCache('thread-1')
    expect(restored?.hasMoreOlder).toBe(true)
    expect(restored?.requiresHydration).toBe(false)
    expect(restored?.messages.at(-1)?.id).toBe('message-199')
    expect(new TextEncoder().encode(JSON.stringify([...records.values()][0])).byteLength)
      .toBeLessThanOrEqual(ANDROID_CONVERSATION_CACHE_LIMITS.maxBytesPerThread)

    await writeAndroidConversationCache('thread-2', { ...snapshot, messages: [message(1, { text: 'x'.repeat(64_001) })] })
    expect(await readAndroidConversationCache('thread-2')).toMatchObject({ requiresHydration: true, hasMoreOlder: false })
  })

  it('isolates identical thread IDs by origin and clears only the current origin', async () => {
    installMemoryDatabase()
    const snapshot = { sessionRevision: 'rev-1', updatedAtIso: '', hasMoreOlder: false, messages: [message(1)] }
    installAndroidWindow('https://a.test')
    await writeAndroidConversationCache('same-thread', snapshot)
    installAndroidWindow('https://b.test')
    expect(await readAndroidConversationCache('same-thread')).toBeNull()
    await writeAndroidConversationCache('same-thread', { ...snapshot, messages: [message(2)] })
    await clearAndroidConversationCache()
    expect(await readAndroidConversationCache('same-thread')).toBeNull()
    installAndroidWindow('https://a.test')
    expect((await readAndroidConversationCache('same-thread'))?.messages[0]?.id).toBe('message-1')
  })

  it('preserves incompleteness when a previously clipped snapshot is written again', async () => {
    installAndroidWindow()
    installMemoryDatabase()
    const snapshot = { sessionRevision: 'rev-1', updatedAtIso: '', hasMoreOlder: false, messages: [message(1, { text: 'x'.repeat(64_001) })] }
    await writeAndroidConversationCache('thread-1', snapshot)
    const restored = await readAndroidConversationCache('thread-1')
    expect(restored?.requiresHydration).toBe(true)
    await writeAndroidConversationCache('thread-1', { ...snapshot, messages: restored!.messages, requiresHydration: restored!.requiresHydration })
    expect((await readAndroidConversationCache('thread-1'))?.requiresHydration).toBe(true)
    await writeAndroidConversationCache('thread-1', { ...snapshot, messages: [message(1)], requiresHydration: false })
    expect((await readAndroidConversationCache('thread-1'))?.requiresHydration).toBe(false)
  })

  it('rejects old records and preserves a good snapshot when serialization fails', async () => {
    installAndroidWindow()
    const records = installMemoryDatabase()
    const snapshot = { sessionRevision: 'rev-1', updatedAtIso: '', hasMoreOlder: false, messages: [message(1)] }
    await writeAndroidConversationCache('thread-1', snapshot)
    const unserializable = message(2, { images: [] })
    Reflect.set(unserializable, 'cycle', unserializable)
    await expect(writeAndroidConversationCache('thread-1', { ...snapshot, messages: [unserializable] })).resolves.toBeUndefined()
    expect((await readAndroidConversationCache('thread-1'))?.messages[0]?.id).toBe('message-1')
    const stored = [...records.values()][0]!
    stored.renderFormatVersion = 2
    expect(await readAndroidConversationCache('thread-1')).toBeNull()
  })
})
