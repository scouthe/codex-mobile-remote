import { describe, expect, it } from 'vitest'
import { phoneGesture, videoPoint } from './gestures'

describe('phone video gestures', () => {
  it('maps scaled portrait and landscape content while ignoring letterboxing', () => {
    const rect = { left: 10, top: 20, width: 300, height: 300 }
    expect(videoPoint(rect, { width: 100, height: 200 }, 160, 170)).toEqual({ x: 0.5, y: 0.5 })
    expect(videoPoint(rect, { width: 100, height: 200 }, 15, 170)).toBeUndefined()
    expect(videoPoint(rect, { width: 200, height: 100 }, 160, 25)).toBeUndefined()
    expect(videoPoint(rect, { width: 200, height: 100 }, 160, 170)).toEqual({ x: 0.5, y: 0.5 })
  })
  it('distinguishes taps, long presses and bounded swipes', () => {
    const from = { x: 0.5, y: 0.6 }, to = { x: 0.5, y: 0.2 }
    expect(phoneGesture(from, from, 120, 2)).toEqual({ type: 'tap', point: from, epoch: 2 })
    expect(phoneGesture(from, from, 900, 2)).toEqual({ type: 'swipe', from, to: from, duration: 900, epoch: 2 })
    expect(phoneGesture(from, to, 9000, 2)).toEqual({ type: 'swipe', from, to, duration: 1500, epoch: 2 })
  })
})
