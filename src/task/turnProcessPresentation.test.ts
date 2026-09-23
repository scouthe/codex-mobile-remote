import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import { buildTurnProcessPresentation, formatTurnProcessLabel } from './turnProcessPresentation'

function message(id: string, turnId: string, overrides: Partial<UiMessage> = {}): UiMessage {
  return { id, turnId, role: 'assistant', text: id, messageType: 'agentMessage', ...overrides }
}

describe('turn process presentation', () => {
  it('folds commentary and tool activity for one turn while leaving its final answer visible', () => {
    const messages = [
      message('user', 'turn-1', { role: 'user', messageType: 'userMessage' }),
      message('commentary-1', 'turn-1', { messagePhase: 'commentary', turnDurationMs: 98_000 }),
      message('command-1', 'turn-1', { role: 'system', messageType: 'commandExecution' }),
      message('commentary-2', 'turn-1', { messagePhase: 'commentary' }),
      message('worked', 'turn-1', { role: 'system', messageType: 'worked', text: 'Worked for 1m 38s' }),
      message('final-1', 'turn-1', { messagePhase: 'final_answer' }),
    ]

    const presentation = buildTurnProcessPresentation(messages)
    const group = presentation.firstGroupByMessageId.get('commentary-1')
    expect(group?.messageIds).toEqual(['commentary-1', 'command-1', 'commentary-2'])
    expect(formatTurnProcessLabel(group!)).toBe('Worked for 1m 38s')
    expect(presentation.groupByMessageId.has('final-1')).toBe(false)
    expect(presentation.groupByMessageId.has('user')).toBe(false)
    expect(presentation.suppressedWorkedIds.has('worked')).toBe(true)
  })

  it('does not hide phase-unknown assistant messages or fold errors', () => {
    const messages = [
      message('legacy', 'turn-2'),
      message('error', 'turn-2', { role: 'system', messageType: 'turnError' }),
      message('final', 'turn-2', { messagePhase: 'final_answer' }),
    ]
    const presentation = buildTurnProcessPresentation(messages)
    expect(presentation.groupByMessageId.size).toBe(0)
  })

  it('uses the visible window and keeps separate turns separate', () => {
    const presentation = buildTurnProcessPresentation([
      message('commentary-2', 'turn-2', { messagePhase: 'commentary', turnStatus: 'inProgress' }),
      message('final-2', 'turn-2', { messagePhase: 'final_answer' }),
      message('commentary-3', 'turn-3', { messagePhase: 'commentary', turnDurationMs: 500 }),
    ])
    expect(presentation.firstGroupByMessageId.get('commentary-2')?.key).toBe('turn:turn-2')
    expect(formatTurnProcessLabel(presentation.firstGroupByMessageId.get('commentary-2')!)).toBe('Working')
    expect(formatTurnProcessLabel(presentation.firstGroupByMessageId.get('commentary-3')!)).toBe('Worked for <1s')
  })
})
