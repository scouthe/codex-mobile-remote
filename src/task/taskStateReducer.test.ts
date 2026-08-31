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
      queue: { depth: 0, oldestQueuedAt: null, clientIds: [] },
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

  it('keeps a failed turn completed event in the failed state', () => {
    const started = reduceTaskSnapshot(createTaskSnapshot('thread-failed', { state: 'running', activeTurnId: 'turn-failed' }), {
      threadId: 'thread-failed',
      notification: {
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
        seq: 4,
      },
    })

    expect(started.state).toBe('failed')
    expect(started.error).toBe('provider unavailable')
    expect(started.activeTurnId).toBe('')
    expect(started.currentActivity.kind).toBe('error')
    expect(started.timeline.at(-1)).toMatchObject({ type: 'error', status: 'failed' })
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

  it('keeps a persisted queue queued while an idle session refresh omits queue data', () => {
    const queued = reduceTaskSnapshot(undefined, {
      threadId: 'thread-1',
      queue: { depth: 1, oldestQueuedAt: '2026-08-31T00:00:00.000Z', clientIds: ['phone'] },
    })

    const refreshed = reduceTaskSnapshot(queued, {
      threadId: 'thread-1',
      inProgress: false,
      revision: 'idle-revision',
    })

    expect(refreshed.state).toBe('queued')
    expect(refreshed.queueDepth).toBe(1)
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

  it('keeps the task active while a queued item is being handed to Codex', () => {
    const processing = reduceTaskSnapshot(createTaskSnapshot('thread-1'), {
      threadId: 'thread-1',
      notification: {
        method: 'queue/updated',
        params: { threadId: 'thread-1', queueDepth: 0, status: 'processing', messageId: 'q-1' },
        atIso: '2026-08-31T00:00:02.000Z',
      },
    })

    expect(processing.state).toBe('starting')
    expect(processing.currentActivity.label).toBe('Thinking')
  })

  it('returns a failed queue hand-off to queued instead of leaving it starting', () => {
    const starting = reduceTaskSnapshot(createTaskSnapshot('thread-1', {
      state: 'queued',
      queueDepth: 1,
    }), {
      threadId: 'thread-1',
      notification: {
        method: 'queue/updated',
        params: { threadId: 'thread-1', queueDepth: 0, status: 'processing', messageId: 'q-1' },
        atIso: '2026-08-31T00:00:01.000Z',
      },
    })

    const restored = reduceTaskSnapshot(starting, {
      threadId: 'thread-1',
      notification: {
        method: 'queue/updated',
        params: { threadId: 'thread-1', queueDepth: 1, status: 'failed', messageId: 'q-1' },
        atIso: '2026-08-31T00:00:02.000Z',
      },
    })

    expect(restored.state).toBe('queued')
    expect(restored.queueDepth).toBe(1)
    expect(restored.currentActivity).toEqual({ kind: 'queue', label: 'Queued', details: ['1 message'] })
  })

  it('completes a queued-only task when its last message is removed', () => {
    const removed = reduceTaskSnapshot(createTaskSnapshot('thread-1', {
      state: 'queued',
      queueDepth: 1,
      currentActivity: { kind: 'queue', label: 'Queued', details: ['1 message'] },
    }), {
      threadId: 'thread-1',
      notification: {
        method: 'queue/updated',
        params: { threadId: 'thread-1', queueDepth: 0, status: 'removed', messageId: 'q-1' },
        atIso: '2026-08-31T00:00:02.000Z',
      },
    })

    expect(removed.state).toBe('completed')
    expect(removed.queueDepth).toBe(0)
    expect(removed.currentActivity).toEqual({ kind: 'idle', label: 'Completed', details: [] })
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

  it('does not clear a newer request when an older request resolves', () => {
    const waiting = reduceTaskSnapshot(createTaskSnapshot('thread-1', { state: 'running' }), {
      threadId: 'thread-1',
      notification: {
        method: 'server/request',
        params: { threadId: 'thread-1', id: 8, method: 'item/commandExecution/requestApproval' },
        atIso: '2026-08-31T00:01:00.000Z',
      },
    })
    const newer = reduceTaskSnapshot(waiting, {
      threadId: 'thread-1',
      notification: {
        method: 'server/request',
        params: { threadId: 'thread-1', id: 9, method: 'item/tool/requestUserInput' },
        atIso: '2026-08-31T00:01:01.000Z',
      },
    })
    const stillWaiting = reduceTaskSnapshot(newer, {
      threadId: 'thread-1',
      notification: {
        method: 'server/request/resolved',
        params: { threadId: 'thread-1', id: 8 },
        atIso: '2026-08-31T00:01:02.000Z',
      },
    })

    expect(stillWaiting.state).toBe('waiting_user_input')
    expect(stillWaiting.activeRequest).toMatchObject({ id: 9, kind: 'user_input' })
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

  it('does not turn a retryable error notification into a terminal failure', () => {
    const running = createTaskSnapshot('thread-retry', { state: 'running', activeTurnId: 'turn-retry' })
    const retrying = reduceTaskSnapshot(running, {
      threadId: 'thread-retry',
      notification: {
        method: 'error',
        params: { threadId: 'thread-retry', turnId: 'turn-retry', message: 'temporary upstream failure', willRetry: true },
        atIso: '2026-08-31T00:02:01.000Z',
      },
    })

    expect(retrying.state).toBe('running')
    expect(retrying.activeTurnId).toBe('turn-retry')
    expect(retrying.finishedAt).toBeNull()
    expect(retrying.error).toBe('temporary upstream failure')
  })

  it('clears a retryable error when an authoritative idle observation arrives', () => {
    const retrying = createTaskSnapshot('thread-retry', {
      state: 'running',
      activeTurnId: 'turn-retry',
      currentActivity: { kind: 'error', label: 'Retrying task', details: ['temporary upstream failure'] },
      error: 'temporary upstream failure',
    })

    const completed = reduceTaskSnapshot(retrying, {
      threadId: 'thread-retry',
      inProgress: false,
      activeTurnId: '',
      atIso: '2026-08-31T00:02:05.000Z',
    })

    expect(completed.state).toBe('completed')
    expect(completed.error).toBeNull()
    expect(completed.currentActivity).toEqual({ kind: 'idle', label: 'Completed', details: [] })
  })

  it('starts a fresh turn from a previous failed or canceled terminal state', () => {
    const failed = createTaskSnapshot('thread-retry-terminal', {
      state: 'failed',
      error: 'previous turn failed',
      finishedAt: '2026-08-31T00:02:00.000Z',
      currentActivity: { kind: 'error', label: 'Task failed', details: ['previous turn failed'] },
    })
    const restarted = reduceTaskSnapshot(failed, {
      threadId: 'thread-retry-terminal',
      inProgress: true,
      activeTurnId: 'turn-2',
      atIso: '2026-08-31T00:02:01.000Z',
    })

    expect(restarted.state).toBe('running')
    expect(restarted.activeTurnId).toBe('turn-2')
    expect(restarted.error).toBeNull()
    expect(restarted.finishedAt).toBeNull()
  })

  it('promotes a task when an activity event arrives after a missed turn/started', () => {
    const completed = createTaskSnapshot('thread-activity-recovery', {
      state: 'completed',
      finishedAt: '2026-08-31T00:00:01.000Z',
      streamCursor: { streamEpoch: 'epoch-1', latestSeq: 1, oldestSeq: 1 },
    })

    const recovered = reduceTaskSnapshot(completed, {
      threadId: 'thread-activity-recovery',
      notification: {
        method: 'item/started',
        params: {
          threadId: 'thread-activity-recovery',
          turnId: 'turn-recovered',
          item: { type: 'commandExecution', command: 'pnpm test' },
        },
        atIso: '2026-08-31T00:00:02.000Z',
        seq: 2,
        streamEpoch: 'epoch-1',
      },
    })

    expect(recovered.state).toBe('running')
    expect(recovered.activeTurnId).toBe('turn-recovered')
    expect(recovered.finishedAt).toBeNull()
    expect(recovered.currentActivity).toMatchObject({ kind: 'command', label: 'Running command' })
  })

  it('does not let a late completion for an older turn finish the current turn', () => {
    const started = reduceTaskSnapshot(createTaskSnapshot('thread-1'), {
      threadId: 'thread-1',
      notification: {
        method: 'turn/started',
        params: { threadId: 'thread-1', turnId: 'turn-new' },
        atIso: '2026-08-31T00:03:00.000Z',
        seq: 10,
        streamEpoch: 'epoch-1',
      },
    })

    const lateCompletion = reduceTaskSnapshot(started, {
      threadId: 'thread-1',
      notification: {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turnId: 'turn-old' },
        atIso: '2026-08-31T00:03:01.000Z',
        seq: 11,
        streamEpoch: 'epoch-1',
      },
    })

    expect(lateCompletion.state).toBe('starting')
    expect(lateCompletion.activeTurnId).toBe('turn-new')
  })

  it('does not let an older item event replace the current turn activity', () => {
    const started = reduceTaskSnapshot(createTaskSnapshot('thread-1'), {
      threadId: 'thread-1',
      notification: {
        method: 'turn/started',
        params: { threadId: 'thread-1', turnId: 'turn-new' },
        atIso: '2026-08-31T00:03:00.000Z',
        seq: 10,
        streamEpoch: 'epoch-1',
      },
    })

    const lateItem = reduceTaskSnapshot(started, {
      threadId: 'thread-1',
      notification: {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-old',
          item: { type: 'commandExecution', command: 'old command' },
        },
        atIso: '2026-08-31T00:03:01.000Z',
        seq: 11,
        streamEpoch: 'epoch-1',
      },
    })

    expect(lateItem.state).toBe('starting')
    expect(lateItem.activeTurnId).toBe('turn-new')
    expect(lateItem.currentActivity).toEqual({ kind: 'thinking', label: 'Thinking', details: [] })
    expect(lateItem.streamCursor?.latestSeq).toBe(11)
  })

  it('ignores a replayed frame already covered by the stream cursor', () => {
    const completed = reduceTaskSnapshot(createTaskSnapshot('thread-1'), {
      threadId: 'thread-1',
      notification: {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        atIso: '2026-08-31T00:04:00.000Z',
        seq: 20,
        streamEpoch: 'epoch-1',
      },
    })

    const replayedStart = reduceTaskSnapshot(completed, {
      threadId: 'thread-1',
      notification: {
        method: 'turn/started',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        atIso: '2026-08-31T00:03:00.000Z',
        seq: 19,
        streamEpoch: 'epoch-1',
      },
    })

    expect(replayedStart.state).toBe('completed')
    expect(replayedStart.activeTurnId).toBe('')
  })

  it('does not let an older same-epoch snapshot roll back the lifecycle or cursor', () => {
    const completed = createTaskSnapshot('thread-1', {
      state: 'completed',
      streamCursor: { streamEpoch: 'epoch-1', latestSeq: 20, oldestSeq: 1 },
    })

    const stale = reduceTaskSnapshot(completed, {
      threadId: 'thread-1',
      inProgress: true,
      activeTurnId: 'turn-old',
      streamCursor: { streamEpoch: 'epoch-1', latestSeq: 19, oldestSeq: 1 },
    })

    expect(stale.state).toBe('completed')
    expect(stale.activeTurnId).toBe('')
    expect(stale.streamCursor).toEqual({ streamEpoch: 'epoch-1', latestSeq: 20, oldestSeq: 1 })
  })

  it('keeps queued work queued when an idle session observation arrives', () => {
    const queued = createTaskSnapshot('thread-queued', {
      state: 'running',
      queueDepth: 2,
    })

    const idle = reduceTaskSnapshot(queued, {
      threadId: 'thread-queued',
      inProgress: false,
      activeTurnId: '',
      queue: { depth: 2, oldestQueuedAt: '2026-08-31T00:00:00.000Z', clientIds: ['phone'] },
    })

    expect(idle.state).toBe('queued')
    expect(idle.queueDepth).toBe(2)
    expect(idle.currentActivity).toEqual({ kind: 'queue', label: 'Queued', details: ['2 messages'] })
  })

  it('keeps queued work visible when the current turn completes', () => {
    const running = createTaskSnapshot('thread-queued-after-turn', {
      state: 'running',
      activeTurnId: 'turn-1',
      queueDepth: 1,
    })

    const completed = reduceTaskSnapshot(running, {
      threadId: 'thread-queued-after-turn',
      notification: {
        method: 'turn/completed',
        params: { threadId: 'thread-queued-after-turn', turnId: 'turn-1' },
        atIso: '2026-08-31T00:05:00.000Z',
        seq: 1,
      },
    })

    expect(completed.state).toBe('queued')
    expect(completed.queueDepth).toBe(1)
    expect(completed.currentActivity).toEqual({ kind: 'queue', label: 'Queued', details: ['1 message'] })
  })

  it('projects an externally recorded terminal failure without a stream event', () => {
    const failed = reduceTaskSnapshot(createTaskSnapshot('thread-marker-failure', { state: 'running' }), {
      threadId: 'thread-marker-failure',
      inProgress: false,
      terminalState: 'failed',
      terminalError: 'desktop process exited',
      atIso: '2026-08-31T00:05:01.000Z',
    })

    expect(failed.state).toBe('failed')
    expect(failed.error).toBe('desktop process exited')
    expect(failed.currentActivity).toEqual({ kind: 'error', label: 'Task failed', details: ['desktop process exited'] })
  })

  it('advances the cursor while ignoring a completion for an older active turn', () => {
    const running = createTaskSnapshot('thread-1', {
      state: 'running',
      activeTurnId: 'turn-new',
      streamCursor: { streamEpoch: 'epoch-1', latestSeq: 10, oldestSeq: 1 },
    })

    const lateCompletion = reduceTaskSnapshot(running, {
      threadId: 'thread-1',
      notification: {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turnId: 'turn-old' },
        atIso: '2026-08-31T00:03:01.000Z',
        seq: 11,
        streamEpoch: 'epoch-1',
      },
    })

    expect(lateCompletion.state).toBe('running')
    expect(lateCompletion.activeTurnId).toBe('turn-new')
    expect(lateCompletion.streamCursor?.latestSeq).toBe(11)
  })

  it('ignores delayed item and error frames from the most recently completed turn', () => {
    const completed = reduceTaskSnapshot(createTaskSnapshot('thread-late-items', {
      state: 'running',
      activeTurnId: 'turn-1',
    }), {
      threadId: 'thread-late-items',
      notification: {
        method: 'turn/completed',
        params: { threadId: 'thread-late-items', turnId: 'turn-1' },
        atIso: '2026-08-31T00:06:00.000Z',
        seq: 10,
        streamEpoch: 'epoch-1',
      },
    })

    const lateItem = reduceTaskSnapshot(completed, {
      threadId: 'thread-late-items',
      notification: {
        method: 'item/started',
        params: {
          threadId: 'thread-late-items',
          turnId: 'turn-1',
          item: { type: 'commandExecution', command: 'late command' },
        },
        atIso: '2026-08-31T00:06:01.000Z',
        seq: 11,
        streamEpoch: 'epoch-1',
      },
    })
    const lateError = reduceTaskSnapshot(lateItem, {
      threadId: 'thread-late-items',
      notification: {
        method: 'error',
        params: { threadId: 'thread-late-items', turnId: 'turn-1', message: 'late error' },
        atIso: '2026-08-31T00:06:02.000Z',
        seq: 12,
        streamEpoch: 'epoch-1',
      },
    })

    expect(completed.terminalTurnId).toBe('turn-1')
    expect(lateError.state).toBe('completed')
    expect(lateError.activeTurnId).toBe('')
    expect(lateError.currentActivity).toEqual({ kind: 'idle', label: 'Completed', details: [] })
    expect(lateError.streamCursor?.latestSeq).toBe(12)
  })
})
