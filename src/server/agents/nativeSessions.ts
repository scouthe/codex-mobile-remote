import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { InitializeResponse } from '@agentclientprotocol/sdk'
import type { AgentProtocolCapabilities } from '../../types/agent.js'

export type NativeSessionSummary = { nativeId: string; cwd: string; title: string; updatedAt: string }
export type NativeSessionPage = { sessions: NativeSessionSummary[]; nextCursor: string | null }

export function protocolCapabilities(response: InitializeResponse | undefined): AgentProtocolCapabilities | null {
  if (!response) return null
  const capabilities = response.agentCapabilities
  return {
    listSessions: Boolean(capabilities?.sessionCapabilities?.list),
    resumeSession: Boolean(capabilities?.sessionCapabilities?.resume),
    closeSession: Boolean(capabilities?.sessionCapabilities?.close),
    loadSession: capabilities?.loadSession === true,
    image: capabilities?.promptCapabilities?.image === true,
    mcpHttp: capabilities?.mcpCapabilities?.http === true,
    mcpSse: capabilities?.mcpCapabilities?.sse === true,
  }
}

// A stable display UUID keeps opaque ACP IDs (including old Web IDs) usable
// with our existing routes, even if a failed index write has to be retried.
export function nativeDisplayId(nativeId: string): string {
  const hash = createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'))
    .update(`codex-remote/dsh/${nativeId}`).digest().subarray(0, 16)
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function normalizeNativeSessionPage(value: unknown): NativeSessionPage {
  const page = value as { sessions?: unknown; nextCursor?: unknown } | null
  if (!Array.isArray(page?.sessions) || page.sessions.length > 2000) throw new Error('DSH 返回的原生会话列表无效。')
  if (page.nextCursor != null && (typeof page.nextCursor !== 'string' || page.nextCursor.length > 4096)) throw new Error('DSH 返回的分页位置无效。')
  const sessions = new Map<string, NativeSessionSummary>()
  for (const row of page.sessions) {
    const entry = row as Record<string, unknown> | null
    if (!entry || typeof entry.sessionId !== 'string' || !entry.sessionId || entry.sessionId.length > 512
      || typeof entry.cwd !== 'string' || !isAbsolute(entry.cwd) || entry.cwd.length > 4096) throw new Error('DSH 返回的原生会话信息无效。')
    if (sessions.has(entry.sessionId)) continue
    sessions.set(entry.sessionId, {
      nativeId: entry.sessionId, cwd: entry.cwd,
      title: typeof entry.title === 'string' ? entry.title.trim().slice(0, 300) : '',
      updatedAt: typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt)) ? new Date(entry.updatedAt).toISOString() : '',
    })
  }
  return { sessions: [...sessions.values()], nextCursor: page.nextCursor || null }
}
