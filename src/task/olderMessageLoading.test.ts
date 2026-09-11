import { describe, expect, it } from 'vitest'
import { shouldAutoLoadPersistedAbove } from './olderMessageLoading'

describe('shouldAutoLoadPersistedAbove', () => {
  it('auto-loads on mobile even when desktop hydration is deferred', () => {
    expect(shouldAutoLoadPersistedAbove(true, true)).toBe(true)
  })

  it('keeps the explicit load action for deferred desktop observer sessions', () => {
    expect(shouldAutoLoadPersistedAbove(false, true)).toBe(false)
  })

  it('auto-loads when no deferral was requested', () => {
    expect(shouldAutoLoadPersistedAbove(false, false)).toBe(true)
    expect(shouldAutoLoadPersistedAbove(false, undefined)).toBe(true)
  })
})
