type RpcExecutor = {
  rpc(method: string, params: unknown): Promise<unknown>
  getProcessGeneration?: () => number
}

export type HistoryPage = {
  turns: Array<Record<string, unknown>>
  hasMoreOlder: boolean
}

type PagerState = {
  revision: number
  unavailableGeneration?: number
  anchors: Map<string, string | null>
  pending: Map<string, Promise<HistoryPage | null>>
}

const states = new WeakMap<RpcExecutor, PagerState>()

function getState(server: RpcExecutor): PagerState {
  let state = states.get(server)
  if (!state) {
    state = { revision: 0, anchors: new Map(), pending: new Map() }
    states.set(server, state)
  }
  return state
}

function isUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return code === -32601 || /method (?:not found|not supported)|unknown method|unsupported method/.test(message)
    || (message.includes('unknown variant') && message.includes('thread/turns/list'))
}

function rememberAnchor(state: PagerState, threadId: string, page: HistoryPage, cursor: string | null): void {
  const oldest = page.turns[0]?.id
  if (typeof oldest !== 'string') return
  const key = `${threadId}\0${oldest}`
  state.anchors.delete(key)
  state.anchors.set(key, cursor)
  while (state.anchors.size > 1024) state.anchors.delete(state.anchors.keys().next().value!)
}

export function invalidateThreadHistoryPages(server: RpcExecutor, threadId: string): void {
  const state = states.get(server)
  if (!state) return
  state.revision++
  for (const key of state.anchors.keys()) {
    if (key.startsWith(`${threadId}\0`)) state.anchors.delete(key)
  }
  // Existing callers may finish; new readers must not join a pre-mutation read.
  state.pending.clear()
}

/** Resolve an edit only when requested; normal history reads never count all turns. */
export async function countTurnsFromTarget(server: RpcExecutor, threadId: string, targetTurnId: string): Promise<number | null> {
  let cursor: string | null = null
  let count = 0
  const visited = new Set<string>()
  for (;;) {
    let raw: unknown
    try {
      raw = await server.rpc('thread/turns/list', {
        threadId, cursor, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded',
      })
    } catch (error) {
      if (isUnsupported(error)) return null
      throw error
    }
    const page = raw as { data?: Array<{ id?: unknown }>; nextCursor?: unknown } | null
    if (!page || !Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) {
      throw new Error('thread/turns/list returned an invalid page')
    }
    const targetIndex = page.data.findIndex((turn) => turn?.id === targetTurnId)
    if (targetIndex >= 0) return count + targetIndex + 1
    count += page.data.length
    const nextCursor = page.nextCursor || null
    if (!nextCursor) throw new Error('The selected turn no longer exists. Reload the conversation before editing.')
    if (visited.has(nextCursor)) throw new Error('thread/turns/list returned a repeated cursor')
    visited.add(nextCursor)
    cursor = nextCursor
  }
}

/** Returns null only for an older app-server without the pagination method. */
export function readOfficialThreadPage(
  server: RpcExecutor,
  threadId: string,
  limit: number,
  beforeTurnId = '',
): Promise<HistoryPage | null> {
  const state = getState(server)
  const generation = server.getProcessGeneration?.() ?? 0
  if (state.unavailableGeneration === generation) return Promise.resolve(null)
  const requestKey = JSON.stringify([threadId, beforeTurnId, limit])
  const existing = state.pending.get(requestKey)
  if (existing) return existing
  const revision = state.revision

  const request = (async (): Promise<HistoryPage | null> => {
    const anchorKey = `${threadId}\0${beforeTurnId}`
    let anchored = Boolean(beforeTurnId && state.anchors.has(anchorKey))
    let cursor = anchored ? state.anchors.get(anchorKey) ?? null : null
    if (anchored && cursor === null) return { turns: [], hasMoreOlder: false }
    const visited = new Set<string>()
    for (;;) {
      let raw: unknown
      try {
        raw = await server.rpc('thread/turns/list', {
          threadId, cursor, limit, sortDirection: 'desc', itemsView: 'full',
        })
      } catch (error) {
        if (isUnsupported(error)) {
          state.unavailableGeneration = server.getProcessGeneration?.() ?? generation
          return null
        }
        // A rollback may invalidate an opaque cursor. Find the requested turn
        // again through bounded official pages; never turn network errors into
        // an expensive full-history fallback.
        if (anchored && /(?:invalid|expired|stale).*cursor|cursor.*(?:invalid|expired|stale)/i.test(error instanceof Error ? error.message : '')) {
          state.anchors.delete(anchorKey)
          anchored = false
          cursor = null
          visited.clear()
          continue
        }
        throw error
      }
      const response = raw as { data?: unknown; nextCursor?: unknown } | null
      if (!response || !Array.isArray(response.data)
        || !(response.nextCursor === null || typeof response.nextCursor === 'string')) {
        throw new Error('thread/turns/list returned an invalid page')
      }
      const turns = response.data as Array<Record<string, unknown>>
      if (turns.some((turn) => !turn || typeof turn.id !== 'string' || !Array.isArray(turn.items))) {
        throw new Error('thread/turns/list returned an invalid turn')
      }
      const nextCursor = response.nextCursor || null
      const anchorIndex = !beforeTurnId || anchored ? -1 : turns.findIndex((turn) => turn.id === beforeTurnId)
      if (!beforeTurnId || anchored || anchorIndex >= 0) {
        const selected = anchorIndex >= 0 ? turns.slice(anchorIndex + 1) : turns
        const page = { turns: [...selected].reverse(), hasMoreOlder: nextCursor !== null }
        if (page.turns.length > 0 || !nextCursor) {
          if (state.revision === revision) rememberAnchor(state, threadId, page, nextCursor)
          return page
        }
        anchored = true
      }
      if (!nextCursor) return { turns: [], hasMoreOlder: false }
      if (visited.has(nextCursor) || nextCursor === cursor) throw new Error('thread/turns/list returned a repeated cursor')
      visited.add(nextCursor)
      cursor = nextCursor
    }
  })().finally(() => {
    if (state.pending.get(requestKey) === request) state.pending.delete(requestKey)
  })
  state.pending.set(requestKey, request)
  return request
}
