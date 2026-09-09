export type StarbridgeRuntimeState =
  | 'unconfigured'
  | 'configured'
  | 'starting'
  | 'online'
  | 'stopped'
  | 'expired'
  | 'error'

export type StarbridgeSubscription = {
  plan: string | null
  status: string | null
  expiresAt: number | null
}

export type StarbridgeStatus = {
  state: StarbridgeRuntimeState
  controlUrl: string | null
  domain: string | null
  subdomain: string | null
  clientId: string | null
  subscription: StarbridgeSubscription
  frpcVersion: string | null
  serviceActive: boolean
  passwordProtected: boolean
  lastError: string | null
  updatedAt: number | null
}

export type StarbridgeActivateInput = {
  controlUrl: string
  redemptionCode: string
  deviceName?: string
}

export type StarbridgeRenewInput = {
  redemptionCode: string
}
