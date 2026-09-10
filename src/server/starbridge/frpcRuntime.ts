import { access, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import type { StarbridgePaths } from './credentialStore.js'
import { writeUnit } from './credentialStore.js'

const execFileAsync = promisify(execFile)
const UNIT_NAME = 'codexapp-starbridge.service'

async function systemctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('systemctl', ['--user', ...args], { timeout: 15_000 })
}

async function ownsProcess(pid: number, paths: StarbridgePaths): Promise<boolean> {
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, 'utf8')
    return commandLine.includes(paths.binary) && commandLine.includes(paths.config)
  } catch {
    return false
  }
}

export async function hasUserSystemd(): Promise<boolean> {
  const isUsableState = (value: unknown) => typeof value === 'string'
    && ['running', 'degraded', 'starting', 'initializing'].includes(value.trim())
  try {
    const result = await systemctl(['is-system-running'])
    return isUsableState(result.stdout)
  } catch (error) {
    return isUsableState((error as { stdout?: unknown }).stdout)
  }
}

function unitText(binary: string, config: string): string {
  return `[Unit]\nDescription=Codexapp StarBridge FRPC\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${JSON.stringify(binary)} -c ${JSON.stringify(config)}\nRestart=on-failure\nRestartSec=5s\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`
}

export async function startFrpc(paths: StarbridgePaths, previousPid?: number): Promise<{ active: boolean; mode: 'systemd' | 'process'; pid?: number }> {
  if (await hasUserSystemd()) {
    const unitDir = `${process.env.XDG_CONFIG_HOME?.trim() || `${homedir()}/.config`}/systemd/user`
    const unitPath = `${unitDir}/${UNIT_NAME}`
    await writeUnit(unitText(paths.binary, paths.config), { ...paths, unit: unitPath })
    await systemctl(['daemon-reload'])
    await systemctl(['enable', UNIT_NAME])
    await systemctl(['restart', UNIT_NAME])
    return { active: true, mode: 'systemd' }
  }

  // A detached fallback is useful on minimal Linux installations without a
  // user systemd session. Its PID is persisted by the manager and checked on
  // the next status call; it never blocks or owns the web server lifecycle.
  await access(paths.binary)
  await access(paths.config)
  if (previousPid && Number.isInteger(previousPid) && previousPid > 1 && await ownsProcess(previousPid, paths)) {
    try {
      process.kill(previousPid, 'SIGTERM')
    } catch { /* already stopped */ }
  }
  const child = spawn(paths.binary, ['-c', paths.config], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  return { active: Boolean(child.pid), mode: 'process', pid: child.pid ?? undefined }
}

export async function stopFrpc(paths: StarbridgePaths, pid?: number): Promise<void> {
  if (await hasUserSystemd()) {
    await systemctl(['disable', '--now', UNIT_NAME]).catch(() => undefined)
    return
  }
  if (!pid || !Number.isInteger(pid) || pid <= 1 || !(await ownsProcess(pid, paths))) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch { /* already stopped */ }
}

export async function isFrpcActive(paths: StarbridgePaths, pid?: number): Promise<boolean> {
  if (await hasUserSystemd()) {
    try {
      const result = await systemctl(['is-active', UNIT_NAME])
      return result.stdout.trim() === 'active'
    } catch {
      return false
    }
  }
  if (!pid || !Number.isInteger(pid) || pid <= 1 || !(await ownsProcess(pid, paths))) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
