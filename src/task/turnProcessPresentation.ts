import type { UiMessage } from '../types/codex'

export type TurnProcessGroup = {
  key: string
  firstMessageId: string
  messageIds: string[]
  durationMs: number | null
  status: UiMessage['turnStatus']
  fallbackLabel: string
}

function turnKey(message: UiMessage): string {
  const turnId = message.turnId?.trim()
  if (turnId) return `turn:${turnId}`
  return typeof message.turnIndex === 'number' ? `index:${message.turnIndex}` : ''
}

export function isTurnProcessMessage(message: UiMessage): boolean {
  if (message.messageType === 'commandExecution' || message.messageType === 'fileChange') {
    return true
  }
  return (message.messageType === 'agentMessage' || message.messageType === 'agentMessage.live')
    && message.messagePhase === 'commentary'
}

export function buildTurnProcessPresentation(messages: UiMessage[]): {
  groupByMessageId: Map<string, TurnProcessGroup>
  firstGroupByMessageId: Map<string, TurnProcessGroup>
  suppressedWorkedIds: Set<string>
} {
  const metadataByTurn = new Map<string, { durationMs: number | null; status: UiMessage['turnStatus']; fallbackLabel: string }>()
  for (const message of messages) {
    const key = turnKey(message)
    if (!key) continue
    const metadata = metadataByTurn.get(key) ?? { durationMs: null, status: undefined, fallbackLabel: '' }
    if (typeof message.turnDurationMs === 'number' && Number.isFinite(message.turnDurationMs)) {
      metadata.durationMs = Math.max(0, message.turnDurationMs)
    }
    if (message.turnStatus) metadata.status = message.turnStatus
    if (message.messageType === 'worked') metadata.fallbackLabel = message.text.trim()
    metadataByTurn.set(key, metadata)
  }

  const groupsByTurn = new Map<string, TurnProcessGroup>()
  const groupByMessageId = new Map<string, TurnProcessGroup>()
  const firstGroupByMessageId = new Map<string, TurnProcessGroup>()
  const suppressedWorkedIds = new Set<string>()
  for (const message of messages) {
    if (!isTurnProcessMessage(message)) continue
    const key = turnKey(message)
    if (!key) continue
    let group = groupsByTurn.get(key)
    if (!group) {
      const metadata = metadataByTurn.get(key)
      group = {
        key,
        firstMessageId: message.id,
        messageIds: [],
        durationMs: metadata?.durationMs ?? null,
        status: metadata?.status,
        fallbackLabel: metadata?.fallbackLabel ?? '',
      }
      groupsByTurn.set(key, group)
      firstGroupByMessageId.set(message.id, group)
    }
    group.messageIds.push(message.id)
    groupByMessageId.set(message.id, group)
  }
  for (const message of messages) {
    if (message.messageType === 'worked' && groupsByTurn.has(turnKey(message))) {
      suppressedWorkedIds.add(message.id)
    }
  }
  return { groupByMessageId, firstGroupByMessageId, suppressedWorkedIds }
}

export function formatTurnProcessLabel(group: TurnProcessGroup): string {
  if (group.durationMs !== null) {
    if (group.durationMs < 1000) return 'Worked for <1s'
    const totalSeconds = Math.round(group.durationMs / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const parts = [hours > 0 ? `${hours}h` : '', minutes > 0 || hours > 0 ? `${minutes}m` : '', `${seconds}s`]
    return `Worked for ${parts.filter(Boolean).join(' ')}`
  }
  if (group.fallbackLabel) return group.fallbackLabel
  return group.status === 'inProgress' ? 'Working' : 'Work details'
}
