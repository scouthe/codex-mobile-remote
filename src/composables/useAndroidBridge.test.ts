import { afterEach, describe, expect, it } from 'vitest'
import {
  ANDROID_SHARED_FILE_LIMIT_BYTES,
  decodeAndroidBase64,
  sharedContentToFile,
  useAndroidBridge,
} from './useAndroidBridge'

const globalScope = globalThis as unknown as Record<string, unknown>
const originalWindow = globalScope.window

afterEach(() => {
  if (originalWindow === undefined) Reflect.deleteProperty(globalScope, 'window')
  else globalScope.window = originalWindow
})

describe('useAndroidBridge', () => {
  it('deduplicates notification payloads and resets after clearing', () => {
    const updates: Array<{ state: string; title?: string; detail?: string }> = []
    let cleared = 0
    globalScope.window = {
      CodexAndroid: {
        getClientInfo: () => JSON.stringify({ clientId: 'android-test', clientType: 'android' }),
        setTaskState: (state: string, title?: string, detail?: string) => updates.push({ state, title, detail }),
        clearTaskState: () => { cleared += 1 },
      },
    }

    const bridge = useAndroidBridge()
    expect(bridge.nativeAvailable.value).toBe(false)
    bridge.refresh()
    expect(bridge.nativeAvailable.value).toBe(true)
    expect(bridge.clientInfo.value?.clientId).toBe('android-test')

    expect(bridge.setTaskState('running', 'Task', 'Working')).toBe(true)
    expect(bridge.setTaskState('running', 'Task', 'Working')).toBe(true)
    expect(bridge.setTaskState('running', 'Task', 'Working harder')).toBe(true)
    expect(updates).toHaveLength(2)

    bridge.clearTaskState()
    expect(cleared).toBe(1)
    bridge.setTaskState('running', 'Task', 'Working')
    expect(updates).toHaveLength(3)
  })

  it('decodes valid shared bytes while rejecting malformed or oversized payloads', async () => {
    expect(decodeAndroidBase64('aGVsbG8=')).toEqual(new Uint8Array([104, 101, 108, 108, 111]))
    expect(decodeAndroidBase64('not-base64')).toBeNull()

    const oversized = 'A'.repeat(Math.ceil(ANDROID_SHARED_FILE_LIMIT_BYTES / 3) * 4 + 16)
    expect(decodeAndroidBase64(oversized)).toBeNull()

    const result = sharedContentToFile({ name: 'hello.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' })
    expect(result.error).toBeUndefined()
    expect(result.file?.name).toBe('hello.txt')
    await expect(result.file?.text()).resolves.toBe('hello')
  })
})
