import { describe, expect, it } from 'vitest'
import { isThreadQuickJumpShortcut } from './threadQuickJump'

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: 'k',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent
}

describe('isThreadQuickJumpShortcut', () => {
  it('accepts Ctrl+K and Cmd+K', () => {
    expect(isThreadQuickJumpShortcut(key({ ctrlKey: true }))).toBe(true)
    expect(isThreadQuickJumpShortcut(key({ metaKey: true }))).toBe(true)
  })

  it('rejects modified or unrelated shortcuts', () => {
    expect(isThreadQuickJumpShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isThreadQuickJumpShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false)
    expect(isThreadQuickJumpShortcut(key({ key: 'b', ctrlKey: true }))).toBe(false)
  })
})
