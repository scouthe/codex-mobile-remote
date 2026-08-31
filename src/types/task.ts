import type { RpcNotification } from '../api/codexRpcClient'

/** Lifecycle states exposed to every Codex client. */
export type TaskState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user_input'
  | 'steering'
  | 'completed'
  | 'failed'
  | 'canceled'

export type TaskOperation = 'send' | 'steer' | 'interrupt'
export type TaskClientType = 'desktop' | 'android' | 'web' | 'unknown'

export type TaskWriterIdentity = {
  clientId: string
  clientType: TaskClientType
  generation: number | null
  label: string
  claimedAt: string
}

export type TaskActivity = {
  kind: 'thinking' | 'command' | 'file_change' | 'response' | 'approval' | 'user_input' | 'queue' | 'error' | 'idle'
  label: string
  details: string[]
}

export type TaskTimelineEventType =
  | 'task_started'
  | 'activity'
  | 'command'
  | 'file_change'
  | 'approval_request'
  | 'user_input_request'
  | 'error'
  | 'task_completed'
  | 'task_canceled'
  | 'queued'

export type TaskTimelineEvent = {
  id: string
  type: TaskTimelineEventType
  atIso: string
  label: string
  details: string[]
  turnId: string
  itemId?: string
  status?: 'active' | 'completed' | 'failed' | 'canceled' | 'pending'
}

export type TaskQueueSummary = {
  depth: number
  oldestQueuedAt: string | null
  clientIds: string[]
}

export type TaskStreamCursor = {
  streamEpoch: string
  latestSeq: number
  oldestSeq: number | null
}

export type TaskActiveRequest = {
  id: number
  kind: 'approval' | 'user_input' | 'other'
  method: string
  receivedAtIso: string
}

export type TaskSnapshot = {
  threadId: string
  state: TaskState
  /** The turn currently owning the task, when the session exposes one. */
  activeTurnId: string
  /** The most recently terminal turn, retained to reject delayed old events. */
  terminalTurnId: string
  currentActivity: TaskActivity
  queueDepth: number
  activeRequest: TaskActiveRequest | null
  writerClient: TaskWriterIdentity | null
  startedAt: string | null
  finishedAt: string | null
  streamCursor: TaskStreamCursor | null
  timeline: TaskTimelineEvent[]
  error: string | null
  revision: string
}

export type TaskObservation = {
  threadId: string
  atIso?: string
  notification?: Pick<RpcNotification, 'method' | 'params' | 'atIso' | 'seq' | 'streamEpoch'>
  inProgress?: boolean
  activeTurnId?: string
  terminalTurnId?: string
  queue?: TaskQueueSummary
  activeRequest?: TaskActiveRequest | null
  writerClient?: TaskWriterIdentity | null
  streamCursor?: TaskStreamCursor | null
  error?: string | null
  /** Terminal state observed from the shared session marker. */
  terminalState?: 'completed' | 'failed' | 'canceled' | ''
  terminalError?: string
  revision?: string
}

export type TaskStateTransition = {
  from: TaskState | '*'
  event: string
  to: TaskState
}

export const TASK_STATE_TRANSITIONS: readonly TaskStateTransition[] = [
  { from: '*', event: 'queue/enqueued', to: 'queued' },
  { from: 'queued', event: 'queue/updated:processing', to: 'starting' },
  { from: 'queued', event: 'turn/started', to: 'starting' },
  { from: 'starting', event: 'item/started', to: 'running' },
  { from: 'starting', event: 'activity', to: 'running' },
  { from: 'running', event: 'server/request:approval', to: 'waiting_approval' },
  { from: 'running', event: 'server/request:user_input', to: 'waiting_user_input' },
  { from: 'waiting_approval', event: 'server/request/resolved', to: 'running' },
  { from: 'waiting_user_input', event: 'server/request/resolved', to: 'running' },
  { from: '*', event: 'turn/steer', to: 'steering' },
  { from: 'steering', event: 'activity', to: 'running' },
  { from: '*', event: 'turn/completed', to: 'completed' },
  { from: '*', event: 'turn/interrupt', to: 'canceled' },
  { from: '*', event: 'error', to: 'failed' },
]
