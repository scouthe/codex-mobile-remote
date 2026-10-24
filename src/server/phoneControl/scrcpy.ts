import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { promisify } from 'node:util'
import type { PhoneVideoFormat } from '../../types/phoneControl.js'
import { ScrcpyMp4Stream } from './h264Mp4.js'

const exec = promisify(execFile)
export const SCRCPY_VERSION = '5.0.1'
export const defaultScrcpyServer = () => process.env.VENUS_SCRCPY_SERVER || join(homedir(), '.local', 'share', 'codexapp', 'scrcpy', SCRCPY_VERSION, 'server.jar')

/** Owns exactly one phone encoder, ADB forward and socket. Lazy: constructor does no I/O. */
export class PhoneMirror {
  private child?: ChildProcess
  private socket?: Socket
  private port?: number
  private stopped = false
  private stopping?: Promise<void>
  private ready?: Promise<void>
  private logs = ''
  private startupTimer?: NodeJS.Timeout
  private retryTimer?: NodeJS.Timeout
  private rejectStartup?: (error: Error) => void
  private preparing?: Promise<void>
  private remote?: string
  format?: PhoneVideoFormat

  constructor(private readonly options: {
    adb: string; deviceId: string; server?: string
    format: (format: PhoneVideoFormat) => void
    data: (data: Uint8Array) => void
    ended: (error: Error) => void
  }) {}

  start(): Promise<void> { return this.ready ??= this.open() }

  private async adb(args: string[]): Promise<string> {
    const result = await exec(this.options.adb, ['-s', this.options.deviceId, ...args], { timeout: 8000, maxBuffer: 65536 })
    return result.stdout.trim()
  }

  private checkOpen(): void { if (this.stopped) throw new Error('投屏已关闭。') }

  private async prepare(): Promise<void> {
      this.checkOpen()
      const server = this.options.server ?? defaultScrcpyServer()
      if (!existsSync(server)) throw new Error('投屏依赖尚未安装，请运行 pnpm run setup:phone-mirror。')
      const id = (randomBytes(4).readUInt32BE() & 0x7fffffff).toString(16).padStart(8, '0')
      const remote = `/data/local/tmp/codexapp-scrcpy-${id}.jar`
      this.remote = remote
      await this.adb(['push', server, remote])
      this.checkOpen()
      const port = await this.adb(['forward', 'tcp:0', `localabstract:scrcpy_${id}`])
      this.port = Number(port)
      this.checkOpen()
      if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('无法建立手机投屏连接。')
      this.child = spawn(this.options.adb, ['-s', this.options.deviceId, 'shell', `CLASSPATH=${remote}`,
        'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
        `scid=${id}`, 'tunnel_forward=true', 'audio=false', 'control=false', 'cleanup=true',
        'send_device_meta=false', 'send_dummy_byte=false', 'video_codec=h264',
        'max_size=1280', 'max_fps=30', 'video_bit_rate=2000000',
        'video_codec_options=i-frame-interval:float=0.2,max-bframes=0',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      this.child.stdout?.on('data', data => { this.logs = (this.logs + data.toString()).slice(-2000) })
      this.child.stderr?.on('data', data => { this.logs = (this.logs + data.toString()).slice(-2000) })
      this.child.once('error', error => this.fail(error))
      this.child.once('close', () => { if (!this.stopped) this.fail(new Error('手机投屏已结束。' + this.logs.slice(-700))) })
  }

  private async open(): Promise<void> {
    try {
      await (this.preparing = this.prepare())
      this.checkOpen()
      await new Promise<void>((resolve, reject) => {
        this.rejectStartup = reject
        this.startupTimer = setTimeout(() => { const error = new Error('手机投屏启动超时。'); reject(error); this.fail(error) }, 12000)
        const parser = new ScrcpyMp4Stream({
          format: format => { this.format = format; this.options.format(format); clearTimeout(this.startupTimer); resolve() },
          data: data => this.options.data(data),
        })
        const connect = () => {
          if (this.stopped) return reject(new Error('投屏已关闭。'))
          const socket = createConnection({ host: '127.0.0.1', port: this.port! })
          this.socket = socket
          let received = false
          socket.on('data', data => {
            received = true
            try { parser.push(data) } catch (error) { reject(error); this.fail(error instanceof Error ? error : new Error('视频解析失败。')) }
          })
          // ADB accepts sockets before the phone's abstract socket is listening.
          socket.on('error', () => { /* close handles startup retries and established failures. */ })
          socket.once('close', () => {
            if (this.stopped) return reject(new Error('投屏已关闭。'))
            if (!received && !this.format) { this.retryTimer = setTimeout(connect, 100); this.retryTimer.unref(); return }
            const error = new Error('手机投屏连接已断开。'); reject(error); this.fail(error)
          })
        }
        connect()
      })
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  private fail(error: Error): void {
    if (this.stopped) return
    this.rejectStartup?.(error)
    this.options.ended(error)
    void this.stop()
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true; clearTimeout(this.startupTimer); clearTimeout(this.retryTimer)
    this.rejectStartup?.(new Error('投屏已关闭。'))
    this.stopping = (async () => {
      await this.preparing?.catch(() => {})
      this.socket?.destroy()
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        const closed = new Promise<void>(resolve => this.child!.once('close', () => resolve()))
        this.child.kill('SIGTERM')
        const kill = setTimeout(() => this.child?.kill('SIGKILL'), 1500)
        kill.unref(); await closed; clearTimeout(kill)
      }
      if (this.port) await exec(this.options.adb, ['-s', this.options.deviceId, 'forward', '--remove', `tcp:${this.port}`], { timeout: 3000 }).catch(() => {})
      if (this.remote) await exec(this.options.adb, ['-s', this.options.deviceId, 'shell', 'rm', '-f', this.remote], { timeout: 3000 }).catch(() => {})
    })()
    return this.stopping
  }
}
