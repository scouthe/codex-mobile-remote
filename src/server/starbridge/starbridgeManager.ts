import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import {
  clearActivationAttempt,
  getStarbridgePaths,
  readActivationAttempt,
  readDevice,
  writeActivationAttempt,
  writeDevice,
  writeFrpcConfig,
  type StarbridgeDevice,
  type StarbridgePaths,
} from './credentialStore.js'
import { DEFAULT_STARBRIDGE_CONTROL_URL, normalizeStarbridgeControlUrl, redeemActivation, redeemRenewal } from './controlPlaneClient.js'
import { ensureFrpcInstalled } from './frpcInstaller.js'
import { isFrpcActive, startFrpc, stopFrpc } from './frpcRuntime.js'
import type { StarbridgeActivateInput, StarbridgeRenewInput, StarbridgeStatus } from './types.js'
import type { StarbridgeSubscription } from './types.js'

type StarbridgeManagerDependencies = {
  redeemActivation: typeof redeemActivation
  redeemRenewal: typeof redeemRenewal
  ensureFrpcInstalled: typeof ensureFrpcInstalled
  startFrpc: typeof startFrpc
  stopFrpc: typeof stopFrpc
  isFrpcActive: typeof isFrpcActive
}

function emptySubscription(): StarbridgeSubscription {
  return { plan: null, status: null, expiresAt: null }
}

function deviceSecret(): string {
  return `xj_dev_${randomBytes(30).toString('base64url')}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isExpired(subscription: StarbridgeSubscription): boolean {
  return subscription.status === 'expired'
    || (typeof subscription.expiresAt === 'number' && subscription.expiresAt <= Math.floor(Date.now() / 1000))
}

function hasTomlAssignment(config: string, key: string, value: string): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^\\s*${escapedKey}\\s*=\\s*"${escapedValue}"\\s*(?:#.*)?$`, 'mu').test(config)
}

function validateFrpcConfig(config: string, expectedSubdomain: string): void {
  const proxyTables = config.match(/^\s*\[\[\s*proxies\s*\]\]\s*(?:#.*)?$/gmu) ?? []
  const arrayTables = config.match(/^\s*\[\[[^\n]+\]\]\s*(?:#.*)?$/gmu) ?? []
  const safeSubdomain = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(expectedSubdomain)
  if (config.length > 64 * 1024
      || !safeSubdomain
      || !hasTomlAssignment(config, 'auth.method', 'oidc')
      || /^\s*auth\.token\s*=/mu.test(config)
      || /^\s*includes\s*=/mu.test(config)
      || proxyTables.length !== 1
      || arrayTables.length !== proxyTables.length
      || !hasTomlAssignment(config, 'type', 'http')
      || !hasTomlAssignment(config, 'localIP', '127.0.0.1')
      || !/^\s*localPort\s*=\s*5900\s*(?:#.*)?$/mu.test(config)
      || !hasTomlAssignment(config, 'subdomain', expectedSubdomain)) {
    throw new Error('控制面返回的 FRPC 配置不安全或格式无效。')
  }
}

export class StarbridgeManager {
  private readonly paths: StarbridgePaths
  private readonly dependencies: StarbridgeManagerDependencies
  private readonly passwordConfigured: boolean
  private lastError: string | null = null
  private mutation: Promise<void> = Promise.resolve()

  constructor(
    passwordConfigured: boolean,
    paths = getStarbridgePaths(),
    dependencies: Partial<StarbridgeManagerDependencies> = {},
  ) {
    this.passwordConfigured = passwordConfigured
    this.paths = paths
    this.dependencies = {
      redeemActivation,
      redeemRenewal,
      ensureFrpcInstalled,
      startFrpc,
      stopFrpc,
      isFrpcActive,
      ...dependencies,
    }
  }

  async activate(input: StarbridgeActivateInput): Promise<StarbridgeStatus> {
    return this.runExclusive(() => this.activateUnlocked(input))
  }

  private async activateUnlocked(input: StarbridgeActivateInput): Promise<StarbridgeStatus> {
    if (process.platform !== 'linux') throw new Error('星桥用户端目前仅支持 Linux 主机。')
    if (!this.passwordConfigured) throw new Error('请先为 codexapp 设置访问密码，再启用公网访问。')
    const redemptionCode = input.redemptionCode.trim()
    if (!redemptionCode.startsWith('xj_act_') || redemptionCode.length > 160) throw new Error('激活码格式无效。')
    const controlUrl = normalizeStarbridgeControlUrl(
      process.env.CODEXUI_STARBRIDGE_CONTROL_URL?.trim() || DEFAULT_STARBRIDGE_CONTROL_URL,
    )
    const existing = await readDevice(this.paths)
    if (existing) throw new Error('本机已经激活星桥，请使用续费码或重启连接。')
    const pendingAttempt = await readActivationAttempt(this.paths)
    const secret = pendingAttempt?.deviceSecret || deviceSecret()
    const name = pendingAttempt?.deviceName || hostname().trim().slice(0, 80) || 'codexapp'
    if (name.length > 80) throw new Error('设备名称不能超过 80 个字符。')
    try {
      await writeActivationAttempt({ deviceName: name, deviceSecret: secret, controlUrl, updatedAt: Date.now() }, this.paths)
      const credential = await this.dependencies.redeemActivation(controlUrl, redemptionCode, name, secret)
      const returnedToken = credential.deviceToken
      if (!credential.clientId || typeof returnedToken !== 'string' || returnedToken !== secret || !credential.frpcConfig || !credential.device?.domain) {
        throw new Error('控制面返回的设备凭据不完整。')
      }
      const subdomain = credential.device.subdomain || credential.device.domain.split('.')[0] || ''
      if (!/^[-a-z0-9.]+$/iu.test(credential.device.domain)
          || (credential.device.domain !== subdomain && !credential.device.domain.startsWith(`${subdomain}.`))) {
        throw new Error('控制面返回的设备域名无效。')
      }
      validateFrpcConfig(credential.frpcConfig, subdomain)
      const installed = await this.dependencies.ensureFrpcInstalled()
      const device: StarbridgeDevice = {
        deviceName: name,
        deviceSecret: returnedToken,
        controlUrl,
        clientId: credential.clientId,
        domain: credential.device.domain,
        subdomain,
        username: credential.user?.username || '',
        subscription: credential.subscription || emptySubscription(),
        frpcConfig: credential.frpcConfig,
        frpcVersion: installed.version,
        updatedAt: Date.now(),
        pid: undefined,
      }
      await writeFrpcConfig(device.frpcConfig, this.paths)
      await writeDevice(device, this.paths)
      await clearActivationAttempt(this.paths)
      const runtime = await this.dependencies.startFrpc(this.paths, device.pid)
      if (runtime.pid) {
        device.pid = runtime.pid
        await writeDevice(device, this.paths)
      }
      this.lastError = null
      return await this.status()
    } catch (error) {
      this.lastError = errorMessage(error)
      throw error
    }
  }

  async renew(input: StarbridgeRenewInput): Promise<StarbridgeStatus> {
    return this.runExclusive(() => this.renewUnlocked(input))
  }

  private async renewUnlocked(input: StarbridgeRenewInput): Promise<StarbridgeStatus> {
    if (!this.passwordConfigured) throw new Error('请先为 codexapp 设置访问密码，再续费公网访问。')
    const redemptionCode = input.redemptionCode.trim()
    if (!redemptionCode.startsWith('xj_renew_') || redemptionCode.length > 160) throw new Error('续费码格式无效。')
    const current = await readDevice(this.paths)
    if (!current) throw new Error('本机尚未激活星桥设备。')
    try {
      const credential = await this.dependencies.redeemRenewal(current.controlUrl, redemptionCode, current.clientId, current.deviceSecret)
      if ((credential.clientId && credential.clientId !== current.clientId)
          || (credential.deviceToken && credential.deviceToken !== current.deviceSecret)
          || (credential.device?.domain && credential.device.domain !== current.domain)
          || (credential.device?.subdomain && credential.device.subdomain !== current.subdomain)) {
        throw new Error('控制面返回了与当前设备不匹配的续费凭据。')
      }
      const nextConfig = credential.frpcConfig || current.frpcConfig
      validateFrpcConfig(nextConfig, current.subdomain)
      const next: StarbridgeDevice = {
        ...current,
        subscription: credential.subscription || current.subscription,
        frpcConfig: nextConfig,
        updatedAt: Date.now(),
      }
      await writeFrpcConfig(next.frpcConfig, this.paths)
      await writeDevice(next, this.paths)
      const runtime = await this.dependencies.startFrpc(this.paths, next.pid)
      if (runtime.pid) {
        next.pid = runtime.pid
        await writeDevice(next, this.paths)
      }
      this.lastError = null
      return await this.status()
    } catch (error) {
      this.lastError = errorMessage(error)
      throw error
    }
  }

  async restart(): Promise<StarbridgeStatus> {
    return this.runExclusive(() => this.restartUnlocked())
  }

  private async restartUnlocked(): Promise<StarbridgeStatus> {
    const current = await readDevice(this.paths)
    if (!current) throw new Error('本机尚未激活星桥设备。')
    const runtime = await this.dependencies.startFrpc(this.paths, current.pid)
    if (runtime.pid) {
      current.pid = runtime.pid
      await writeDevice(current, this.paths)
    }
    this.lastError = null
    return this.status()
  }

  async disconnect(): Promise<void> {
    return this.runExclusive(() => this.disconnectUnlocked())
  }

  private async disconnectUnlocked(): Promise<void> {
    const current = await readDevice(this.paths)
    await this.dependencies.stopFrpc(this.paths, current?.pid)
    this.lastError = null
    if (current) {
      await writeDevice({ ...current, pid: undefined, updatedAt: Date.now() }, this.paths)
    }
  }

  async status(): Promise<StarbridgeStatus> {
    const current = await readDevice(this.paths)
    if (!current) {
      return {
        state: 'unconfigured', controlUrl: null, domain: null, subdomain: null,
        clientId: null, subscription: emptySubscription(), frpcVersion: null,
        serviceActive: false, passwordProtected: this.passwordConfigured,
        lastError: this.lastError, updatedAt: null,
      }
    }
    const serviceActive = await this.dependencies.isFrpcActive(this.paths, current.pid)
    const expired = isExpired(current.subscription)
    const securityError = this.passwordConfigured ? null : '请先为 codexapp 设置访问密码，公网访问才能安全启用。'
    return {
      state: securityError ? 'error' : expired ? 'expired' : serviceActive ? 'online' : this.lastError ? 'error' : 'stopped',
      controlUrl: current.controlUrl,
      domain: current.domain,
      subdomain: current.subdomain,
      clientId: current.clientId,
      subscription: current.subscription,
      frpcVersion: current.frpcVersion,
      serviceActive,
      passwordProtected: this.passwordConfigured,
      lastError: securityError || this.lastError,
      updatedAt: current.updatedAt,
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.mutation.then(operation, operation)
    this.mutation = current.then(() => undefined, () => undefined)
    return current
  }

  dispose(): void {
    // systemd/process state intentionally survives codexapp restarts.
  }
}
