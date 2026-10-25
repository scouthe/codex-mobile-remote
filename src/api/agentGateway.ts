import type { AgentPromptInput, AgentSession, AgentSessionDetail, AgentSessionView, AgentStatus } from '../types/agent'

export async function agentRequest<T>(path: string, data?: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  try {
    const response = await fetch(`/agent-api/${path}`, {
      method: data === undefined ? 'GET' : 'POST', cache: 'no-store',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal,
    })
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('登录状态已失效，请重新打开页面登录。')
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `操作失败（${response.status}）`)
    return result as T
  } catch (error) {
    if (controller.signal.aborted) throw new Error('请求超时。任务可能已提交，请先刷新状态；再次发送相同消息不会重复执行。')
    throw error
  } finally { clearTimeout(timer) }
}

export const agentGateway = {
  status: () => agentRequest<AgentStatus>('status'),
  list: () => agentRequest<AgentSession[]>('sessions'),
  create: (cwd: string) => agentRequest<AgentSessionDetail>('sessions', { cwd }),
  detail: (id: string, before?: number) => agentRequest<AgentSessionDetail>(`sessions/${id}${before ? `?before=${before}` : ''}`),
  activate: (id: string) => agentRequest<AgentSessionView>(`sessions/${id}/activate`, {}),
  configure: (id: string, configId: string, value: string) => agentRequest<AgentSessionDetail>(`sessions/${id}/config`, { configId, value }),
  prompt: (id: string, input: AgentPromptInput) => agentRequest<AgentSession>(`sessions/${id}/prompt`, input),
  stop: (id: string) => agentRequest<AgentSession>(`sessions/${id}/stop`, {}),
  permission: (id: string, permissionId: string, optionId: string) => agentRequest<{ ok: true }>(`sessions/${id}/permission`, { permissionId, optionId }),
  archive: (id: string) => agentRequest<{ ok: true }>(`sessions/${id}/archive`, {}),
  directories: (path = '') => agentRequest<{ path: string; parent: string; directories: Array<{ path: string; name: string }> }>(`directories?path=${encodeURIComponent(path)}`),
}
