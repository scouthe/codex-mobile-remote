/**
 * Typed, defensive adapter for the optional Android WebView bridge.
 *
 * The Android shell injects `window.CodexAndroid` at runtime. Keeping runtime
 * checks here lets the web UI remain usable in an ordinary browser and keeps
 * malformed bridge payloads from reaching the state layer.
 */

export const CODEX_ANDROID_EVENTS = {
  ready: 'codex-native-ready',
  share: 'codex-native-share',
  networkOnline: 'codex-native-network-online',
  networkOffline: 'codex-native-network-offline',
  pause: 'codex-native-pause',
  resume: 'codex-native-resume',
} as const

export type CodexAndroidEventName = (typeof CODEX_ANDROID_EVENTS)[keyof typeof CODEX_ANDROID_EVENTS]

export const CODEX_ANDROID_TASK_STATES = [
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'waiting_user_input',
  'steering',
  'completed',
  'failed',
  'canceled',
] as const

export type CodexAndroidTaskState = (typeof CODEX_ANDROID_TASK_STATES)[number]

export type CodexAndroidClientInfo = {
  clientId: string
  clientType: 'android'
  mode?: string
  version?: string
}

export type CodexAndroidShareFile = {
  uri: string
  name: string
  mimeType: string
}

export type CodexAndroidSharePayload = {
  text: string | null
  files: CodexAndroidShareFile[]
}

export type CodexAndroidSharedContent = {
  name: string
  mimeType: string
  base64: string
}

export type CodexAndroidContentError = {
  error: string
}

export type CodexAndroidTaskStateUpdate = {
  state: CodexAndroidTaskState
  title?: string
  detail?: string
}

/**
 * Methods are optional so the adapter can tolerate older shells that only
 * implemented part of the contract (and simple test doubles).
 */
export type CodexAndroidBridge = {
  getClientInfo?: () => string
  openSettings?: () => void
  copyText?: (text: string) => void
  setTaskState?: (state: string, title?: string, detail?: string) => void
  clearTaskState?: () => void
  getPendingShare?: () => string
  readSharedContent?: (uri: string) => string
  clearPendingShare?: () => void
}

declare global {
  interface Window {
    CodexAndroid?: CodexAndroidBridge
  }
}

const TASK_STATE_SET = new Set<string>(CODEX_ANDROID_TASK_STATES)
const MAX_TASK_STATE_LENGTH = 32
const MAX_TASK_TITLE_LENGTH = 120
const MAX_TASK_DETAIL_LENGTH = 240
const DEFAULT_SHARED_FILE_NAME = 'shared-file'
const DEFAULT_SHARED_MIME_TYPE = 'application/octet-stream'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown)
    } catch {
      return null
    }
  }
  return asRecord(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readTrimmedString(value: unknown): string | null {
  const text = readString(value)?.trim() ?? ''
  return text.length > 0 ? text : null
}

function truncateText(value: unknown, maxLength: number): string | undefined {
  const text = readString(value)?.trim() ?? ''
  return text.length > 0 ? text.slice(0, maxLength) : undefined
}

/** Return the canonical Android task state, or null for an unsupported value. */
export function normalizeTaskState(value: unknown): CodexAndroidTaskState | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim().toLowerCase()
  if (candidate === 'cancelled') return 'canceled'
  return TASK_STATE_SET.has(candidate) ? candidate as CodexAndroidTaskState : null
}

/**
 * Sanitize a task update before passing it to the Java bridge. The length
 * limits mirror the native shell's defensive truncation and avoid putting
 * arbitrary page content into a notification.
 */
export function formatTaskState(
  state: unknown,
  title?: unknown,
  detail?: unknown,
): CodexAndroidTaskStateUpdate | null {
  const normalizedState = normalizeTaskState(state)
  if (!normalizedState) return null

  const titleText = truncateText(title, MAX_TASK_TITLE_LENGTH)
  const detailText = truncateText(detail, MAX_TASK_DETAIL_LENGTH)
  return {
    state: normalizedState.slice(0, MAX_TASK_STATE_LENGTH) as CodexAndroidTaskState,
    ...(titleText ? { title: titleText } : {}),
    ...(detailText ? { detail: detailText } : {}),
  }
}

/** Parse the JSON string returned by `CodexAndroid.getClientInfo()`. */
export function parseClientInfo(value: unknown): CodexAndroidClientInfo | null {
  const record = parseJsonRecord(value)
  if (!record || readTrimmedString(record.clientType)?.toLowerCase() !== 'android') return null

  const clientId = readTrimmedString(record.clientId)
  if (!clientId) return null

  const mode = readTrimmedString(record.mode) ?? undefined
  const version = readTrimmedString(record.version) ?? undefined
  return {
    clientId,
    clientType: 'android',
    ...(mode ? { mode } : {}),
    ...(version ? { version } : {}),
  }
}

/**
 * Parse the JSON returned by `getPendingShare()`. Invalid file entries are
 * ignored; malformed top-level payloads return null so callers can retain
 * their ordinary browser flow.
 */
export function parseSharePayload(value: unknown): CodexAndroidSharePayload | null {
  const record = parseJsonRecord(value)
  if (!record) return null

  const rawText = record.text
  if (rawText !== null && rawText !== undefined && typeof rawText !== 'string') return null
  const text = typeof rawText === 'string' && rawText.trim().length > 0 ? rawText : null

  const files: CodexAndroidShareFile[] = []
  if (record.files !== undefined && !Array.isArray(record.files)) return null
  const seenUris = new Set<string>()
  for (const rawFile of (record.files as unknown[] | undefined) ?? []) {
    const file = asRecord(rawFile)
    const uri = readTrimmedString(file?.uri)
    if (!uri || seenUris.has(uri)) continue
    seenUris.add(uri)
    files.push({
      uri,
      name: readTrimmedString(file?.name) ?? DEFAULT_SHARED_FILE_NAME,
      mimeType: readTrimmedString(file?.mimeType) ?? DEFAULT_SHARED_MIME_TYPE,
    })
  }

  return { text, files }
}

/** Parse the JSON returned by `readSharedContent(uri)`. */
export function parseSharedContent(value: unknown): CodexAndroidSharedContent | CodexAndroidContentError | null {
  const record = parseJsonRecord(value)
  if (!record) return null

  const error = readTrimmedString(record.error)
  if (error) return { error }

  const name = readTrimmedString(record.name)
  const mimeType = readTrimmedString(record.mimeType)
  // Empty base64 is valid for an empty shared file, so do not trim/reject it.
  const base64 = readString(record.base64)
  if (!name || !mimeType || base64 === null) return null
  return { name, mimeType, base64 }
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

/**
 * Find the injected bridge without touching `window` during SSR/module load.
 * A supplied object is useful for tests and for WebView wrappers.
 */
export function getCodexAndroidBridge(scope?: unknown): CodexAndroidBridge | null {
  const root = scope === undefined
    ? (typeof window === 'undefined' ? undefined : window)
    : scope
  const rootRecord = asRecord(root)
  const candidate = asRecord(rootRecord?.CodexAndroid)
  if (!candidate) return null

  const bridge: CodexAndroidBridge = {}
  const methodNames: Array<keyof CodexAndroidBridge> = [
    'getClientInfo',
    'openSettings',
    'copyText',
    'setTaskState',
    'clearTaskState',
    'getPendingShare',
    'readSharedContent',
    'clearPendingShare',
  ]
  for (const methodName of methodNames) {
    const method = candidate[methodName]
    if (isFunction(method)) {
      ;(bridge as Record<string, unknown>)[methodName] = method.bind(candidate)
    }
  }

  return Object.keys(bridge).length > 0 ? bridge : null
}

export const CODEX_ANDROID_TASK_STATE_LIMITS = {
  state: MAX_TASK_STATE_LENGTH,
  title: MAX_TASK_TITLE_LENGTH,
  detail: MAX_TASK_DETAIL_LENGTH,
} as const
