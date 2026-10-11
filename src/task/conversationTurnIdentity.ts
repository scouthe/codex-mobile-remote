import type { UiMessage } from '../types/codex'

/** Stable turn keys for paged messages, with legacy index-only rows supported. */
export function buildConversationTurnKeys(messages: UiMessage[]): Map<string, string> {
  const turnIdByIndex = new Map<number, string>()
  const ambiguousIndices = new Set<number>()
  for (const message of messages) {
    const turnId = message.turnId?.trim()
    const index = message.turnIndex
    if (!turnId || typeof index !== 'number' || !Number.isFinite(index)) continue
    const previous = turnIdByIndex.get(index)
    if (previous && previous !== turnId) ambiguousIndices.add(index)
    turnIdByIndex.set(index, turnId)
  }

  const keys = new Map<string, string>()
  for (const message of messages) {
    const turnId = message.turnId?.trim()
    if (turnId) {
      keys.set(message.id, `turn:${turnId}`)
    } else if (typeof message.turnIndex === 'number' && Number.isFinite(message.turnIndex)) {
      const associatedTurnId = !ambiguousIndices.has(message.turnIndex) && turnIdByIndex.get(message.turnIndex)
      keys.set(message.id, associatedTurnId ? `turn:${associatedTurnId}` : `index:${message.turnIndex}`)
    }
  }
  return keys
}

/** Rollback addresses a persisted user turn by ID; page offsets are irrelevant. */
export function buildEditableConversationTurns(messages: UiMessage[]): Record<string, string> {
  const editable: Record<string, string> = {}
  for (const message of messages) {
    if (message.role !== 'user' || message.messageType === 'userMessage.optimistic' || !message.text.trim()) continue
    const turnId = message.turnId?.trim()
    if (turnId) editable[message.id] = turnId
  }
  return editable
}
