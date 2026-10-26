import type { UiMessage } from './codex'

export type AgentRunState = 'idle' | 'starting' | 'running' | 'waiting_approval' | 'stopping' | 'completed' | 'failed' | 'interrupted'
export const isAgentBusy = (state: AgentRunState): boolean => ['starting', 'running', 'waiting_approval', 'stopping'].includes(state)

export type AgentConfigOption = {
  id: string
  name: string
  category: string
  currentValue: string
  options: Array<{ value: string; label: string }>
}

export type AgentPermission = {
  id: string
  sessionId: string
  title: string
  details: string
  options: Array<{ optionId: string; name: string; kind: string }>
}

export type AgentSession = {
  id: string
  nativeId: string
  agentId: 'dsh'
  title: string
  cwd: string
  createdAt: string
  updatedAt: string
  state: AgentRunState
  error: string
  runId: string
  lastRequestId: string
  requestIds?: string[]
  revision: number
  turnCount?: number
  archived: boolean
  source?: 'native' | 'remote'
  historyUnavailable?: boolean
  usage?: { used: number; size: number }
}

export type AgentProtocolCapabilities = {
  listSessions: boolean
  resumeSession: boolean
  closeSession: boolean
  loadSession: boolean
  image: boolean
  mcpHttp: boolean
  mcpSse: boolean
}
export type AgentSessionPage = {
  sessions: AgentSession[]
  nextCursor: string | null
  capabilities: AgentProtocolCapabilities | null
  warning: string
}

export type AgentSessionDetail = {
  session: AgentSession
  messages: UiMessage[]
  configOptions: AgentConfigOption[]
  permissions: AgentPermission[]
  imagesSupported: boolean
  nextCursor: number | null
  attached?: boolean
}
export type AgentSessionView = Omit<AgentSessionDetail, 'messages' | 'nextCursor'>

export type AgentStatus = { available: boolean; connected: boolean; message: string; imagesSupported: boolean; capabilities?: AgentProtocolCapabilities | null }
export type AgentUpdate = {
  session: AgentSession
  message?: UiMessage
  configOptions?: AgentConfigOption[]
  permissions?: AgentPermission[]
  attached?: boolean
}

export type AgentPromptInput = {
  requestId: string
  text: string
  images?: Array<{ path: string; mimeType: string }>
  files?: Array<{ path: string; name: string }>
}
