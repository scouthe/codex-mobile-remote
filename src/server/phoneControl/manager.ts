import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { PhoneAgentManager } from '../phoneAgent.js'
import type { PhoneRun } from '../../types/phoneAgent.js'
import type { PhoneControlSession, PhoneControlState, PhoneVideoFormat } from '../../types/phoneControl.js'
import { PhoneAgentError } from '../phoneHttp.js'
import { PhoneAdbInput, validatePhoneInput } from './adbInput.js'
import { PhoneMirror, defaultScrcpyServer } from './scrcpy.js'

type Agent = Pick<PhoneAgentManager, 'adb' | 'devices' | 'claimManual' | 'detail' | 'start'>
type Mirror = Pick<PhoneMirror, 'start' | 'stop' | 'format'>
type MirrorOptions = ConstructorParameters<typeof PhoneMirror>[0]
type Session = {
  public: PhoneControlSession
  release: () => void
  mirror?: Mirror
  input: Pick<PhoneAdbInput, 'execute'>
  action?: Promise<void>
  attached: boolean
  timer?: NodeJS.Timeout
  closing?: Promise<void>
  endStream?: () => void
}

/** Owns the entire handoff lifecycle. Routes and the UI cannot bypass its lease. */
export class PhoneControlManager {
  private session?: Session
  private acquiring = false
  private disposed = false

  constructor(private readonly agent: Agent, private readonly options: {
    mirror?: (options: MirrorOptions) => Mirror
    input?: (deviceId: string) => Pick<PhoneAdbInput, 'execute'>
    available?: () => boolean
    leaseMs?: number
  } = {}) {}

  state(): PhoneControlState {
    const available = this.options.available?.() ?? existsSync(defaultScrcpyServer())
    return { available, busy: this.acquiring || !!this.session, message: available ? '' : '请先运行 pnpm run setup:phone-mirror 安装投屏依赖。' }
  }

  async acquire(input: Record<string, unknown>, signal?: AbortSignal): Promise<PhoneControlSession> {
    if (this.disposed) throw new PhoneAgentError('服务正在关闭。', 503)
    if (this.acquiring || this.session) throw new PhoneAgentError('手机已在另一个窗口接管。', 409)
    if (!this.state().available) throw new PhoneAgentError(this.state().message, 503)
    if (typeof input.deviceId !== 'string') throw new PhoneAgentError('请选择要接管的手机。')
    this.acquiring = true
    let lease: Awaited<ReturnType<Agent['claimManual']>> | undefined
    try {
      const device = (await this.agent.devices()).find(device => device.id === input.deviceId && device.state === 'device')
      if (!device) throw new PhoneAgentError('手机未连接或尚未授权。', 409)
      if (signal?.aborted || this.disposed) throw new PhoneAgentError('接管已取消。', 409)
      lease = await this.agent.claimManual()
      if (signal?.aborted || this.disposed) throw new PhoneAgentError('接管已取消。', 409)
      let previous = lease.previousRun
      if (!previous && typeof input.previousRunId === 'string') previous = (await this.agent.detail(input.previousRunId)).run
      if (previous?.deviceId !== device.id) previous = undefined
      if (signal?.aborted || this.disposed) throw new PhoneAgentError('接管已取消。', 409)
      const session: Session = {
        public: { id: randomUUID(), deviceId: device.id, previousRunId: previous?.id, purpose: previous?.purpose, stepLimit: previous?.stepLimit ?? 15 },
        release: lease.release,
        input: this.options.input?.(device.id) ?? new PhoneAdbInput(this.agent.adb, device.id),
        attached: false,
      }
      this.session = session
      this.renew(session)
      return session.public
    } catch (error) { lease?.release(); throw error }
    finally { this.acquiring = false }
  }

  private get(id: string): Session {
    const session = this.session
    if (!session || session.public.id !== id || session.closing) throw new PhoneAgentError('接管已结束，请重新接管手机。', 409)
    return session
  }

  heartbeat(id: string): void { this.renew(this.get(id)) }

  private renew(session: Session): void {
    clearTimeout(session.timer)
    session.timer = setTimeout(() => { void this.release(session.public.id) }, this.options.leaseMs ?? 18000)
    session.timer.unref()
  }

  async stream(id: string, output: {
    format: (format: PhoneVideoFormat) => void
    data: (data: Uint8Array) => void
    error: (error: Error) => void
    close: () => void
  }): Promise<void> {
    const session = this.get(id)
    if (session.attached) throw new PhoneAgentError('此接管窗口已经连接投屏。', 409)
    session.attached = true
    session.endStream = output.close
    const mirror = (this.options.mirror ?? (options => new PhoneMirror(options)))({
      adb: this.agent.adb, deviceId: session.public.deviceId,
      format: output.format, data: output.data,
      ended: error => { output.error(error); void this.release(id) },
    })
    session.mirror = mirror
    try { await mirror.start() }
    catch (error) { await this.release(id); throw error }
  }

  async input(id: string, value: unknown): Promise<void> {
    const input = validatePhoneInput(value)
    const session = this.get(id)
    const waking = input.type === 'key' && input.key === 'wake'
    if (!session.attached || (!session.mirror?.format && !waking)) throw new PhoneAgentError('请等待实时画面连接。', 409)
    if (session.action) throw new PhoneAgentError('上一个操作尚未完成。', 409)
    this.renew(session)
    const action = session.input.execute(input, session.mirror?.format)
    session.action = action
    try { await action }
    finally { if (session.action === action) session.action = undefined }
  }

  release(id: string): Promise<void> {
    const session = this.session
    if (!session || session.public.id !== id) return Promise.resolve()
    if (session.closing) return session.closing
    clearTimeout(session.timer)
    session.closing = (async () => {
      try {
        await Promise.allSettled([session.action, session.mirror?.stop()])
      } finally {
        session.endStream?.()
        session.release()
        if (this.session === session) this.session = undefined
      }
    })()
    return session.closing
  }

  async resume(input: Record<string, unknown>): Promise<PhoneRun> {
    if (typeof input.previousRunId !== 'string') throw new PhoneAgentError('请选择要继续的任务，或在对话中发送新任务。')
    const previous = (await this.agent.detail(input.previousRunId)).run
    if (previous.deviceId !== input.deviceId) throw new PhoneAgentError('任务与当前手机不匹配。')
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (note.length > 1000) throw new PhoneAgentError('补充说明最多 1000 字。')
    if (typeof input.sessionId === 'string') await this.release(input.sessionId)
    return this.agent.start({
      purpose: `继续完成原任务：${previous.purpose.slice(0, 2800)}\n用户已手动操作手机。请先查看当前屏幕，再完成剩余目标，避免重复已完成操作。${note ? '\n用户补充：' + note : ''}`,
      deviceId: previous.deviceId, stepLimit: previous.stepLimit, previousRunId: previous.id,
    })
  }

  dispose(): void { this.disposed = true; if (this.session) void this.release(this.session.public.id) }
}
