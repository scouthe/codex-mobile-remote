import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { isPhoneRunActive, type PhoneAgentState, type PhoneEvent, type PhoneRun } from '../types/phoneAgent.js'
import { PhoneAgentError } from './phoneHttp.js'
export { PhoneAgentError } from './phoneHttp.js'

const exec = promisify(execFile)
type StoredRun = PhoneRun & { events: PhoneEvent[] }
type ManagerOptions = { root?: string; stateDir?: string; runner?: string; python?: string; adb?: string }
const MAX_EVENTS = 400

export class PhoneAgentManager {
  readonly root: string
  readonly stateDir: string
  readonly runner: string
  readonly python: string
  readonly adb: string
  private runs = new Map<string, StoredRun>()
  private initialized?: Promise<void>
  private active?: { run: StoredRun; child?: ChildProcess; killTimer?: NodeJS.Timeout; done: Promise<void>; finish: () => void }
  private manualLease?: symbol
  private writes = Promise.resolve()
  private deviceCache?: { until: number; value: PhoneAgentState['devices'] }
  private deviceRequest?: Promise<PhoneAgentState['devices']>

  constructor(options: ManagerOptions = {}) {
    this.root = options.root ?? process.env.VENUS_AGENT_ROOT ?? join(homedir(), 'common', 'UI-Venus')
    this.stateDir = options.stateDir ?? process.env.VENUS_AGENT_STATE_DIR ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'phone-agent')
    this.runner = options.runner ?? [
      join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'venus-web-agent.py'),
      join(process.cwd(), 'scripts', 'venus-web-agent.py'),
    ].find(existsSync) ?? ''
    this.python = options.python ?? join(this.root, '.venv', 'bin', 'python')
    this.adb = options.adb ?? process.env.VENUS_ADB_PATH ?? join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb')
  }

  private init(): Promise<void> {
    return this.initialized ??= (async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
      const files = (await readdir(this.stateDir)).filter(name => /^\d+-[\da-f-]+\.json$/.test(name)).sort().slice(-100)
      for (const file of files) {
        try {
          const run = JSON.parse(await readFile(join(this.stateDir, file), 'utf8')) as StoredRun
          if (!run.id || !Array.isArray(run.events)) continue
          this.runs.set(run.id, run)
          if (isPhoneRunActive(run.status)) {
            this.event(run, { type: 'result', status: 'interrupted', message: '服务已重启，任务已中断。可根据手机当前状态重新发送任务。' })
          }
        } catch { /* A partially written or unrelated file is not a conversation. */ }
      }
    })()
  }

  private persist(run: StoredRun): void {
    const body = JSON.stringify(run)
    const path = join(this.stateDir, run.id + '.json')
    this.writes = this.writes.then(async () => {
      await writeFile(path + '.tmp', body, { mode: 0o600 })
      await rename(path + '.tmp', path)
    }).catch(error => { console.error('Phone Agent history:', error) })
  }

  private summary(run: StoredRun): PhoneRun {
    const { events: _events, ...summary } = run
    return summary
  }

  private event(run: StoredRun, input: Omit<PhoneEvent, 'seq' | 'at'>): void {
    const event: PhoneEvent = { ...input, seq: (run.events.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString() }
    run.events.push(event)
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS)
    run.updatedAt = event.at
    run.message = event.message || run.message
    if (event.status && !(run.status === 'stopping' && event.type !== 'result')) run.status = event.status
    if (event.step) run.step = event.step
    if (event.screenshot && /^preview-\d+\.jpg$/.test(event.screenshot)) run.screenshot = event.screenshot
    this.persist(run)
  }

  async devices(): Promise<PhoneAgentState['devices']> {
    if (this.deviceCache && Date.now() < this.deviceCache.until) return this.deviceCache.value
    if (this.deviceRequest) return this.deviceRequest
    this.deviceRequest = (async () => {
      const { stdout } = await exec(this.adb, ['devices', '-l'], { timeout: 5000, maxBuffer: 32768 })
      const rows = stdout.split(/\r?\n/).slice(1).filter(line => line.trim()).slice(0, 8)
      const devices = await Promise.all(rows.map(async line => {
        const [id = '', state = 'unknown'] = line.trim().split(/\s+/)
        let model = /model:(\S+)/.exec(line)?.[1]?.replace(/_/g, ' ') || id
        let keyboardReady = false
        if (state === 'device') {
          const values = await Promise.allSettled([
            exec(this.adb, ['-s', id, 'shell', 'getprop', 'ro.product.marketname'], { timeout: 4000 }),
            exec(this.adb, ['-s', id, 'shell', 'settings', 'get', 'secure', 'default_input_method'], { timeout: 4000 }),
          ])
          if (values[0]?.status === 'fulfilled') model = values[0].value.stdout.trim() || model
          if (values[1]?.status === 'fulfilled') keyboardReady = values[1].value.stdout.trim() === 'com.android.adbkeyboard/.AdbIME'
        }
        return { id, model, state, keyboardReady }
      }))
      this.deviceCache = { until: Date.now() + 3000, value: devices }
      return devices
    })().finally(() => { this.deviceRequest = undefined })
    return this.deviceRequest
  }

  async state(): Promise<PhoneAgentState> {
    await this.init()
    const available = existsSync(this.python) && existsSync(this.runner) && existsSync(join(this.root, 'deployment', 'run_mobile.py'))
    let devices: PhoneAgentState['devices'] = []
    let message = available ? '' : '本机尚未安装 UI-Venus Agent。'
    try { devices = await this.devices() } catch { message = '无法读取 ADB 设备，请检查连接。' }
    return { available, message, devices, runs: [...this.runs.values()].map(run => this.summary(run)) }
  }

  async detail(id: string, after = 0) {
    await this.init()
    const run = this.runs.get(id)
    if (!run) throw new PhoneAgentError('任务不存在。', 404)
    return { run: this.summary(run), events: run.events.filter(event => event.seq > after), cursor: run.events.at(-1)?.seq ?? 0 }
  }

  async start(input: { purpose?: unknown; deviceId?: unknown; stepLimit?: unknown; previousRunId?: unknown }): Promise<PhoneRun> {
    await this.init()
    if (this.manualLease) throw new PhoneAgentError('手机正在人工接管，请先结束接管或交回 Agent。', 409)
    if (this.active) throw new PhoneAgentError('手机正在执行任务，请先停止当前任务。', 409)
    const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : ''
    if (!purpose || purpose.length > 4000) throw new PhoneAgentError('请输入 1–4000 字的任务。')
    const stepLimit = input.stepLimit === undefined ? 15 : Number(input.stepLimit)
    if (!Number.isInteger(stepLimit) || stepLimit < 1 || stepLimit > 50) throw new PhoneAgentError('步数范围为 1–50。')
    if (!existsSync(this.python) || !existsSync(this.runner)) throw new PhoneAgentError('本机 Agent 未安装。', 503)
    // Reserve the slot before any asynchronous device/file work.
    const now = new Date().toISOString()
    const run: StoredRun = { id: `${Date.now()}-${randomUUID()}`, purpose, deviceId: '', stepLimit, status: 'loading', createdAt: now, updatedAt: now, step: 0, message: '正在准备手机…', events: [] }
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const active: NonNullable<PhoneAgentManager['active']> = { run, done, finish }
    this.active = active
    try {
      const devices = (await this.devices()).filter(device => device.state === 'device')
      const device = typeof input.deviceId === 'string' ? devices.find(item => item.id === input.deviceId) : devices.length === 1 ? devices[0] : undefined
      if (!device) throw new PhoneAgentError('请选择一台已授权的手机。')
      if (!device.keyboardReady) throw new PhoneAgentError('请先将手机输入法切换为 ADB Keyboard。')
      if (['stopping'].includes(run.status)) throw new PhoneAgentError('任务已被人工接管。', 409)
      run.deviceId = device.id
      const runDir = join(this.stateDir, run.id)
      await mkdir(runDir, { recursive: true, mode: 0o700 })
      let context = ''
      const previous = typeof input.previousRunId === 'string' ? this.runs.get(input.previousRunId) : undefined
      if (previous && previous.deviceId === device.id && !isPhoneRunActive(previous.status)) {
        context = `上一个任务：${previous.purpose.slice(0, 600)}\n上一个任务的结果：${previous.message.slice(0, 1000)}\n以下是用户的新指令，以当前手机截图为准：\n`
      }
      this.runs.set(run.id, run)
      if (this.runs.size > 100) {
        const oldest = [...this.runs.values()].find(item => !isPhoneRunActive(item.status))
        if (oldest) this.runs.delete(oldest.id)
      }
      await writeFile(join(runDir, 'request.json'), JSON.stringify({ purpose: context + purpose, deviceId: device.id, stepLimit }), { mode: 0o600 })
      if (['stopping'].includes(run.status)) throw new PhoneAgentError('任务已被人工接管。', 409)
      this.event(run, { type: 'status', message: '正在加载本地模型…', status: 'loading' })
      const child = spawn(this.python, [this.runner, '--root', this.root, '--run-dir', runDir], {
        cwd: this.root, detached: process.platform !== 'win32',
        env: { ...process.env, PYTHONUNBUFFERED: '1', VENUS_ADB_PATH: this.adb },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      active.child = child
      let stderr = ''
      let terminalEvent: Omit<PhoneEvent, 'seq' | 'at'> | undefined
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-6000) })
      const lines = createInterface({ input: child.stdout! })
      lines.on('line', line => {
        if (line.length > 65536) return
        try {
          const event = JSON.parse(line) as Omit<PhoneEvent, 'seq' | 'at'>
          if (typeof event.type === 'string' && typeof event.message === 'string') {
            if (event.type === 'result') terminalEvent = event
            else this.event(run, event)
          }
        } catch { /* Framework diagnostics go to stderr; stdout is structured events. */ }
      })
      child.once('error', error => {
        terminalEvent = { type: 'result', status: 'failed', message: `Agent 启动失败：${error.message}` }
      })
      child.once('close', () => {
        lines.close()
        if (active.killTimer) clearTimeout(active.killTimer)
        if (this.active === active) this.active = undefined
        if (run.status === 'stopping') this.event(run, { type: 'result', status: 'stopped', message: '任务已停止。' })
        else if (terminalEvent) this.event(run, terminalEvent)
        else if (isPhoneRunActive(run.status)) this.event(run, { type: 'result', status: 'failed', message: stderr.trim().split('\n').at(-1) || 'Agent 意外退出，请检查手机和模型服务。' })
        active.finish()
      })
      return this.summary(run)
    } catch (error) {
      if (this.active === active) this.active = undefined
      if (run.status === 'stopping' && this.runs.has(run.id)) this.event(run, { type: 'result', status: 'stopped', message: '任务已停止，可手动操作手机。' })
      else if (this.runs.has(run.id)) this.event(run, {
        type: 'result',
        status: 'failed',
        message: `Agent 启动失败：${error instanceof Error ? error.message : '无法启动任务。'}`,
      })
      active.finish()
      throw error
    }
  }

  /** Reserve manual ownership before stopping; release only after all manual I/O exits. */
  async claimManual(): Promise<{ previousRun?: PhoneRun; release: () => void }> {
    await this.init()
    if (this.manualLease) throw new PhoneAgentError('手机已在另一个窗口接管。', 409)
    const lease = Symbol('manual')
    this.manualLease = lease
    try {
      const active = this.active
      if (active) { await this.stop(active.run.id); await active.done }
      return {
        previousRun: active?.run.deviceId ? this.summary(active.run) : undefined,
        release: () => { if (this.manualLease === lease) this.manualLease = undefined },
      }
    } catch (error) { if (this.manualLease === lease) this.manualLease = undefined; throw error }
  }

  async stop(id: string): Promise<PhoneRun> {
    await this.init()
    const active = this.active
    if (!active || active.run.id !== id) return (await this.detail(id)).run
    if (active.run.status === 'stopping') return this.summary(active.run)
    this.event(active.run, { type: 'status', status: 'stopping', message: '正在停止任务并释放模型…' })
    if (active.child?.pid) {
      active.child.kill('SIGTERM')
      active.killTimer = setTimeout(() => {
        if (this.active !== active || !active.child?.pid) return
        try { process.kill(process.platform === 'win32' ? active.child.pid : -active.child.pid, 'SIGKILL') } catch { /* Already exited. */ }
      }, 25000)
      active.killTimer.unref()
    }
    return this.summary(active.run)
  }

  async screenshot(id: string): Promise<string> {
    await this.init()
    const run = this.runs.get(id)
    if (!run?.screenshot) throw new PhoneAgentError('任务尚未生成截图。', 404)
    return join(this.stateDir, run.id, basename(run.screenshot))
  }

  async capture(deviceId: string): Promise<string> {
    await this.init()
    const device = (await this.devices()).find(item => item.id === deviceId && item.state === 'device')
    if (!device) throw new PhoneAgentError('手机未连接。', 409)
    const { stdout } = await exec(this.adb, ['-s', device.id, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', timeout: 10000, maxBuffer: 12 * 1024 * 1024 })
    const path = join(this.stateDir, 'current-screen.png')
    await writeFile(path, stdout, { mode: 0o600 })
    return path
  }

  dispose(): void { if (this.active) void this.stop(this.active.run.id) }
}
