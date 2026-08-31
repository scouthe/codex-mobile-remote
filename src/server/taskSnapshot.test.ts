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
    )

    expect(snapshot.taskState).toBe('waiting_approval')
    expect(snapshot.queueDepth).toBe(2)
    expect(snapshot.activeRequest?.kind).toBe('approval')
    expect(snapshot.currentActivity.label).toBe('Approval required')
    expect(snapshot.timeline).toHaveLength(2)
  })
})

