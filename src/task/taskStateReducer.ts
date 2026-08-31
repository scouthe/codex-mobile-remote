import type {
  TaskActiveRequest,
  TaskActivity,
  TaskObservation,
  TaskSnapshot,
  TaskState,
  TaskTimelineEvent,
} from '../types/task'

const MAX_TIMELINE_EVENTS = 200

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function notificationThreadId(observation: TaskObservation): string {
  const params = asRecord(observation.notification?.params)
  return observation.threadId.trim()
    || readString(params?.threadId)
    || readString(params?.thread_id)
}

function notificationTurnId(observation: TaskObservation): string {
  const params = asRecord(observation.notification?.params)
  const turn = asRecord(params?.turn)
  return readString(turn?.id) || readString(params?.turnId) || readString(params?.turn_id)
}

function requestKind(method: string): TaskActiveRequest['kind'] {
  const value = method.toLowerCase()
  if (value.includes('approval') || value.includes('permission')) return 'approval'
  if (value.includes('user_input') || value.includes('requestuserinput') || value.includes('input')) return 'user_input'
  return 'other'
}

function activityForNotification(method: string, params: unknown): TaskActivity | null {
  const record = asRecord(params)
  const item = asRecord(record?.item)
  const type = readString(item?.type).toLowerCase()
  if (method === 'turn/started' || type === 'reasoning') return { kind: 'thinking', label: 'Thinking', details: [] }
  if (type === 'commandexecution' || method === 'item/commandExecution/outputDelta') {
    const command = readString(item?.command)
    return { kind: 'command', label: 'Running command', details: command ? [command] : [] }
  }
  if (type === 'filechange' || method === 'item/fileChange/outputDelta') {
    const changes = Array.isArray(item?.changes) ? item.changes : []
    const path = readString(asRecord(changes[0])?.path)
    return { kind: 'file_change', label: 'Applying changes', details: path ? [path] : [] }
  }
  if (type === 'agentmessage' || method === 'item/agentMessage/delta') return { kind: 'response', label: 'Writing response', details: [] }
  if (method === 'server/request') {
    const request = requestKind(readString(record?.method) || readString(record?.requestMethod))
    return request === 'approval'
      ? { kind: 'approval', label: 'Approval required', details: [] }
      : request === 'user_input'
        ? { kind: 'user_input', label: 'Input required', details: [] }
        : null
  }
  return null
}

function makeEvent(
  snapshot: TaskSnapshot,
  type: TaskTimelineEvent['type'],
  label: string,
  atIso: string,
  details: string[] = [],
  status?: TaskTimelineEvent['status'],
  itemId?: string,
): TaskTimelineEvent {
  const notificationSeq = snapshot.streamCursor?.latestSeq ?? 0
  const id = `${snapshot.threadId}:${notificationSeq}:${type}:${snapshot.timeline.length}`
  return { id, type, atIso, label, details, turnId: '', status, itemId }
}

function appendTimeline(snapshot: TaskSnapshot, event: TaskTimelineEvent): TaskTimelineEvent[] {
  const existing = snapshot.timeline.findIndex((item) => item.id === event.id)
  if (existing >= 0) return snapshot.timeline
  const next = [...snapshot.timeline, event]
  return next.length > MAX_TIMELINE_EVENTS ? next.slice(next.length - MAX_TIMELINE_EVENTS) : next
}

export function createTaskSnapshot(threadId: string, initial: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    threadId: threadId.trim(),
    state: initial.state ?? 'completed',
    currentActivity: initial.currentActivity ?? { kind: 'idle', label: 'Idle', details: [] },
    queueDepth: initial.queueDepth ?? 0,
    activeRequest: initial.activeRequest ?? null,
    writerClient: initial.writerClient ?? null,
    startedAt: initial.startedAt ?? null,
    finishedAt: initial.finishedAt ?? null,
    streamCursor: initial.streamCursor ?? null,
    timeline: initial.timeline ?? [],
    error: initial.error ?? null,
    revision: initial.revision ?? '',
  }
}

export function reduceTaskSnapshot(previous: TaskSnapshot | undefined, observation: TaskObservation): TaskSnapshot {
  const threadId = notificationThreadId(observation)
  const snapshot = previous ?? createTaskSnapshot(threadId)
  if (!threadId || (snapshot.threadId && snapshot.threadId !== threadId)) return snapshot
  const notification = observation.notification
  const method = notification?.method ?? ''
  const atIso = observation.atIso ?? notification?.atIso ?? new Date().toISOString()
  const turnId = notification ? notificationTurnId(observation) : ''
  let state = snapshot.state
  let currentActivity = snapshot.currentActivity
  let activeRequest = observation.activeRequest === undefined ? snapshot.activeRequest : observation.activeRequest
  let startedAt = snapshot.startedAt
  let finishedAt = snapshot.finishedAt
  let error = observation.error === undefined ? snapshot.error : observation.error
  let timeline = snapshot.timeline

  if (observation.queue) {
    if (observation.queue.depth > 0 && !observation.inProgress && !['running', 'starting', 'steering', 'waiting_approval', 'waiting_user_input'].includes(state)) {
      state = 'queued'
      currentActivity = { kind: 'queue', label: 'Queued', details: [`${observation.queue.depth} message${observation.queue.depth === 1 ? '' : 's'}`] }
      timeline = appendTimeline(snapshot, makeEvent(snapshot, 'queued', 'Queued', atIso, currentActivity.details, 'pending'))
    }
  }

  if (observation.inProgress === true && state === 'completed') {
    state = 'running'
    startedAt = startedAt ?? atIso
  } else if (observation.inProgress === false && !method) {
    if (state === 'running' || state === 'starting' || state === 'steering' || state === 'waiting_approval' || state === 'waiting_user_input') {
      state = 'completed'
      finishedAt = atIso
      currentActivity = { kind: 'idle', label: 'Completed', details: [] }
    }
  }

  if (method === 'turn/started') {
    state = 'starting'
    startedAt = startedAt ?? atIso
    finishedAt = null
    error = null
    currentActivity = { kind: 'thinking', label: 'Thinking', details: [] }
    timeline = appendTimeline(snapshot, makeEvent(snapshot, 'task_started', 'Task started', atIso, [], 'active'))
  } else if (method === 'turn/steer') {
    state = 'steering'
    currentActivity = { kind: 'thinking', label: 'Steering task', details: [] }
  } else if (method === 'turn/interrupt') {
    state = 'canceled'
    finishedAt = atIso
    activeRequest = null
    currentActivity = { kind: 'idle', label: 'Canceled', details: [] }
    timeline = appendTimeline(snapshot, makeEvent(snapshot, 'task_canceled', 'Task canceled', atIso, [], 'canceled'))
  } else if (method === 'turn/completed') {
    state = 'completed'
    finishedAt = atIso
    activeRequest = null
    currentActivity = { kind: 'idle', label: 'Completed', details: [] }
    timeline = appendTimeline(snapshot, makeEvent(snapshot, 'task_completed', 'Task completed', atIso, [], 'completed'))
  } else if (method === 'error') {
    state = 'failed'
    finishedAt = atIso
    error = readString(asRecord(notification?.params)?.message) || observation.error || 'Task failed'
    currentActivity = { kind: 'error', label: 'Task failed', details: error ? [error] : [] }
    timeline = appendTimeline(snapshot, makeEvent(snapshot, 'error', 'Task failed', atIso, error ? [error] : [], 'failed'))
  } else if (method === 'server/request') {
    const params = asRecord(notification?.params)
    const id = typeof params?.id === 'number' ? params.id : 0
    const requestMethod = readString(params?.method) || readString(params?.requestMethod)
    const kind = requestKind(requestMethod)
    activeRequest = { id, kind, method: requestMethod, receivedAtIso: atIso }
    state = kind === 'approval' ? 'waiting_approval' : kind === 'user_input' ? 'waiting_user_input' : state
    currentActivity = activityForNotification(method, { ...params, method: requestMethod }) ?? currentActivity
    timeline = appendTimeline(snapshot, makeEvent(snapshot, kind === 'approval' ? 'approval_request' : 'user_input_request', currentActivity.label, atIso, [], 'pending'))
  } else if (method === 'server/request/resolved') {
    activeRequest = null
    if (state === 'waiting_approval' || state === 'waiting_user_input') state = 'running'
    currentActivity = { kind: 'thinking', label: 'Thinking', details: [] }
  } else {
    const activity = notification ? activityForNotification(method, notification.params) : null
    if (activity) {
      currentActivity = activity
      if (state === 'starting' || state === 'steering') state = 'running'
      timeline = appendTimeline(snapshot, makeEvent(snapshot, 'activity', activity.label, atIso, activity.details, 'active'))
    }
  }

  const streamCursor = observation.streamCursor ?? (notification?.seq !== undefined
    ? { streamEpoch: notification.streamEpoch ?? '', latestSeq: notification.seq, oldestSeq: null }
    : snapshot.streamCursor)
  return {
    ...snapshot,
    threadId,
    state,
    currentActivity,
    queueDepth: observation.queue?.depth ?? snapshot.queueDepth,
    activeRequest,
    writerClient: observation.writerClient === undefined ? snapshot.writerClient : observation.writerClient,
    startedAt,
    finishedAt,
    streamCursor,
    timeline,
    error,
    revision: observation.revision ?? snapshot.revision,
  }
}

export function reduceTaskSnapshots(
  snapshots: Record<string, TaskSnapshot>,
  observation: TaskObservation,
): Record<string, TaskSnapshot> {
  const threadId = observation.threadId.trim()
  if (!threadId) return snapshots
  return { ...snapshots, [threadId]: reduceTaskSnapshot(snapshots[threadId], observation) }
}

