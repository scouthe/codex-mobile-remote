import type { StarbridgeSubscription } from './types.js'

export const DEFAULT_STARBRIDGE_CONTROL_URL = 'https://auth.xingqiao.xuanjishu.site'

export type ControlPlaneCredential = {
  user?: { username?: string }
  device?: { domain?: string; subdomain?: string }
  deviceToken?: string
  clientId?: string
  subscription?: StarbridgeSubscription
  frpcConfig?: string
}

function normalizeControlUrl(value: string): string {
  const parsed = new URL(value.trim())
  const host = parsed.hostname.toLowerCase()
  const privateIpv4 = host.split('.').length === 4
    && host.split('.').every((part) => /^\d{1,3}$/u.test(part) && Number(part) >= 0 && Number(part) <= 255)
    && (host.startsWith('10.') || host.startsWith('192.168.') || (host.startsWith('172.') && Number(host.split('.')[1]) >= 16 && Number(host.split('.')[1]) <= 31))
  const localHttp = host === 'localhost' || host === '127.0.0.1' || host === '::1' || privateIpv4
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHttp)) {
    throw new Error('控制面地址必须使用 HTTPS（本机测试可使用 HTTP）。')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('控制面地址应填写站点根地址，不能包含路径、账号、查询参数或片段。')
  }
  return parsed.toString().replace(/\/$/u, '')
}

async function post<T>(controlUrl: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${normalizeControlUrl(controlUrl)}/api/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `控制面请求失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  return body as T
}

export function normalizeStarbridgeControlUrl(value: string): string {
  return normalizeControlUrl(value)
}

export async function redeemActivation(controlUrl: string, code: string, deviceName: string, deviceSecret: string): Promise<ControlPlaneCredential> {
  return post<ControlPlaneCredential>(controlUrl, { code, deviceName, deviceSecret })
}

export async function redeemRenewal(controlUrl: string, code: string, clientId: string, clientSecret: string): Promise<ControlPlaneCredential> {
  return post<ControlPlaneCredential>(controlUrl, { code, clientId, clientSecret })
}
