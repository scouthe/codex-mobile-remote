import { describe, expect, it } from 'vitest'
import type { UiLiveOverlay, UiMessage } from '../types/codex'
import { shouldRenderConversationMessage, shouldRenderLiveOverlay } from './mobileConversationVisibility'

function message(overrides: Partial<UiMessage> = {}): UiMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    text: 'message',
    ...overrides,
  }
}

describe('shouldRenderConversationMessage', () => {
  it('keeps expandable command and file-change rows on mobile', () => {
    expect(shouldRenderConversationMessage(message({ messageType: 'commandExecution' }), true)).toBe(true)
    expect(shouldRenderConversationMessage(message({ messageType: 'fileChange' }), true)).toBe(true)
    expect(shouldRenderConversationMessage(message({ messageType: 'worked' }), true)).toBe(false)
  })

  it('keeps conversation and interactive messages visible on mobile', () => {
    expect(shouldRenderConversationMessage(message({ role: 'user' }), true)).toBe(true)
    expect(shouldRenderConversationMessage(message({ messageType: 'plan' }), true)).toBe(true)
    expect(shouldRenderConversationMessage(message({ messageType: 'turnError' }), true)).toBe(true)
    expect(shouldRenderConversationMessage(message({ messageType: 'agentMessage.live' }), true)).toBe(true)
  })

  it('does not change desktop visibility', () => {
    expect(shouldRenderConversationMessage(message({ messageType: 'commandExecution' }), false)).toBe(true)
    expect(shouldRenderConversationMessage(message({ messageType: 'fileChange' }), false)).toBe(true)
    expect(shouldRenderConversationMessage(message({ messageType: 'worked' }), false)).toBe(true)
  })
})

function overlay(overrides: Partial<UiLiveOverlay> = {}): UiLiveOverlay {
  return {
    activityLabel: 'Thinking',
    activityDetails: [],
    reasoningText: 'Working',
    errorText: '',
    ...overrides,
  }
}

describe('shouldRenderLiveOverlay', () => {
  it('hides duplicate live activity on mobile but keeps errors visible', () => {
    expect(shouldRenderLiveOverlay(overlay(), true)).toBe(false)
    expect(shouldRenderLiveOverlay(overlay({ errorText: 'Request failed' }), true)).toBe(true)
  })

  it('keeps live activity visible on desktop', () => {
    expect(shouldRenderLiveOverlay(overlay(), false)).toBe(true)
    expect(shouldRenderLiveOverlay(null, false)).toBe(false)
  })
})
