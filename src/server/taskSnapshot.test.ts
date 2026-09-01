import { describe, expect, it } from 'vitest'
import { buildTaskSnapshotResponse } from './codexAppServerBridge'

describe('task snapshot response', () => {
  it('derives running activity and pending approval from shared bridge state', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-1',
      true,
      2,
      [{
        id: 9,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1' },
        receivedAtIso: '2026-08-31T00:00:02.000Z',
      }],
      [{
        seq: 1,
        method: 'turn/started',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        atIso: '2026-08-31T00:00:00.000Z',
      }, {
        seq: 2,
        method: 'item/started',
        params: { threadId: 'thread-1', item: { type: 'commandExecution', command: 'pnpm test' } },
        atIso: '2026-08-31T00:00:01.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 2, oldestSeq: 1 },
      { known: true, inProgress: true, lastEventAt: Date.parse('2026-08-31T00:00:01.000Z'), turnId: 'turn-1' },
      { clientId: 'desktop-1', clientType: 'desktop', generation: 3, claimedAt: '2026-08-31T00:00:00.000Z' },
    )

    expect(snapshot.taskState).toBe('waiting_approval')
    expect(snapshot.queueDepth).toBe(2)
    expect(snapshot.activeRequest?.kind).toBe('approval')
    expect(snapshot.currentActivity.label).toBe('Approval required')
    expect(snapshot.writerClient).toMatchObject({ clientId: 'desktop-1', label: 'Desktop' })
    expect(snapshot.timeline).toHaveLength(2)
  })

  it('keeps the queue state and activity label aligned without a session marker', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-queued',
      false,
      2,
      [],
      [],
      { streamEpoch: 'epoch-1', latestSeq: 0, oldestSeq: null },
      null,
    )

    expect(snapshot.taskState).toBe('queued')
    expect(snapshot.currentActivity).toEqual({
      kind: 'queue',
      label: 'Queued',
      details: ['2 messages'],
    })
  })

  it('keeps an idle session completed when the stream still contains stale activity', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-1',
      false,
      0,
      [],
      [{
        seq: 1,
        method: 'turn/started',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        atIso: '2026-08-31T00:00:00.000Z',
      }, {
        seq: 2,
        method: 'item/started',
        params: { threadId: 'thread-1', item: { type: 'commandExecution', command: 'pnpm test' } },
        atIso: '2026-08-31T00:00:01.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 2, oldestSeq: 1 },
      {
        known: true,
        inProgress: false,
        lastEventAt: Date.parse('2026-08-31T00:00:02.000Z'),
        turnId: '',
      },
    )

    expect(snapshot.taskState).toBe('completed')
    expect(snapshot.currentActivity).toEqual({ kind: 'idle', label: 'Completed', details: [] })
  })

  it('exposes the session turn id when the projected thread has no active turn', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-1',
      true,
      0,
      [],
      [],
      { streamEpoch: 'epoch-1', latestSeq: 0, oldestSeq: null },
      {
        known: true,
        inProgress: true,
        lastEventAt: Date.parse('2026-08-31T00:00:02.000Z'),
        turnId: 'turn-external',
      },
    )

    expect(snapshot.activeTurnId).toBe('turn-external')
  })

  it('derives a failed task from a failed turn/completed event', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-failed',
      false,
      0,
      [],
      [{
        seq: 1,
        method: 'turn/completed',
        params: {
          threadId: 'thread-failed',
          turn: {
            id: 'turn-failed',
            status: 'failed',
            error: { message: 'provider unavailable' },
          },
        },
        atIso: '2026-08-31T00:00:04.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 1, oldestSeq: 1 },
      {
        known: true,
        inProgress: false,
        lastEventAt: Date.parse('2026-08-31T00:00:04.000Z'),
        turnId: '',
      },
    )

    expect(snapshot.taskState).toBe('failed')
    expect(snapshot.error).toBe('provider unavailable')
    expect(snapshot.currentActivity).toEqual({
      kind: 'error',
      label: 'Task failed',
      details: ['provider unavailable'],
    })
  })

  it('keeps a task active between queue pop and turn/started', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-processing',
      false,
      0,
      [],
      [{
        seq: 1,
        method: 'queue/updated',
        params: { threadId: 'thread-processing', queueDepth: 0, status: 'processing', messageId: 'q-1' },
        atIso: '2026-08-31T00:00:02.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 1, oldestSeq: 1 },
      {
        known: true,
        inProgress: false,
        lastEventAt: Date.parse('2026-08-31T00:00:01.000Z'),
        turnId: '',
      },
    )

    expect(snapshot.taskState).toBe('starting')
    expect(snapshot.currentActivity.label).toBe('Thinking')
  })

  it('keeps retryable stream errors active instead of marking the task failed', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-retry',
      true,
      0,
      [],
      [{
        seq: 1,
        method: 'error',
        params: { threadId: 'thread-retry', turnId: 'turn-retry', message: 'temporary upstream failure', willRetry: true },
        atIso: '2026-08-31T00:02:01.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 1, oldestSeq: 1 },
      null,
    )

    expect(snapshot.taskState).toBe('running')
    expect(snapshot.error).toBe('temporary upstream failure')
  })

  it('does not resurrect a stale pending request after the session is idle', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-idle',
      false,
      0,
      [{
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-idle' },
        receivedAtIso: '2026-08-31T00:00:01.000Z',
      }],
      [],
      { streamEpoch: 'epoch-1', latestSeq: 0, oldestSeq: null },
      {
        known: true,
        inProgress: false,
        lastEventAt: Date.parse('2026-08-31T00:00:02.000Z'),
        turnId: '',
      },
    )

    expect(snapshot.taskState).toBe('completed')
    expect(snapshot.activeRequest).toBeNull()
  })

  it('projects an externally recorded failed terminal outcome', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-external-failure',
      false,
      0,
      [],
      [],
      { streamEpoch: 'epoch-1', latestSeq: 0, oldestSeq: null },
      {
        known: true,
        inProgress: false,
        lastEventAt: Date.parse('2026-08-31T00:00:05.000Z'),
        turnId: '',
        terminalTurnId: 'turn-failed',
        terminalState: 'failed',
        terminalError: 'provider unavailable',
      },
    )

    expect(snapshot.taskState).toBe('failed')
    expect(snapshot.error).toBe('provider unavailable')
    expect(snapshot.currentActivity).toEqual({
      kind: 'error',
      label: 'Task failed',
      details: ['provider unavailable'],
    })
  })

  it('projects an externally recorded canceled terminal outcome', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-external-cancel',
      false,
      0,
      [],
      [],
      { streamEpoch: 'epoch-1', latestSeq: 0, oldestSeq: null },
      {
        known: true,
        inProgress: false,
        lastEventAt: Date.parse('2026-08-31T00:00:05.000Z'),
        turnId: '',
        terminalTurnId: 'turn-canceled',
        terminalState: 'canceled',
        terminalError: '',
      },
    )

    expect(snapshot.taskState).toBe('canceled')
    expect(snapshot.currentActivity).toEqual({ kind: 'idle', label: 'Canceled', details: [] })
  })

  it('does not resurrect a completed task from delayed old-turn stream frames', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-late-stream',
      false,
      0,
      [],
      [{
        seq: 1,
        method: 'turn/completed',
        params: { threadId: 'thread-late-stream', turnId: 'turn-1' },
        atIso: '2026-08-31T00:06:00.000Z',
      }, {
        seq: 2,
        method: 'item/started',
        params: {
          threadId: 'thread-late-stream',
          turnId: 'turn-1',
          item: { type: 'commandExecution', command: 'late command' },
        },
        atIso: '2026-08-31T00:06:01.000Z',
      }, {
        seq: 3,
        method: 'error',
        params: { threadId: 'thread-late-stream', turnId: 'turn-1', message: 'late error' },
        atIso: '2026-08-31T00:06:02.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 3, oldestSeq: 1 },
      null,
    )

    expect(snapshot.taskState).toBe('completed')
    expect(snapshot.activeTurnId).toBe('')
    expect(snapshot.terminalTurnId).toBe('turn-1')
    expect(snapshot.currentActivity).toEqual({ kind: 'idle', label: 'Completed', details: [] })
  })

  it('does not let an old item frame replace the current turn activity', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-active-new',
      true,
      0,
      [],
      [{
        seq: 1,
        method: 'turn/started',
        params: { threadId: 'thread-active-new', turnId: 'turn-new' },
        atIso: '2026-08-31T00:07:00.000Z',
      }, {
        seq: 2,
        method: 'item/started',
        params: {
          threadId: 'thread-active-new',
          turnId: 'turn-old',
          item: { type: 'commandExecution', command: 'old command' },
        },
        atIso: '2026-08-31T00:07:01.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 2, oldestSeq: 1 },
      null,
    )

    expect(snapshot.taskState).toBe('starting')
    expect(snapshot.activeTurnId).toBe('turn-new')
    expect(snapshot.currentActivity).toEqual({ kind: 'thinking', label: 'Thinking', details: [] })
  })

  it('includes failure details and terminal status in stream timeline events', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-failed-timeline',
      false,
      0,
      [],
      [{
        seq: 1,
        method: 'turn/completed',
        params: { threadId: 'thread-failed-timeline', turnId: 'turn-1', status: 'failed', message: 'failed to connect' },
        atIso: '2026-08-31T00:00:04.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 1, oldestSeq: 1 },
      null,
    )

    expect(snapshot.timeline.at(-1)).toMatchObject({
      type: 'error',
      status: 'failed',
      details: ['failed to connect'],
    })
  })

  it('marks stream cancellation events as canceled in the timeline', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-canceled-timeline',
      false,
      0,
      [],
      [{
        seq: 1,
        method: 'turn/interrupt',
        params: { threadId: 'thread-canceled-timeline', turnId: 'turn-1' },
        atIso: '2026-08-31T00:00:04.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 1, oldestSeq: 1 },
      null,
    )

    expect(snapshot.timeline.at(-1)).toMatchObject({ type: 'task_canceled', status: 'canceled' })
  })

  it('does not let an older turn completion finish a newer active turn', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-multi-turn',
      true,
      0,
      [],
      [{
        seq: 1,
        method: 'turn/started',
        params: { threadId: 'thread-multi-turn', turnId: 'turn-new' },
        atIso: '2026-08-31T00:00:00.000Z',
      }, {
        seq: 2,
        method: 'turn/completed',
        params: { threadId: 'thread-multi-turn', turnId: 'turn-old' },
        atIso: '2026-08-31T00:00:01.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 2, oldestSeq: 1 },
      null,
    )

    expect(snapshot.taskState).toBe('starting')
    expect(snapshot.activeTurnId).toBe('turn-new')
  })

  it('does not let an older item frame replace a newer active turn', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-multi-turn-items',
      true,
      0,
      [],
      [{
        seq: 1,
        method: 'turn/started',
        params: { threadId: 'thread-multi-turn-items', turnId: 'turn-new' },
        atIso: '2026-08-31T00:00:00.000Z',
      }, {
        seq: 2,
        method: 'item/started',
        params: {
          threadId: 'thread-multi-turn-items',
          turnId: 'turn-old',
          item: { type: 'commandExecution', command: 'old command' },
        },
        atIso: '2026-08-31T00:00:01.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 2, oldestSeq: 1 },
      null,
    )

    expect(snapshot.taskState).toBe('starting')
    expect(snapshot.activeTurnId).toBe('turn-new')
    expect(snapshot.currentActivity).toEqual({ kind: 'thinking', label: 'Thinking', details: [] })
  })

  it('keeps queue depth aligned with queue lifecycle events', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-queue-event',
      false,
      2,
      [],
      [{
        seq: 1,
        method: 'queue/updated',
        params: { threadId: 'thread-queue-event', queueDepth: 0, status: 'processing', messageId: 'q-1' },
        atIso: '2026-08-31T00:00:01.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 1, oldestSeq: 1 },
      null,
    )

    expect(snapshot.taskState).toBe('starting')
    expect(snapshot.queueDepth).toBe(0)
  })

  it('projects server requests into the same task timeline as live activity', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-request-timeline',
      true,
      0,
      [{
        id: 9,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-request-timeline' },
        receivedAtIso: '2026-08-31T00:00:02.000Z',
      }],
      [{
        seq: 1,
        method: 'turn/started',
        params: { threadId: 'thread-request-timeline', turnId: 'turn-1' },
        atIso: '2026-08-31T00:00:00.000Z',
      }, {
        seq: 2,
        method: 'server/request',
        params: {
          id: 9,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'thread-request-timeline' },
          receivedAtIso: '2026-08-31T00:00:02.000Z',
        },
        atIso: '2026-08-31T00:00:02.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 2, oldestSeq: 1 },
      null,
    )

    expect(snapshot.taskState).toBe('waiting_approval')
    expect(snapshot.timeline.at(-1)).toMatchObject({
      type: 'approval_request',
      label: 'Approval required',
      status: 'pending',
    })
  })

  it('returns to running when the stream resolves the active request', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-request-resolved',
      true,
      0,
      [],
      [{
        seq: 1,
        method: 'turn/started',
        params: { threadId: 'thread-request-resolved', turnId: 'turn-1' },
        atIso: '2026-08-31T00:00:00.000Z',
      }, {
        seq: 2,
        method: 'server/request',
        params: {
          id: 9,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'thread-request-resolved' },
        },
        atIso: '2026-08-31T00:00:01.000Z',
      }, {
        seq: 3,
        method: 'server/request/resolved',
        params: { threadId: 'thread-request-resolved', id: 9 },
        atIso: '2026-08-31T00:00:02.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 3, oldestSeq: 1 },
      {
        known: true,
        inProgress: true,
        lastEventAt: Date.parse('2026-08-31T00:00:02.000Z'),
        turnId: 'turn-1',
      },
    )

    expect(snapshot.taskState).toBe('running')
    expect(snapshot.activeRequest).toBeNull()
    expect(snapshot.currentActivity).toEqual({ kind: 'thinking', label: 'Thinking', details: [] })
  })

  it('matches a nested server request to its thread', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-nested-request',
      true,
      0,
      [{
        id: 12,
        method: 'item/commandExecution/requestApproval',
        params: { params: { threadId: 'thread-nested-request' } },
        receivedAtIso: '2026-08-31T00:06:02.000Z',
      }],
      [],
      { streamEpoch: 'epoch-1', latestSeq: 0, oldestSeq: null },
      null,
    )

    expect(snapshot.activeRequest).toMatchObject({ id: 12, kind: 'approval' })
    expect(snapshot.taskState).toBe('waiting_approval')
  })

  it('accepts queue/enqueued events as a queued task state', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-queue-enqueued',
      false,
      0,
      [],
      [{
        seq: 1,
        method: 'queue/enqueued',
        params: { threadId: 'thread-queue-enqueued', queueDepth: 1, status: 'enqueued', messageId: 'q-1' },
        atIso: '2026-08-31T00:06:00.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 1, oldestSeq: 1 },
      null,
    )

    expect(snapshot.taskState).toBe('queued')
    expect(snapshot.queueDepth).toBe(1)
    expect(snapshot.currentActivity).toEqual({ kind: 'queue', label: 'Queued', details: ['1 message'] })
  })

  it('keeps the queued state after a turn completes when another message remains', () => {
    const snapshot = buildTaskSnapshotResponse(
      'thread-queue-after-turn',
      false,
      1,
      [],
      [{
        seq: 1,
        method: 'turn/completed',
        params: { threadId: 'thread-queue-after-turn', turnId: 'turn-1' },
        atIso: '2026-08-31T00:06:01.000Z',
      }],
      { streamEpoch: 'epoch-1', latestSeq: 1, oldestSeq: 1 },
      null,
    )

    expect(snapshot.taskState).toBe('queued')
    expect(snapshot.currentActivity).toEqual({ kind: 'queue', label: 'Queued', details: ['1 message'] })
    expect(snapshot.timeline.at(-1)).toMatchObject({ type: 'task_completed', status: 'completed' })
  })
})
