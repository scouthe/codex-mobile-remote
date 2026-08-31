import { computed, ref } from 'vue'
import {
  CODEX_ANDROID_EVENTS,
  formatTaskState,
  getCodexAndroidBridge,
  parseClientInfo,
  parseSharedContent,
  parseSharePayload,
  type CodexAndroidBridge,
  type CodexAndroidClientInfo,
  type CodexAndroidEventName,
  type CodexAndroidSharePayload,
  type CodexAndroidTaskState,
} from '../native/codexAndroid'

/**
 * Maximum amount of data that the web side will materialise from a share
 * intent.  The native shell applies the same limit while reading the
 * ContentResolver stream; keeping a guard here protects browser test doubles
 * and older shells too.
 */
export const ANDROID_SHARED_FILE_LIMIT_BYTES = 20 * 1024 * 1024
/** Bound the aggregate materialised share payload when several files arrive. */
export const ANDROID_SHARED_BATCH_LIMIT_BYTES = 40 * 1024 * 1024

export type AndroidSharedFileReadResult =
  | { file: File; error?: undefined }
  | { file: null; error: string }

export type AndroidBridgeEventHandler = (event: CustomEvent<unknown>) => void

/** Decode a native base64 payload without relying on Node globals. */
export function decodeAndroidBase64(value: string): Uint8Array | null {
  if (typeof atob !== 'function') return null
  if (value.length > Math.ceil(ANDROID_SHARED_FILE_LIMIT_BYTES / 3) * 4 + 8) return null
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null

  try {
    const binary = atob(value)
    if (binary.length > ANDROID_SHARED_FILE_LIMIT_BYTES) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

/** Turn a parsed native share response into a browser File. */
export function sharedContentToFile(value: unknown): AndroidSharedFileReadResult {
  const parsed = parseSharedContent(value)
  if (!parsed) return { file: null, error: 'invalid-share-payload' }
  if ('error' in parsed) return { file: null, error: parsed.error || 'unreadable' }

  const bytes = decodeAndroidBase64(parsed.base64)
  if (!bytes) return { file: null, error: 'invalid-file-data' }

  try {
    // Copy into a plain ArrayBuffer.  TypeScript's DOM typings accept an
    // ArrayBuffer for BlobPart, while Uint8Array may be backed by a
    // SharedArrayBuffer in newer lib definitions.
    const fileBuffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(fileBuffer).set(bytes)
    return {
      file: new File([fileBuffer], parsed.name, {
        type: parsed.mimeType,
        lastModified: Date.now(),
      }),
    }
  } catch {
    return { file: null, error: 'file-constructor-unavailable' }
  }
}

function eventNameIsKnown(value: string): value is CodexAndroidEventName {
  return (Object.values(CODEX_ANDROID_EVENTS) as string[]).includes(value)
}

/**
 * Access the optional Android bridge from Vue code.  Every method is
 * best-effort: the same bundle runs in Chrome/PWA where the bridge does not
 * exist, and an older APK may implement only part of the contract.
 */
export function useAndroidBridge() {
  const bridgeRef = ref<CodexAndroidBridge | null>(null)
  const clientInfo = ref<CodexAndroidClientInfo | null>(null)
  const lastTaskState = ref<CodexAndroidTaskState | null>(null)
  const nativeAvailable = computed(() => bridgeRef.value !== null)

  function refresh(): CodexAndroidBridge | null {
    const nextBridge = getCodexAndroidBridge()
    bridgeRef.value = nextBridge
    if (!nextBridge?.getClientInfo) {
      clientInfo.value = null
      return nextBridge
    }

    try {
      clientInfo.value = parseClientInfo(nextBridge.getClientInfo())
    } catch {
      clientInfo.value = null
    }
    return nextBridge
  }

  function bridge(): CodexAndroidBridge | null {
    return bridgeRef.value ?? refresh()
  }

  function listen(name: CodexAndroidEventName, handler: AndroidBridgeEventHandler): () => void {
    if (typeof window === 'undefined' || !eventNameIsKnown(name)) return () => undefined
    const listener = (event: Event) => {
      if (typeof CustomEvent !== 'undefined' && event instanceof CustomEvent) {
        handler(event as CustomEvent<unknown>)
      } else if (typeof CustomEvent === 'function') {
        handler(new CustomEvent<unknown>(name))
      }
    }
    window.addEventListener(name, listener)
    return () => window.removeEventListener(name, listener)
  }

  function setTaskState(state: unknown, title?: unknown, detail?: unknown): boolean {
    const update = formatTaskState(state, title, detail)
    if (!update) return false
    const currentBridge = bridge()
    if (!currentBridge?.setTaskState) return false

    const fingerprint = JSON.stringify(update)
    if (fingerprint === lastTaskFingerprint) return true
    try {
      currentBridge.setTaskState(update.state, update.title, update.detail)
      // Keep the full fingerprint in a string slot without exposing another
      // public mutable ref.  The cast is intentionally local to this closure.
      lastTaskState.value = update.state
      lastTaskFingerprint = fingerprint
      return true
    } catch {
      return false
    }
  }

  // Titles/details can change while a command is running, so dedupe on the
  // complete payload rather than only on the state value.
  let lastTaskFingerprint = ''

  function clearTaskState(): void {
    const currentBridge = bridge()
    if (!currentBridge?.clearTaskState) return
    try {
      currentBridge.clearTaskState()
    } catch {
      // Native notifications are best-effort and must never break chat UI.
    }
    lastTaskState.value = null
    lastTaskFingerprint = ''
  }

  function getPendingShare(): CodexAndroidSharePayload | null {
    const currentBridge = bridge()
    if (!currentBridge?.getPendingShare) return null
    try {
      return parseSharePayload(currentBridge.getPendingShare())
    } catch {
      return null
    }
  }

  function readSharedContent(uri: string): AndroidSharedFileReadResult {
    const normalizedUri = uri.trim()
    const currentBridge = bridge()
    if (!normalizedUri || !currentBridge?.readSharedContent) {
      return { file: null, error: 'bridge-unavailable' }
    }
    try {
      return sharedContentToFile(currentBridge.readSharedContent(normalizedUri))
    } catch {
      return { file: null, error: 'unreadable' }
    }
  }

  function clearPendingShare(): void {
    const currentBridge = bridge()
    if (!currentBridge?.clearPendingShare) return
    try {
      currentBridge.clearPendingShare()
    } catch {
      // Ignore stale share intents from a detached WebView.
    }
  }

  function copyText(text: string): void {
    const currentBridge = bridge()
    if (!currentBridge?.copyText) return
    try {
      currentBridge.copyText(text)
    } catch {
      // Browser clipboard fallback remains available to callers.
    }
  }

  function openSettings(): void {
    const currentBridge = bridge()
    if (!currentBridge?.openSettings) return
    try {
      currentBridge.openSettings()
    } catch {
      // Ignore if the Activity is no longer attached.
    }
  }

  return {
    nativeAvailable,
    clientInfo,
    lastTaskState,
    refresh,
    listen,
    setTaskState,
    clearTaskState,
    getPendingShare,
    readSharedContent,
    clearPendingShare,
    copyText,
    openSettings,
  }
}
