import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANDROID_CONVERSATION_CACHE_LIMITS,
  isAndroidConversationCacheEnabled,
  isCurrentAndroidConversationCacheRecord,
  readAndroidConversationCache,
  writeAndroidConversationCache,
} from './androidConversationCache'

const globalScope = globalThis as unknown as Record<string, unknown>
const originalWindow = globalScope.window

afterEach(() => {
  vi.restoreAllMocks()
  if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
  else globalScope.window = originalWindow
})

describe('android conversation cache', () => {
  it('invalidates older render snapshots that lack message phase metadata', () => {
    expect(isCurrentAndroidConversationCacheRecord({})).toBe(false)
    expect(isCurrentAndroidConversationCacheRecord({ renderFormatVersion: 1 })).toBe(false)
    expect(isCurrentAndroidConversationCacheRecord({ renderFormatVersion: 2 })).toBe(true)
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
})
