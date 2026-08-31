import type {
  TaskActiveRequest,
  TaskActivity,
  TaskObservation,
  TaskSnapshot,
  TaskState,
  TaskTimelineEvent,
} from '../types/task'
import type { RpcNotification } from '../api/codexRpcClient'

const MAX_TIMELINE_EVENTS = 200

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readErrorMessage(value: unknown): string {
  const direct = readString(value)
  if (direct) return direct
  const record = asRecord(value)
  if (!record) return ''
  return readString(record.message) || readErrorMessage(record.error)
}

function notificationErrorMessage(notification: Pick<RpcNotification, 'params'> | null | undefined): string {
  const params = asRecord(notification?.params)
  const turn = asRecord(params?.turn)
  return readErrorMessage(turn?.error)
    || readErrorMessage(params?.error)
    || readString(params?.message)
}

function notificationTurnStatus(notification: Pick<RpcNotification, 'params'> | null | undefined): string {
  const params = asRecord(notification?.params)
  const turn = asRecord(params?.turn)
  return readString(turn?.status) || readString(params?.status)
}

function mergeStreamCursor(
  current: TaskSnapshot['streamCursor'],
  incoming: TaskSnapshot['streamCursor'] | undefined,
  notification: Pick<RpcNotification, 'seq' | 'streamEpoch'> | null | undefined,
): TaskSnapshot['streamCursor'] {
  const candidate = incoming ?? (notification?.seq !== undefined
    ? {
      streamEpoch: notification.streamEpoch ?? '',
      latestSeq: notification.seq,
      oldestSeq: null,
    }
    : undefined)
  if (!candidate) return current
  if (!current) return candidate

  // A notification from an older client build may omit streamEpoch.  Treat it
  // as belonging to the current epoch instead of replacing a useful cursor
  // with an epoch-less value.  Within one epoch cursors are monotonic; a
  // lower snapshot is stale and must not roll the lifecycle back.
  const sameEpoch = !candidate.streamEpoch || !current.streamEpoch || candidate.streamEpoch === current.streamEpoch
  if (sameEpoch && candidate.latestSeq < current.latestSeq) return current
  if (sameEpoch && !candidate.streamEpoch && current.streamEpoch) {
    return {
      ...current,
      latestSeq: Math.max(current.latestSeq, candidate.latestSeq),
      oldestSeq: candidate.oldestSeq ?? current.oldestSeq,
    }
  }
  if (sameEpoch && candidate.streamEpoch === current.streamEpoch) {
    return {
      streamEpoch: current.streamEpoch,
      latestSeq: Math.max(current.latestSeq, candidate.latestSeq),
      oldestSeq: candidate.oldestSeq ?? current.oldestSeq,
    }
  }
  // A different non-empty epoch means the app-server restarted.  Its sequence
  // starts over and must replace the old epoch rather than being compared by
  // number alone.
  return candidate
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
  const item = asRecord(params?.item)
  return readString(turn?.id)
    || readString(params?.turnId)
    || readString(params?.turn_id)
    || readString(item?.turnId)
    || readString(item?.turn_id)
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

function appendTimeline(snapshot: TaskSnapshot, event: TaskTimelineEvent, timeline = snapshot.timeline): TaskTimelineEvent[] {
  const existing = timeline.findIndex((item) => item.id === event.id)
  if (existing >= 0) return timeline
  const next = [...timeline, event]
  return next.length > MAX_TIMELINE_EVENTS ? next.slice(next.length - MAX_TIMELINE_EVENTS) : next
}

function appendQueueTimelineEvent(
  snapshot: TaskSnapshot,
  timeline: TaskTimelineEvent[],
  depth: number,
  atIso: string,
): TaskTimelineEvent[] {
  // Queue state is polled independently from notifications.  Re-reading an
  // unchanged queue must update the current activity without adding another
  // timeline row on every poll.
  if (depth <= 0 || depth === snapshot.queueDepth) return timeline
  const details = [`${depth} message${depth === 1 ? '' : 's'}`]
  const timelineSnapshot = { ...snapshot, timeline }
  return appendTimeline(
    timelineSnapshot,
    makeEvent(timelineSnapshot, 'queued', 'Queued', atIso, details, 'pending'),
    timeline,
  )
}

export function createTaskSnapshot(threadId: string, initial: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    threadId: threadId.trim(),
    state: initial.state ?? 'completed',
    activeTurnId: initial.activeTurnId ?? '',
    terminalTurnId: initial.terminalTurnId ?? '',
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
    ...(initial.fullHydrationDeferred !== undefined ? { fullHydrationDeferred: initial.fullHydrationDeferred } : {}),
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
  let activeTurnId = observation.activeTurnId === undefined ? snapshot.activeTurnId : observation.activeTurnId
  let terminalTurnId = observation.terminalTurnId === undefined ? snapshot.terminalTurnId : observation.terminalTurnId
  let currentActivity = snapshot.currentActivity
  let activeRequest = observation.activeRequest === undefined ? snapshot.activeRequest : observation.activeRequest
  let startedAt = snapshot.startedAt
  let finishedAt = snapshot.finishedAt
  let error = observation.error === undefined ? snapshot.error : observation.error
  let timeline = snapshot.timeline
  let queueDepth = observation.queue?.depth ?? snapshot.queueDepth
  const fullHydrationDeferred = observation.fullHydrationDeferred === undefined
    ? snapshot.fullHydrationDeferred
    : observation.fullHydrationDeferred
  let queueTimelineAppended = false
  let lastStateEventAtMs: number | null = null

  // Notifications can be replayed after a reconnect.  A frame that is
  // already represented by the snapshot must not move a completed task back
  // to an earlier lifecycle state.
  const notificationSeq = notification?.seq
  const snapshotCursor = snapshot.streamCursor
  if (
    notificationSeq !== undefined
    && snapshotCursor
    && (!notification?.streamEpoch || !snapshotCursor.streamEpoch || notification.streamEpoch === snapshotCursor.streamEpoch)
    && notificationSeq <= snapshotCursor.latestSeq
  ) {
    return snapshot
  }
  if (
    observation.streamCursor
    && snapshotCursor
    && (!observation.streamCursor.streamEpoch || !snapshotCursor.streamEpoch || observation.streamCursor.streamEpoch === snapshotCursor.streamEpoch)
    && observation.streamCursor.latestSeq < snapshotCursor.latestSeq
  ) {
    return snapshot
  }

  const eventMatchesActiveTurn = !turnId || !activeTurnId || turnId === activeTurnId
  // Once a turn reaches a terminal state, its active ID is intentionally
  // cleared.  Delayed item/error frames from that same turn can therefore
  // arrive with no active ID to compare against.  Retaining the terminal ID
  // lets us ignore those frames instead of resurrecting a completed task.
  const isLateTerminalTurnEvent = Boolean(
    turnId
    && terminalTurnId
    && turnId === terminalTurnId
    && !activeTurnId
    && ['queued', 'completed', 'failed', 'canceled'].includes(state),
  )
  const isForeignActiveTurnEvent = Boolean(
    turnId
    && activeTurnId
    && turnId !== activeTurnId
    && method !== 'turn/started'
    && !method.startsWith('queue/'),
  )
  if (isForeignActiveTurnEvent || (isLateTerminalTurnEvent && method !== 'queue/enqueued' && method !== 'queue/updated')) {
    return {
      ...snapshot,
      streamCursor: mergeStreamCursor(snapshot.streamCursor, observation.streamCursor, notification),
      revision: observation.revision ?? snapshot.revision,
    }
  }

  // Pending requests are also hydrated on reconnect, without a notification.
  // Promote those snapshots to the same waiting states as live events.
  if (observation.activeRequest?.kind === 'approval') {
    state = 'waiting_approval'
    currentActivity = { kind: 'approval', label: 'Approval required', details: [] }
  } else if (observation.activeRequest?.kind === 'user_input') {
    state = 'waiting_user_input'
    currentActivity = { kind: 'user_input', label: 'Input required', details: [] }
  } else if (observation.activeRequest === null && (state === 'waiting_approval' || state === 'waiting_user_input')) {
    state = 'running'
    currentActivity = { kind: 'thinking', label: 'Thinking', details: [] }
  }

  if (observation.queue) {
    if (observation.queue.depth > 0 && !observation.inProgress && !['running', 'starting', 'steering', 'waiting_approval', 'waiting_user_input'].includes(state)) {
      state = 'queued'
      currentActivity = { kind: 'queue', label: 'Queued', details: [`${observation.queue.depth} message${observation.queue.depth === 1 ? '' : 's'}`] }
      const nextTimeline = appendQueueTimelineEvent(snapshot, timeline, observation.queue.depth, atIso)
      queueTimelineAppended = nextTimeline !== timeline
      timeline = nextTimeline
    }
  }

  if (method === 'queue/enqueued' || method === 'queue/updated') {
    const params = asRecord(notification?.params)
    const queueStatus = readString(params?.status).toLowerCase()
    const parsedQueueDepth = typeof params?.queueDepth === 'number' && Number.isFinite(params.queueDepth)
      ? Math.max(0, Math.trunc(params.queueDepth))
      : observation.queue?.depth ?? snapshot.queueDepth
    queueDepth = parsedQueueDepth
    if (queueStatus === 'processing') {
      // The queue worker removes the message before it can issue
      // turn/start.  Keep the task active during that hand-off so a queue
      // poll cannot briefly paint it as completed.
      state = 'starting'
      startedAt = startedAt ?? atIso
      finishedAt = null
      error = null
      currentActivity = { kind: 'thinking', label: 'Thinking', details: [] }
      const eventAtMs = Date.parse(atIso)
      lastStateEventAtMs = Number.isFinite(eventAtMs) ? eventAtMs : null
    } else if (parsedQueueDepth > 0 && queueStatus === 'failed') {
      // The worker restores a message after a failed start.  `starting` is
      // only the short hand-off state; once the message is back in storage it
      // must be shown as queued so clients do not wait for a phantom turn.
      state = 'queued'
      finishedAt = null
      activeTurnId = ''
      currentActivity = { kind: 'queue', label: 'Queued', details: [`${parsedQueueDepth} message${parsedQueueDepth === 1 ? '' : 's'}`] }
      if (!queueTimelineAppended) {
        timeline = appendQueueTimelineEvent(snapshot, timeline, parsedQueueDepth, atIso)
      }
    } else if (parsedQueueDepth === 0 && state === 'queued') {
      // Remove/reorder responses can be the only signal after the last queued
      // item disappears.  With no active session marker this is a terminal
      // idle state, not a queue that still needs draining.
      state = 'completed'
      finishedAt = atIso
      activeTurnId = ''
      error = null
      activeRequest = null
      currentActivity = { kind: 'idle', label: 'Completed', details: [] }
    } else if (parsedQueueDepth > 0 && !['starting', 'running', 'steering', 'waiting_approval', 'waiting_user_input'].includes(state)) {
      state = 'queued'
      currentActivity = { kind: 'queue', label: 'Queued', details: [`${parsedQueueDepth} message${parsedQueueDepth === 1 ? '' : 's'}`] }
      if (!queueTimelineAppended) {
        timeline = appendQueueTimelineEvent(snapshot, timeline, parsedQueueDepth, atIso)
      }
    }
  }

  if (observation.inProgress === true && (
    state === 'completed'
    || state === 'failed'
    || state === 'canceled'
    || state === 'queued'
  )) {
    state = 'running'
    // A new turn supersedes any terminal metadata from the previous turn.
    // Keeping the old finishedAt/error/activity makes a retry look failed
    // (and can suppress the spinner because sidebar flags use task state).
    startedAt = atIso
    finishedAt = null
    error = null
    activeRequest = null
    currentActivity = { kind: 'thinking', label: 'Thinking', details: [] }
  } else if (observation.inProgress === false && !method) {
    if (queueDepth > 0) {
      state = 'queued'
      finishedAt = null
      error = null
      activeRequest = null
      activeTurnId = ''
      currentActivity = { kind: 'queue', label: 'Queued', details: [`${queueDepth} message${queueDepth === 1 ? '' : 's'}`] }
    } else if (observation.terminalState === 'failed') {
      state = 'failed'
      finishedAt = atIso
      activeRequest = null
      activeTurnId = ''
      error = observation.terminalError?.trim() || observation.error || 'Task failed'
      currentActivity = { kind: 'error', label: 'Task failed', details: [error] }
    } else if (observation.terminalState === 'canceled') {
      state = 'canceled'
      finishedAt = atIso
      activeRequest = null
      activeTurnId = ''
      error = null
      currentActivity = { kind: 'idle', label: 'Canceled', details: [] }
    } else if (state === 'running' || state === 'starting' || state === 'steering' || state === 'waiting_approval' || state === 'waiting_user_input') {
      state = 'completed'
      finishedAt = atIso
      error = null
      activeRequest = null
      currentActivity = { kind: 'idle', label: 'Completed', details: [] }
      activeTurnId = ''
    } else if (state === 'queued' && observation.queue?.depth === 0) {
      state = 'completed'
      finishedAt = atIso
      error = null
      activeRequest = null
      currentActivity = { kind: 'idle', label: 'Completed', details: [] }
      activeTurnId = ''
    }
  }

  if (method === 'turn/started') {
    state = 'starting'
    startedAt = startedAt ?? atIso
    finishedAt = null
    error = null
    activeTurnId = turnId || activeTurnId
    currentActivity = { kind: 'thinking', label: 'Thinking', details: [] }
    const eventAtMs = Date.parse(atIso)
    lastStateEventAtMs = Number.isFinite(eventAtMs) ? eventAtMs : null
    timeline = appendTimeline(snapshot, makeEvent(snapshot, 'task_started', 'Task started', atIso, [], 'active'))
  } else if (method === 'turn/steer') {
    state = 'steering'
    currentActivity = { kind: 'thinking', label: 'Steering task', details: [] }
  } else if (method === 'turn/interrupt') {
    if (!eventMatchesActiveTurn || isLateTerminalTurnEvent) {
      return {
        ...snapshot,
        streamCursor: mergeStreamCursor(snapshot.streamCursor, observation.streamCursor, notification),
        revision: observation.revision ?? snapshot.revision,
      }
    }
    state = 'canceled'
    finishedAt = atIso
    activeRequest = null
    activeTurnId = ''
    terminalTurnId = turnId || terminalTurnId
    error = null
    currentActivity = { kind: 'idle', label: 'Canceled', details: [] }
    const eventAtMs = Date.parse(atIso)
    lastStateEventAtMs = Number.isFinite(eventAtMs) ? eventAtMs : null
    timeline = appendTimeline(snapshot, makeEvent(snapshot, 'task_canceled', 'Task canceled', atIso, [], 'canceled'))
  } else if (method === 'turn/completed') {
    if (!eventMatchesActiveTurn || isLateTerminalTurnEvent) {
      return {
        ...snapshot,
        streamCursor: mergeStreamCursor(snapshot.streamCursor, observation.streamCursor, notification),
        revision: observation.revision ?? snapshot.revision,
      }
    }
    const completionError = notificationErrorMessage(notification)
    const failed = notificationTurnStatus(notification).toLowerCase() === 'failed' || Boolean(completionError)
    state = failed ? 'failed' : 'completed'
    finishedAt = atIso
    activeRequest = null
    activeTurnId = ''
    terminalTurnId = turnId || terminalTurnId
    if (failed) {
      error = completionError || observation.error || 'Task failed'
      currentActivity = { kind: 'error', label: 'Task failed', details: error ? [error] : [] }
      timeline = appendTimeline(snapshot, makeEvent(snapshot, 'error', 'Task failed', atIso, error ? [error] : [], 'failed'))
    } else {
      error = null
      currentActivity = { kind: 'idle', label: 'Completed', details: [] }
      timeline = appendTimeline(snapshot, makeEvent(snapshot, 'task_completed', 'Task completed', atIso, [], 'completed'))
    }
    // A turn can finish while another message is already persisted in the
    // shared queue.  Keep the task-center state queued until that next turn
    // is handed off; otherwise observers briefly show Completed and may route
    // a new send directly into a writer conflict.
    if (queueDepth > 0) {
      state = 'queued'
      error = null
      currentActivity = { kind: 'queue', label: 'Queued', details: [`${queueDepth} message${queueDepth === 1 ? '' : 's'}`] }
    }
    const eventAtMs = Date.parse(atIso)
    lastStateEventAtMs = Number.isFinite(eventAtMs) ? eventAtMs : null
  } else if (method === 'error') {
    if (!eventMatchesActiveTurn || isLateTerminalTurnEvent) {
      return {
        ...snapshot,
        streamCursor: mergeStreamCursor(snapshot.streamCursor, observation.streamCursor, notification),
        revision: observation.revision ?? snapshot.revision,
      }
    }
    const params = asRecord(notification?.params)
    const retryable = params?.willRetry === true
    error = readString(params?.message) || readErrorMessage(params?.error) || observation.error || 'Task failed'
    if (retryable) {
      state = ['starting', 'running', 'steering', 'waiting_approval', 'waiting_user_input'].includes(state)
        ? state
        : 'running'
      currentActivity = { kind: 'error', label: 'Retrying task', details: error ? [error] : [] }
      timeline = appendTimeline(snapshot, makeEvent(snapshot, 'error', 'Retrying task', atIso, error ? [error] : [], 'active'))
    } else {
      state = 'failed'
      finishedAt = atIso
      terminalTurnId = turnId || terminalTurnId
      currentActivity = { kind: 'error', label: 'Task failed', details: error ? [error] : [] }
      timeline = appendTimeline(snapshot, makeEvent(snapshot, 'error', 'Task failed', atIso, error ? [error] : [], 'failed'))
    }
    const eventAtMs = Date.parse(atIso)
    lastStateEventAtMs = Number.isFinite(eventAtMs) ? eventAtMs : null
  } else if (method === 'server/request') {
    if (isLateTerminalTurnEvent) {
      return {
        ...snapshot,
        streamCursor: mergeStreamCursor(snapshot.streamCursor, observation.streamCursor, notification),
        revision: observation.revision ?? snapshot.revision,
      }
    }
    const params = asRecord(notification?.params)
    const id = typeof params?.id === 'number' ? params.id : 0
    const requestMethod = readString(params?.method) || readString(params?.requestMethod)
    const kind = requestKind(requestMethod)
    activeRequest = { id, kind, method: requestMethod, receivedAtIso: atIso }
    state = kind === 'approval' ? 'waiting_approval' : kind === 'user_input' ? 'waiting_user_input' : state
    currentActivity = activityForNotification(method, { ...params, method: requestMethod }) ?? currentActivity
    timeline = appendTimeline(snapshot, makeEvent(snapshot, kind === 'approval' ? 'approval_request' : 'user_input_request', currentActivity.label, atIso, [], 'pending'))
  } else if (method === 'server/request/resolved') {
    const params = asRecord(notification?.params)
    const resolvedId = typeof params?.id === 'number' && Number.isInteger(params.id) ? params.id : null
    const resolvesCurrentRequest = resolvedId === null
      || activeRequest === null
      || activeRequest.id === resolvedId
    if (resolvesCurrentRequest) {
      activeRequest = null
      if (state === 'waiting_approval' || state === 'waiting_user_input') state = 'running'
      currentActivity = { kind: 'thinking', label: 'Thinking', details: [] }
    }
  } else {
    if (isLateTerminalTurnEvent) {
      return {
        ...snapshot,
        streamCursor: mergeStreamCursor(snapshot.streamCursor, observation.streamCursor, notification),
        revision: observation.revision ?? snapshot.revision,
      }
    }
    const activity = notification ? activityForNotification(method, notification.params) : null
    if (activity) {
      currentActivity = activity
      // Activity notifications can be the first frame observed after a
      // reconnect (the corresponding turn/started frame may have been
      // dropped).  They are positive evidence that the task is executing;
      // leaving a completed/queued snapshot untouched would keep every
      // client showing an idle task until the next full poll.
      if (['completed', 'failed', 'canceled', 'queued', 'starting', 'steering'].includes(state)) {
        state = 'running'
        finishedAt = null
        error = null
        startedAt = startedAt ?? atIso
        activeTurnId = turnId || activeTurnId
      }
      timeline = appendTimeline(snapshot, makeEvent(snapshot, 'activity', activity.label, atIso, activity.details, 'active'))
    }
  }

  const streamCursor = mergeStreamCursor(snapshot.streamCursor, observation.streamCursor, notification)
  return {
    ...snapshot,
    threadId,
    state,
    activeTurnId,
    terminalTurnId,
    currentActivity,
    queueDepth,
    activeRequest,
    writerClient: observation.writerClient === undefined ? snapshot.writerClient : observation.writerClient,
    startedAt,
    finishedAt,
    streamCursor,
    timeline,
    error,
    revision: observation.revision ?? snapshot.revision,
    ...(fullHydrationDeferred !== undefined ? { fullHydrationDeferred } : {}),
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
