import { describe, expect, it } from 'vitest'
import { createTaskSnapshot, reduceTaskSnapshot } from './taskStateReducer'

describe('task state reducer', () => {
  it('moves a task from queued to running and completed', () => {
    const queued = reduceTaskSnapshot(undefined, {
      threadId: 'thread-1',
      queue: { depth: 1, oldestQueuedAt: '2026-08-31T00:00:00.000Z', clientIds: ['phone'] },
    })
    expect(queued.state).toBe('queued')
    const started = reduceTaskSnapshot(queued, {
      threadId: 'thread-1',
      notification: { method: 'turn/started', params: { threadId: 'thread-1', turnId: 'turn-1' }, atIso: '2026-08-31T00:00:01.000Z', seq: 1 },
    })
    expect(started.state).toBe('starting')
    const running = reduceTaskSnapshot(started, {
      threadId: 'thread-1',
      notification: { method: 'item/started', params: { threadId: 'thread-1', item: { type: 'commandExecution', command: 'pnpm test' } }, atIso: '2026-08-31T00:00:02.000Z', seq: 2 },
    })
    expect(running.state).toBe('running')
    expect(running.currentActivity.label).toBe('Running command')
    const completed = reduceTaskSnapshot(running, {
      threadId: 'thread-1',
      notification: { method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1' }, atIso: '2026-08-31T00:00:03.000Z', seq: 3 },
    })
    expect(completed.state).toBe('completed')
    expect(completed.activeRequest).toBeNull()
    expect(completed.timeline.map((event) => event.type)).toEqual(['queued', 'task_started', 'activity', 'task_completed'])
  })

  it('does not append duplicate timeline rows when the same queue depth is polled', () => {
    const first = reduceTaskSnapshot(undefined, {
      threadId: 'thread-1',
      queue: { depth: 1, oldestQueuedAt: '2026-08-31T00:00:00.000Z', clientIds: ['phone'] },
      atIso: '2026-08-31T00:00:01.000Z',
    })
    const second = reduceTaskSnapshot(first, {
      threadId: 'thread-1',
      queue: { depth: 1, oldestQueuedAt: '2026-08-31T00:00:00.000Z', clientIds: ['phone'] },
      atIso: '2026-08-31T00:00:02.000Z',
    })
    const third = reduceTaskSnapshot(second, {
      threadId: 'thread-1',
      queue: { depth: 2, oldestQueuedAt: '2026-08-31T00:00:00.000Z', clientIds: ['phone'] },
      atIso: '2026-08-31T00:00:03.000Z',
    })

    expect(second.timeline).toHaveLength(1)
    expect(third.timeline).toHaveLength(2)
    expect(third.timeline.map((event) => event.details[0])).toEqual(['1 message', '2 messages'])
  })

  it('deduplicates repeated queue notifications with the same depth', () => {
    const first = reduceTaskSnapshot(undefined, {
      threadId: 'thread-1',
      notification: {
        method: 'queue/updated',
        params: { threadId: 'thread-1', queueDepth: 1, messageId: 'q-1' },
        atIso: '2026-08-31T00:00:01.000Z',
      },
    })
    const second = reduceTaskSnapshot(first, {
      threadId: 'thread-1',
      notification: {
        method: 'queue/updated',
        params: { threadId: 'thread-1', queueDepth: 1, messageId: 'q-1' },
        atIso: '2026-08-31T00:00:02.000Z',
      },
    })

    expect(first.timeline).toHaveLength(1)
    expect(second.timeline).toHaveLength(1)
    expect(second.queueDepth).toBe(1)
  })

  it('represents approval and user-input requests, then resumes after resolution', () => {
    const base = createTaskSnapshot('thread-1', { state: 'running' })
    const approval = reduceTaskSnapshot(base, {
      threadId: 'thread-1',
      notification: { method: 'server/request', params: { threadId: 'thread-1', id: 7, method: 'item/commandExecution/requestApproval' }, atIso: '2026-08-31T00:01:00.000Z' },
    })
    expect(approval.state).toBe('waiting_approval')
    expect(approval.activeRequest?.kind).toBe('approval')
    const resumed = reduceTaskSnapshot(approval, {
      threadId: 'thread-1',
      notification: { method: 'server/request/resolved', params: { threadId: 'thread-1', id: 7 }, atIso: '2026-08-31T00:01:01.000Z' },
    })
    expect(resumed.state).toBe('running')
    expect(resumed.activeRequest).toBeNull()
  })

  it('restores a waiting state when a pending request is hydrated after reconnect', () => {
    const snapshot = reduceTaskSnapshot(createTaskSnapshot('thread-1', { state: 'running' }), {
      threadId: 'thread-1',
      activeRequest: {
        id: 11,
        kind: 'user_input',
        method: 'item/tool/requestUserInput',
        receivedAtIso: '2026-08-31T00:01:00.000Z',
      },
    })
    expect(snapshot.state).toBe('waiting_user_input')
    expect(snapshot.currentActivity.label).toBe('Input required')
  })

  it('keeps a bounded timeline and marks failures', () => {
    let snapshot = createTaskSnapshot('thread-1')
    for (let index = 0; index < 250; index += 1) {
      snapshot = reduceTaskSnapshot(snapshot, {
        threadId: 'thread-1',
        notification: { method: 'item/started', params: { threadId: 'thread-1', item: { type: 'reasoning' } }, atIso: new Date(index).toISOString(), seq: index },
      })
    }
    expect(snapshot.timeline.length).toBe(200)
    const failed = reduceTaskSnapshot(snapshot, {
      threadId: 'thread-1',
      notification: { method: 'error', params: { threadId: 'thread-1', message: 'provider unavailable' }, atIso: '2026-08-31T00:02:00.000Z' },
    })
    expect(failed.state).toBe('failed')
    expect(failed.error).toBe('provider unavailable')
  })
})
