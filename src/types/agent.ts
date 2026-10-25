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
}

export type AgentSessionDetail = {
  session: AgentSession
  messages: UiMessage[]
  configOptions: AgentConfigOption[]
  permissions: AgentPermission[]
  imagesSupported: boolean
  nextCursor: number | null
}

export type AgentStatus = { available: boolean; connected: boolean; message: string; imagesSupported: boolean }
export type AgentUpdate = {
  session: AgentSession
  message?: UiMessage
  configOptions?: AgentConfigOption[]
  permissions?: AgentPermission[]
}

export type AgentPromptInput = {
  requestId: string
  text: string
  images?: Array<{ path: string; mimeType: string }>
  files?: Array<{ path: string; name: string }>
}
