import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type DshConfig = { upstreamUrl: string; launchUrl?: string; journalUnit?: string }
export type DshSession = { target: URL; cookie: string; expiresAt: number }

export class DshBridgeError extends Error {
  constructor(message: string, readonly status = 503) { super(message) }
}

/** Credentials stay on the host; the DSH installation and profile are read-only. */
export class DshConnection {
  private session?: DshSession
  private pending?: Promise<DshSession>

  constructor(private readonly options: {
    config?: () => Promise<DshConfig | undefined>
    configPath?: string
  } = {}) {}

  private async config(): Promise<DshConfig | undefined> {
    if (this.options.config) return this.options.config()
    const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
    const path = this.options.configPath || process.env.CODEXUI_DSH_CONFIG || join(codexHome, 'dsh-bridge.json')
    let config: Partial<DshConfig> = {}
    try {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      config = value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DshBridgeError('DSH 接入配置无效，请检查主机配置。')
    }
    const launchUrl = process.env.CODEXUI_DSH_LAUNCH_URL || config.launchUrl
    const upstreamUrl = process.env.CODEXUI_DSH_URL || config.upstreamUrl || launchUrl
    const journalUnit = process.env.CODEXUI_DSH_JOURNAL_UNIT || config.journalUnit
    if (!upstreamUrl) return undefined
    if (typeof upstreamUrl !== 'string' || (launchUrl !== undefined && typeof launchUrl !== 'string') || (journalUnit !== undefined && typeof journalUnit !== 'string')) {
      throw new DshBridgeError('DSH 接入配置无效，请检查主机配置。')
    }
    return { upstreamUrl, launchUrl, journalUnit }
  }

  private async launchToken(config: DshConfig): Promise<string> {
    let source = config.launchUrl || config.upstreamUrl
    if (config.journalUnit) {
      if (!/^[\w.@:-]+\.service$/u.test(config.journalUnit)) throw new DshBridgeError('DSH 服务名称无效。')
      try {
        const { stdout } = await exec('journalctl', [
          `--unit=${config.journalUnit}`, '--boot', '--grep=dsh web:', '--output=cat', '--lines=1', '--no-pager',
        ], { timeout: 5000, maxBuffer: 32768 })
        source = (stdout.match(/https?:\/\/[^\s\u001b]+/gu) || []).find(value => {
          try { return new URL(value).searchParams.has('token') } catch { return false }
        }) || ''
      } catch { throw new DshBridgeError('无法读取 DSH 的启动授权，请检查服务日志权限。') }
    }
    try {
      const url = new URL(source)
      const tokens = url.searchParams.getAll('token')
      if (!['http:', 'https:'].includes(url.protocol) || tokens.length !== 1 || !tokens[0]) throw new Error()
      return tokens[0]
    } catch { throw new DshBridgeError('DSH 启动授权不可用，请重新连接服务。') }
  }

  ready(): Promise<DshSession> {
    if (this.session && this.session.expiresAt > Date.now()) return Promise.resolve(this.session)
    if (this.pending) return this.pending
    this.pending = this.connect().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async connect(): Promise<DshSession> {
    const config = await this.config()
    if (!config) throw new DshBridgeError('尚未接入 DSH，请先在这台主机配置已有的 DSH 服务。')
    let target: URL
    try {
      target = new URL(config.upstreamUrl)
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/') throw new Error()
      target.search = ''; target.hash = ''
    } catch { throw new DshBridgeError('DSH 服务地址无效。') }
    const launch = new URL(target)
    launch.searchParams.set('token', await this.launchToken(config))
    let response: Response
    try {
      response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    } catch { throw new DshBridgeError('暂时无法连接 DSH，请确认服务正在运行。') }
    try {
      const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || '']
      const raw = cookies.find(value => value.startsWith('dsh-auth-'))
      if (response.status !== 303 || !raw) throw new DshBridgeError('DSH 授权已失效，请刷新后重试。')
      const age = Number(/Max-Age=(\d+)/iu.exec(raw)?.[1] || 3600)
      const session = { target, cookie: raw.split(';')[0]!, expiresAt: Date.now() + Math.max(1, age - 30) * 1000 }
      this.session = session
      return session
    } finally { await response.body?.cancel().catch(() => {}) }
  }

  invalidate(session: DshSession): void { if (this.session === session) this.session = undefined }
}
