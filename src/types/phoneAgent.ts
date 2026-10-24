export type PhoneRunStatus = 'loading' | 'running' | 'stopping' | 'succeeded' | 'needs_input' | 'failed' | 'stopped' | 'interrupted'

export type PhoneEvent = {
  seq: number
  type: string
  message: string
  at: string
  step?: number
  action?: Record<string, unknown>
  screenshot?: string
  status?: PhoneRunStatus
}

export type PhoneRun = {
  id: string
  purpose: string
  deviceId: string
  stepLimit: number
  status: PhoneRunStatus
  createdAt: string
  updatedAt: string
  step: number
  message: string
  screenshot?: string
}

export type PhoneAgentState = {
  available: boolean
  message: string
  devices: Array<{ id: string; model: string; state: string; keyboardReady: boolean }>
  runs: PhoneRun[]
}

export const isPhoneRunActive = (status: PhoneRunStatus): boolean =>
  ['loading', 'running', 'stopping'].includes(status)
