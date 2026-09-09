import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { StarbridgeSubscription } from './types.js'

export type StarbridgeDevice = {
  deviceName: string
  deviceSecret: string
  controlUrl: string
  clientId: string
  domain: string
  subdomain: string
  username: string
  subscription: StarbridgeSubscription
  frpcConfig: string
  frpcVersion: string
  updatedAt: number
  pid?: number
}

export type StarbridgeActivationAttempt = {
  deviceName: string
  deviceSecret: string
  controlUrl: string
  updatedAt: number
}

export type StarbridgePaths = {
  root: string
  device: string
  activationAttempt: string
  config: string
  binary: string
  state: string
  unit: string
}

export function getStarbridgeRoot(): string {
  return process.env.CODEXUI_STARBRIDGE_HOME?.trim()
    || join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'codexapp', 'starbridge')
}

export function getStarbridgePaths(root = getStarbridgeRoot()): StarbridgePaths {
  return {
    root,
    device: join(root, 'device.json'),
    activationAttempt: join(root, 'activation-attempt.json'),
    config: join(root, 'frpc.toml'),
    binary: join(root, 'bin', 'frpc'),
    state: join(root, 'state.json'),
    unit: join(root, 'codexapp-starbridge.service'),
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700).catch(() => undefined)
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(join(path, '..'))
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, path)
  await chmod(path, 0o600).catch(() => undefined)
}

export async function readDevice(paths = getStarbridgePaths()): Promise<StarbridgeDevice | null> {
  try {
    const value = JSON.parse(await readFile(paths.device, 'utf8')) as Partial<StarbridgeDevice>
    const subscription = value.subscription
    if (typeof value.deviceName !== 'string'
        || typeof value.deviceSecret !== 'string'
        || typeof value.clientId !== 'string'
        || typeof value.controlUrl !== 'string'
        || typeof value.domain !== 'string'
        || typeof value.subdomain !== 'string'
        || typeof value.username !== 'string'
        || typeof value.frpcConfig !== 'string'
        || typeof value.frpcVersion !== 'string'
        || typeof value.updatedAt !== 'number'
        || !subscription || typeof subscription !== 'object') return null
    return {
      ...value,
      subscription: {
        plan: typeof subscription.plan === 'string' ? subscription.plan : null,
        status: typeof subscription.status === 'string' ? subscription.status : null,
        expiresAt: typeof subscription.expiresAt === 'number' ? subscription.expiresAt : null,
      },
      pid: typeof value.pid === 'number' && Number.isInteger(value.pid) ? value.pid : undefined,
    } as StarbridgeDevice
  } catch {
    return null
  }
}

export async function writeDevice(device: StarbridgeDevice, paths = getStarbridgePaths()): Promise<void> {
  await writePrivateJson(paths.device, device)
}

export async function readActivationAttempt(paths = getStarbridgePaths()): Promise<StarbridgeActivationAttempt | null> {
  try {
    const value = JSON.parse(await readFile(paths.activationAttempt, 'utf8')) as Partial<StarbridgeActivationAttempt>
    if (typeof value.deviceSecret !== 'string'
        || typeof value.controlUrl !== 'string'
        || typeof value.deviceName !== 'string'
        || typeof value.updatedAt !== 'number') return null
    return value as StarbridgeActivationAttempt
  } catch {
    return null
  }
}

export async function writeActivationAttempt(attempt: StarbridgeActivationAttempt, paths = getStarbridgePaths()): Promise<void> {
  await writePrivateJson(paths.activationAttempt, attempt)
}

export async function clearActivationAttempt(paths = getStarbridgePaths()): Promise<void> {
  await rm(paths.activationAttempt, { force: true }).catch(() => undefined)
}

export async function writeFrpcConfig(config: string, paths = getStarbridgePaths()): Promise<void> {
  await ensurePrivateDirectory(paths.root)
  const temporary = `${paths.config}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, config, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, paths.config)
  await chmod(paths.config, 0o600).catch(() => undefined)
}

export async function writeUnit(unit: string, paths = getStarbridgePaths()): Promise<void> {
  await ensurePrivateDirectory(join(paths.unit, '..'))
  const temporary = `${paths.unit}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, unit, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, paths.unit)
  await chmod(paths.unit, 0o600).catch(() => undefined)
}
