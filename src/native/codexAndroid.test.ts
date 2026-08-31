import { describe, expect, it } from 'vitest'
import {
  CODEX_ANDROID_EVENTS,
  CODEX_ANDROID_TASK_STATE_LIMITS,
  CODEX_ANDROID_TASK_STATES,
  formatTaskState,
  getCodexAndroidBridge,
  normalizeTaskState,
  parseClientInfo,
  parseSharedContent,
  parseSharePayload,
} from './codexAndroid'

describe('Codex Android bridge contract', () => {
  it('keeps the event names and task states aligned with the Android shell', () => {
    expect(CODEX_ANDROID_EVENTS).toEqual({
      ready: 'codex-native-ready',
      share: 'codex-native-share',
      networkOnline: 'codex-native-network-online',
      networkOffline: 'codex-native-network-offline',
      pause: 'codex-native-pause',
      resume: 'codex-native-resume',
    })
    expect(CODEX_ANDROID_TASK_STATES).toEqual([
      'queued',
      'starting',
      'running',
      'waiting_approval',
      'waiting_user_input',
      'steering',
      'completed',
      'failed',
      'canceled',
    ])
  })

  it('normalizes case, whitespace, and the British cancelled spelling', () => {
    expect(normalizeTaskState(' RUNNING ')).toBe('running')
    expect(normalizeTaskState('CANCELLED')).toBe('canceled')
    expect(normalizeTaskState('waiting_user_input')).toBe('waiting_user_input')
    expect(normalizeTaskState('in_progress')).toBeNull()
    expect(normalizeTaskState(null)).toBeNull()
  })

  it('formats bounded notification updates and rejects unknown states', () => {
    const title = `  ${'t'.repeat(CODEX_ANDROID_TASK_STATE_LIMITS.title + 10)}  `
    const detail = `  ${'d'.repeat(CODEX_ANDROID_TASK_STATE_LIMITS.detail + 10)}  `
    expect(formatTaskState('failed', title, detail)).toEqual({
      state: 'failed',
      title: 't'.repeat(CODEX_ANDROID_TASK_STATE_LIMITS.title),
      detail: 'd'.repeat(CODEX_ANDROID_TASK_STATE_LIMITS.detail),
    })
    expect(formatTaskState('completed', '  ', null)).toEqual({ state: 'completed' })
    expect(formatTaskState('waiting-approval', 'x', 'y')).toBeNull()
  })

  it('parses and validates client info returned as a bridge JSON string', () => {
    expect(parseClientInfo(JSON.stringify({
      clientId: '  android-client-1 ',
      clientType: 'ANDROID',
      mode: ' remote-observer ',
      version: ' 0.2.0 ',
    }))).toEqual({
      clientId: 'android-client-1',
      clientType: 'android',
      mode: 'remote-observer',
      version: '0.2.0',
    })
    expect(parseClientInfo('{bad json')).toBeNull()
    expect(parseClientInfo({ clientId: 'x', clientType: 'ios' })).toBeNull()
    expect(parseClientInfo({ clientType: 'android' })).toBeNull()
  })

  it('parses share payloads, applies safe defaults, and deduplicates URIs', () => {
    expect(parseSharePayload(JSON.stringify({
      text: '  hello  ',
      files: [
        { uri: 'content://one', name: 'one.txt', mimeType: 'text/plain' },
        { uri: ' content://one ', name: 'duplicate' },
        { uri: 'content://two', name: '', mimeType: '' },
        { name: 'missing-uri' },
      ],
    }))).toEqual({
      text: '  hello  ',
      files: [
        { uri: 'content://one', name: 'one.txt', mimeType: 'text/plain' },
        { uri: 'content://two', name: 'shared-file', mimeType: 'application/octet-stream' },
      ],
    })
    expect(parseSharePayload({ text: null, files: [] })).toEqual({ text: null, files: [] })
    expect(parseSharePayload({ text: 42, files: [] })).toBeNull()
    expect(parseSharePayload({ text: null, files: {} })).toBeNull()
    expect(parseSharePayload('not-json')).toBeNull()
  })

  it('parses shared file content and accepts empty files', () => {
    expect(parseSharedContent(JSON.stringify({
      name: 'empty.txt',
      mimeType: 'text/plain',
      base64: '',
    }))).toEqual({ name: 'empty.txt', mimeType: 'text/plain', base64: '' })
    expect(parseSharedContent({ error: 'file-too-large' })).toEqual({ error: 'file-too-large' })
    expect(parseSharedContent({ name: 'x', mimeType: 'text/plain' })).toBeNull()
    expect(parseSharedContent('{bad json')).toBeNull()
  })

  it('discovers only callable bridge methods and keeps their receiver', () => {
    const calls: string[] = []
    const fake = {
      prefix: 'fake',
      copyText(text: string) {
        calls.push(`${this.prefix}:${text}`)
      },
      getClientInfo: 'not-a-function',
    }
    const bridge = getCodexAndroidBridge({ CodexAndroid: fake })
    expect(bridge).not.toBeNull()
    expect(bridge?.getClientInfo).toBeUndefined()
    bridge?.copyText?.('hello')
    expect(calls).toEqual(['fake:hello'])
    expect(getCodexAndroidBridge({ CodexAndroid: { copyText: 1 } })).toBeNull()
    expect(getCodexAndroidBridge(undefined)).toBeNull()
  })
})

