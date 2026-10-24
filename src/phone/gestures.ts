import type { PhoneInput, PhonePoint } from '../types/phoneControl'

/** object-fit: contain coordinates, excluding letterboxing. */
export function videoPoint(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, size: { width: number; height: number }, x: number, y: number): PhonePoint | undefined {
  if (!size.width || !size.height || !rect.width || !rect.height) return
  const scale = Math.min(rect.width / size.width, rect.height / size.height)
  const width = size.width * scale, height = size.height * scale
  const px = (x - rect.left - (rect.width - width) / 2) / width
  const py = (y - rect.top - (rect.height - height) / 2) / height
  if (px < 0 || px > 1 || py < 0 || py > 1) return
  return { x: px, y: py }
}

export function phoneGesture(from: PhonePoint, to: PhonePoint, elapsed: number, epoch: number): PhoneInput {
  if (Math.hypot(to.x - from.x, to.y - from.y) < 0.012) {
    if (elapsed < 500) return { type: 'tap', point: to, epoch }
    return { type: 'swipe', from, to: from, duration: Math.min(2000, Math.max(500, Math.round(elapsed))), epoch }
  }
  return { type: 'swipe', from, to, duration: Math.min(1500, Math.max(100, Math.round(elapsed))), epoch }
}
