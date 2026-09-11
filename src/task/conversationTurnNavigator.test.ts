import { describe, expect, it } from 'vitest'
import {
  buildConversationTurnAnchors,
  conversationTurnPreview,
  mobileTurnMarkerAction,
} from './conversationTurnNavigator'
import type { UiMessage } from '../types/codex'

function message(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    text: 'assistant',
    ...overrides,
  }
}

describe('conversation turn navigator', () => {
  it('creates anchors for persisted user messages and keeps their indexes', () => {
    expect(buildConversationTurnAnchors([
      message({ id: 'assistant-1' }),
      message({ id: 'user-1', role: 'user', text: '  first   prompt ' }),
      message({ id: 'optimistic', role: 'user', text: 'draft', messageType: 'userMessage.optimistic' }),
      message({ id: 'user-2', role: 'user', text: 'second prompt' }),
    ])).toEqual([
      { id: 'user-1', messageIndex: 1, preview: 'first prompt' },
      { id: 'user-2', messageIndex: 3, preview: 'second prompt' },
    ])
  })

  it('normalizes whitespace and truncates long prompt previews', () => {
    expect(conversationTurnPreview(' first\nsecond\tthird ', 12)).toBe('first secon…')
  })

  it('previews the first mobile tap and jumps on the second tap', () => {
    expect(mobileTurnMarkerAction('', 'user-1')).toBe('preview')
    expect(mobileTurnMarkerAction('user-1', 'user-1')).toBe('jump')
    expect(mobileTurnMarkerAction('user-1', 'user-2')).toBe('preview')
  })
})
