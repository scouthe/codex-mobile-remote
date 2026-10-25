import { computed, onUnmounted, ref, shallowRef, type Ref } from 'vue'
import { agentGateway } from '../api/agentGateway'
import type { AgentSession, AgentSessionDetail, AgentUpdate } from '../types/agent'

export function mergeAgentDetail(previous: AgentSessionDetail | undefined, detail: AgentSessionDetail, older = false): AgentSessionDetail {
  if (!previous) return detail
  const stale = previous.session.revision > detail.session.revision
  const old = new Map(previous.messages.map(message => [message.id, message]))
  const incoming = new Map(detail.messages.map(message => [message.id, message]))
  const overlaps = detail.messages.some(message => old.has(message.id))
  // A long disconnect can leave a gap larger than one page. Start from the
  // durable tail rather than present two disconnected ranges as complete.
  if (!older && !stale && previous.messages.length && detail.messages.length && !overlaps) return detail
  const messages = older
    ? [...detail.messages.filter(message => !old.has(message.id)), ...previous.messages]
    : [...previous.messages.map(message => stale ? message : incoming.get(message.id) || message), ...detail.messages.filter(message => !old.has(message.id))]
  const retainedOlderHistory = previous.messages.some(message => !incoming.has(message.id))
  return { ...(stale ? previous : detail), messages, nextCursor: older ? detail.nextCursor : retainedOlderHistory ? previous.nextCursor : detail.nextCursor }
}

export function reconcileAgentSessionList(rows: AgentSession[], known: Map<string, AgentSession>, before: Map<string, number>): AgentSession[] {
  const next = new Map<string, AgentSession>()
  for (const row of rows) {
    const live = known.get(row.id)
    const selected = live && live.revision > row.revision ? live : row
    known.set(row.id, selected)
    if (!selected.archived) next.set(row.id, selected)
  }
  for (const [id, live] of known) if (!live.archived && live.revision > (before.get(id) ?? -1) && !next.has(id)) next.set(id, live)
  return Array.from(next.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function useAgentState(selectedId: Ref<string>) {
  const sessions = shallowRef<AgentSession[]>([]), details = shallowRef<Record<string, AgentSessionDetail>>({})
  const connected = ref(false), available = ref(true), statusMessage = ref(''), error = ref(''), loading = ref(false), loadingEarlier = ref(false)
  const current = computed(() => details.value[selectedId.value])
  const pendingReads = new Map<string, Promise<AgentSessionDetail>>()
  const knownSessions = new Map<string, AgentSession>()
  let stream: EventSource | undefined, disposed = false, listRequest: Promise<void> | undefined

  function upsertSession(session: AgentSession) {
    const current = knownSessions.get(session.id)
    if (current && current.revision > session.revision) return
    knownSessions.set(session.id, session)
    sessions.value = [...sessions.value.filter(row => row.id !== session.id), ...(session.archived ? [] : [session])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  function accept(detail: AgentSessionDetail, older = false) {
    details.value = { ...details.value, [detail.session.id]: mergeAgentDetail(details.value[detail.session.id], detail, older) }
    upsertSession(detail.session)
    return detail
  }
  function apply(update: AgentUpdate) {
    const previous = details.value[update.session.id]
    upsertSession(update.session)
    if (!previous || previous.session.revision > update.session.revision) return
    const messages = [...previous.messages]
    if (update.message) {
      const index = messages.findIndex(message => message.id === update.message!.id)
      if (index < 0) messages.push(update.message)
      else messages[index] = update.message
    }
    details.value = { ...details.value, [update.session.id]: { ...previous, session: update.session, messages, configOptions: update.configOptions || previous.configOptions, permissions: update.permissions || previous.permissions } }
  }
  function refreshList(): Promise<void> {
    if (!listRequest) {
      const before = new Map(Array.from(knownSessions, ([id, session]) => [id, session.revision]))
      listRequest = agentGateway.list().then(rows => {
        // A slower list must not hide a chat created while it was loading,
        // or resurrect a chat archived by a newer live update.
        sessions.value = reconcileAgentSessionList(rows, knownSessions, before)
      }).finally(() => { listRequest = undefined })
    }
    return listRequest
  }
  async function refresh(id = selectedId.value, activate = false): Promise<AgentSessionDetail | undefined> {
    if (!id) return
    const key = `${id}:${activate}`
    if (pendingReads.has(key)) return pendingReads.get(key)
    const read = (activate
      ? agentGateway.activate(id).then(view => ({ ...view, messages: details.value[id]?.messages || [], nextCursor: details.value[id]?.nextCursor ?? null }))
      : agentGateway.detail(id)).then(detail => accept(detail)).finally(() => pendingReads.delete(key))
    pendingReads.set(key, read)
    return read
  }
  async function loadEarlier() {
    const id = selectedId.value, cursor = current.value?.nextCursor
    if (!id || !cursor || loadingEarlier.value) return
    loadingEarlier.value = true
    try { accept(await agentGateway.detail(id, cursor), true) }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '历史记录加载失败。' }
    finally { loadingEarlier.value = false }
  }
  async function synchronize() {
    try { await Promise.all([refreshList(), refresh()]); error.value = '' }
    catch (cause) { error.value = cause instanceof Error ? cause.message : 'DSH 状态同步失败。' }
  }
  async function initialize() {
    loading.value = true
    try {
      const status = await agentGateway.status()
      available.value = status.available; statusMessage.value = status.message
      if (disposed) return
      stream = new EventSource('/agent-api/events')
      stream.addEventListener('ready', () => { connected.value = true; loading.value = false; void synchronize() })
      stream.addEventListener('update', event => {
        try { apply(JSON.parse((event as MessageEvent).data)) } catch { void synchronize() }
      })
      stream.onerror = () => { connected.value = false; loading.value = false }
    } catch (cause) { error.value = cause instanceof Error ? cause.message : 'DSH 连接失败。'; loading.value = false }
  }
  onUnmounted(() => { disposed = true; stream?.close() })
  return { sessions, current, connected, available, statusMessage, error, loading, loadingEarlier, accept, apply, refresh, refreshList, loadEarlier, synchronize, initialize }
}
