import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import { buildConversationTurnKeys, buildEditableConversationTurns } from './conversationTurnIdentity'

function message(id: string, overrides: Partial<UiMessage> = {}): UiMessage {
  return { id, role: 'assistant', text: id, messageType: 'agentMessage', ...overrides }
}

describe('conversation turn identity', () => {
  it('keeps copy and file-change grouping identical with or without absolute turn indices', () => {
    const messages = [
      message('user', { role: 'user', turnId: 'turn-a', turnIndex: 42 }),
      message('file-one', { messageType: 'fileChange', turnId: 'turn-a', turnIndex: 42 }),
      message('first-answer', { turnId: 'turn-a', turnIndex: 42 }),
      message('file-two', { messageType: 'fileChange', turnId: 'turn-a', turnIndex: 42 }),
      message('last-answer', { turnId: 'turn-a', turnIndex: 42 }),
      message('other-answer', { turnId: 'turn-b', turnIndex: 43 }),
    ]
    const pagedMessages = messages.map(({ turnIndex: _index, ...item }) => item)
    expect(buildConversationTurnKeys(pagedMessages)).toEqual(buildConversationTurnKeys(messages))
    expect(buildEditableConversationTurns(pagedMessages)).toEqual({ user: 'turn-a' })
    expect(buildEditableConversationTurns(pagedMessages)).toEqual(buildEditableConversationTurns(messages))
    const keys = buildConversationTurnKeys(pagedMessages)
    expect(keys.get('file-one')).toBe(keys.get('last-answer'))
    expect(keys.get('first-answer')).toBe(keys.get('last-answer'))
    expect(keys.get('other-answer')).not.toBe(keys.get('last-answer'))
  })

  it('uses stable IDs despite changed or colliding legacy indices', () => {
    const keys = buildConversationTurnKeys([
      message('first', { turnId: 'turn-a', turnIndex: 0 }),
      message('second', { turnId: 'turn-a', turnIndex: 10 }),
      message('other', { turnId: 'turn-b', turnIndex: 0 }),
      message('ambiguous-legacy', { turnIndex: 0 }),
    ])
    expect(keys.get('first')).toBe(keys.get('second'))
    expect(keys.get('other')).not.toBe(keys.get('first'))
    expect(keys.get('ambiguous-legacy')).not.toBe(keys.get('first'))
    expect(keys.get('ambiguous-legacy')).not.toBe(keys.get('other'))
  })

  it('groups legacy index-only rows and joins mixed rows only when the ID association is unambiguous', () => {
    const keys = buildConversationTurnKeys([
      message('legacy-file', { messageType: 'fileChange', turnIndex: 7 }),
      message('legacy-answer', { turnIndex: 7 }),
      message('mixed-file', { messageType: 'fileChange', turnIndex: 8 }),
      message('mixed-answer', { turnId: 'turn-eight', turnIndex: 8 }),
      message('unidentified-one'),
      message('unidentified-two'),
    ])
    expect(keys.get('legacy-file')).toBe('index:7')
    expect(keys.get('legacy-file')).toBe(keys.get('legacy-answer'))
    expect(keys.get('mixed-file')).toBe('turn:turn-eight')
    expect(keys.get('mixed-file')).toBe(keys.get('mixed-answer'))
    expect(keys.has('unidentified-one')).toBe(false)
    expect(keys.has('unidentified-two')).toBe(false)
  })

  it('offers edit only for persisted nonempty user messages with a stable turn ID', () => {
    expect(buildEditableConversationTurns([
      message('editable', { role: 'user', turnId: 'turn-a' }),
      message('assistant', { turnId: 'turn-a' }),
      message('optimistic', { role: 'user', turnId: 'turn-a', messageType: 'userMessage.optimistic' }),
      message('empty', { role: 'user', turnId: 'turn-a', text: '  ' }),
      message('index-only', { role: 'user', turnIndex: 0 }),
    ])).toEqual({ editable: 'turn-a' })
  })
})
