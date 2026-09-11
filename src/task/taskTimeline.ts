import type { TaskTimelineEvent } from '../types/task'

export type CompactTaskTimelineEvent = TaskTimelineEvent & {
  /** Number of adjacent events represented by this row. */
  repeatCount?: number
}

/**
 * Reduce noisy observer events into rows useful to a person reading a task.
 *
 * Command output deltas are deliberately not timeline rows: the current
 * activity already reports that a command is running and the conversation
 * has the expandable command output. Keeping every delta here produced a
 * wall of identical "Running command" entries on mobile.
 */
export function compactTaskTimelineEvents(events: TaskTimelineEvent[]): CompactTaskTimelineEvent[] {
  const compacted: CompactTaskTimelineEvent[] = []

  for (const event of events) {
    if (event.type === 'activity' && event.label === 'Running command') continue

    const previous = compacted[compacted.length - 1]
    const sameActivity = previous
      && previous.type === event.type
      && previous.label === event.label
      && previous.turnId === event.turnId
      && previous.details.join('\u0000') === event.details.join('\u0000')

    if (sameActivity) {
      previous.repeatCount = (previous.repeatCount ?? 1) + 1
      previous.atIso = event.atIso
      previous.id = event.id
      previous.status = event.status
      continue
    }

    compacted.push({ ...event })
  }

  return compacted
}
