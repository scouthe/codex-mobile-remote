import { describe, expect, it } from 'vitest'
import { compactTaskTimelineEvents } from './taskTimeline'
import type { TaskTimelineEvent } from '../types/task'

let eventCounter = 0
function event(overrides: Partial<TaskTimelineEvent> = {}): TaskTimelineEvent {
  return {
    id: overrides.id ?? `event-${++eventCounter}`,
    type: overrides.type ?? 'activity',
    atIso: overrides.atIso ?? '2026-09-11T00:00:00.000Z',
    label: overrides.label ?? 'Writing response',
    details: overrides.details ?? [],
    turnId: overrides.turnId ?? 'turn-1',
    ...overrides,
  }
}

describe('compactTaskTimelineEvents', () => {
  it('removes command output delta rows from the timeline', () => {
    const result = compactTaskTimelineEvents([
      event({ id: 'delta-1', label: 'Running command' }),
      event({ id: 'delta-2', label: 'Running command' }),
      event({ id: 'command-1', type: 'command', label: 'Running command' }),
    ])

    expect(result.map((item) => item.id)).toEqual(['command-1'])
  })

  it('coalesces adjacent identical activity rows and keeps the repeat count', () => {
    const result = compactTaskTimelineEvents([
      event({ id: 'response-1' }),
      event({ id: 'response-2', atIso: '2026-09-11T00:00:01.000Z' }),
      event({ id: 'command-1', type: 'command', label: 'Running command' }),
      event({ id: 'response-3' }),
    ])

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ id: 'response-2', repeatCount: 2 })
    expect(result[1]).toMatchObject({ id: 'command-1' })
    expect(result[2]).toMatchObject({ id: 'response-3' })
  })
})
