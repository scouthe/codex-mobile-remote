/** Coordinates refer to the visible video content, normalized to [0, 1]. */
export type PhonePoint = { x: number; y: number }
export type PhoneVideoFormat = { width: number; height: number; codec: string; epoch: number }
export type PhoneInput =
  | { type: 'tap'; point: PhonePoint; epoch: number }
  | { type: 'swipe'; from: PhonePoint; to: PhonePoint; duration: number; epoch: number }
  | { type: 'key'; key: 'back' | 'home' | 'recent' | 'enter' | 'delete' | 'wake' | 'sleep' }
  | { type: 'text'; text: string }

export type PhoneControlSession = {
  id: string
  deviceId: string
  previousRunId?: string
  purpose?: string
  stepLimit: number
}

export type PhoneControlState = { available: boolean; busy: boolean; message: string }

/** One-byte kind + uint32 BE payload length; bounded binary messages over authenticated HTTP. */
export const PHONE_VIDEO_FORMAT = 1
export const PHONE_VIDEO_DATA = 2
export const PHONE_VIDEO_ERROR = 3
export const PHONE_VIDEO_MAX_PACKET = 4 * 1024 * 1024
