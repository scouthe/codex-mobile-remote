import type { UiMessage } from '../types/codex'

export type ConversationTurnAnchor = {
  id: string
  messageIndex: number
  preview: string
}

export type MobileTurnMarkerAction = 'preview' | 'jump'

const DEFAULT_PREVIEW_LENGTH = 120

export function conversationTurnPreview(text: string, maxLength = DEFAULT_PREVIEW_LENGTH): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

/** Build navigation targets from the user prompts currently present in memory. */
export function buildConversationTurnAnchors(messages: UiMessage[]): ConversationTurnAnchor[] {
  return messages
    .map((message, messageIndex) => ({ message, messageIndex }))
    .filter(({ message }) => message.role === 'user' && message.messageType !== 'userMessage.optimistic')
    .map(({ message, messageIndex }) => ({
      id: message.id,
      messageIndex,
      preview: conversationTurnPreview(message.text) || 'User message',
    }))
}

/** Touch devices preview a prompt before a second tap confirms navigation. */
export function mobileTurnMarkerAction(previewedId: string, targetId: string): MobileTurnMarkerAction {
  return previewedId === targetId ? 'jump' : 'preview'
}
