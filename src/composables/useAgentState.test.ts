import { describe, expect, it } from 'vitest'
import { mergeAgentDetail, reconcileAgentSessionList } from './useAgentState'
import type { AgentSessionDetail } from '../types/agent'

function detail(revision: number, messages: Array<[string, string]>, cursor: number | null = null): AgentSessionDetail {
  return { session: { id: 'session', nativeId: 'native', agentId: 'dsh', title: '测试', cwd: '/tmp', createdAt: '', updatedAt: '', state: 'idle', error: '', runId: '', lastRequestId: '', archived: false, revision }, messages: messages.map(([id, text]) => ({ id, text, role: 'assistant' })), configOptions: [], permissions: [], imagesSupported: false, nextCursor: cursor }
}
describe('DSH durable/live reconciliation', () => {
  it('does not hide a newly created chat or resurrect an archived chat behind a slow list', () => {
    const old = detail(1, []).session
    const added = { ...old, id: 'new-session' }
    const known = new Map([[old.id, { ...old, archived: true, revision: 2 }], [added.id, added]])
    expect(reconcileAgentSessionList([old], known, new Map([[old.id, 1]]))).toEqual([added])
    // A fresh list can also remove an unchanged record missed while offline.
    expect(reconcileAgentSessionList([], new Map([[old.id, old]]), new Map([[old.id, old.revision]]))).toEqual([])
  })
  it('does not roll back live output when a slower snapshot or older page arrives', () => {
    const current = detail(10, [['reply', '完整回复'], ['next', '后续消息']], 5)
    const stale = detail(8, [['reply', '旧回复']], 4)
    expect(mergeAgentDetail(current, stale).messages).toEqual(current.messages)
    const earlier = detail(10, [['old', '历史消息'], ['reply', '很早的工具快照']], null)
    const merged = mergeAgentDetail(current, earlier, true)
    expect(merged.messages.map(message => message.text)).toEqual(['历史消息', '完整回复', '后续消息'])
    expect(merged.nextCursor).toBeNull()
  })
  it('replaces semantic updates in place and keeps previously loaded history', () => {
    const current = detail(5, [['old', '历史'], ['reply', '部分']], 1)
    const fresh = detail(6, [['reply', '完整'], ['next', '新消息']], 5)
    expect(mergeAgentDetail(current, fresh).messages.map(message => message.text)).toEqual(['历史', '完整', '新消息'])
    expect(mergeAgentDetail(current, fresh).nextCursor).toBe(1)
  })
  it('keeps an earlier-history cursor when a disconnect missed more than a full page', () => {
    const old = detail(5, [['first', '早期记录']], null)
    const tail = detail(200, [['last', '最新记录']], 150)
    expect(mergeAgentDetail(old, tail)).toEqual(tail)
  })
})
