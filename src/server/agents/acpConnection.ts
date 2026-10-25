import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { client, methods, ndJsonStream, type ClientConnection, type InitializeResponse, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from '@agentclientprotocol/sdk'
import { prepareDshLaunch, type DshLaunch } from './dshProfile.js'

export type AcpTransport = {
  initialize(): Promise<InitializeResponse>
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>
  notify(method: string, params: unknown): Promise<void>
  dispose(): Promise<void>
}

/** Official SDK owns framing, validation, correlation, and concurrent cancellation. */
export class AcpConnection implements AcpTransport {
  private child?: ChildProcessWithoutNullStreams
  private connection?: ClientConnection
  private init?: Promise<InitializeResponse>
  private stopping = false
  private generation = 0

  constructor(private readonly handlers: {
    update: (notification: SessionNotification) => void | Promise<void>
    permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>
    exit: (error: Error) => void
  }, private readonly launch: () => Promise<DshLaunch> = prepareDshLaunch) {}

  initialize(): Promise<InitializeResponse> {
    if (this.init) return this.init
    const generation = this.generation + 1
    const initializing = this.start().catch(async error => {
      if (generation === this.generation) await this.dispose()
      if (this.init === initializing) this.init = undefined
      throw error
    })
    this.init = initializing
    return initializing
  }

  private async start(): Promise<InitializeResponse> {
    this.stopping = false
    const generation = ++this.generation
    const launch = await this.launch()
    if (generation !== this.generation || this.stopping) throw new Error('DSH 连接已关闭。')
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    // Credentials and arbitrary plugin logs must never reach browser errors.
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    let failed = false
    const fail = () => {
      if (failed || this.stopping || generation !== this.generation) return
      failed = true
      this.handlers.exit(new Error('DSH ACP 连接已断开，请重试连接；当前任务不会自动重新发送。'))
    }
    child.once('error', fail)
    child.once('exit', fail)
    this.connection = client({ name: 'Codex Remote' })
      .onNotification(methods.client.session.update, ({ params }) => this.handlers.update(params))
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.handlers.permission(params))
      .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, { maxMessageBytes: 16 * 1024 * 1024 }))
    this.connection.closed.then(() => { if (!this.stopping) fail() }).catch(() => { if (!this.stopping) fail() })
    return this.request<InitializeResponse>('initialize', { protocolVersion: 1, clientInfo: { name: 'codex-remote', version: '0.1.87' }, clientCapabilities: {} }, 30_000)
  }

  async request<T>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    const connection = this.connection
    if (!connection) throw new Error('DSH ACP 尚未连接。')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const request = connection.agent.request<T, unknown>(method, params, { cancellationSignal: controller.signal })
    const timeout = new Promise<never>((_, reject) => {
      if (timeoutMs <= 0) return
      timer = setTimeout(() => {
        controller.abort()
        // ACP cancellation is cooperative. Close an indeterminate RPC rather
        // than leave a hidden session/new or configuration request running.
        connection.close()
        reject(new Error('DSH 响应超时，请重新连接后重试。'))
      }, timeoutMs)
    })
    try { return await (timeoutMs > 0 ? Promise.race([request, timeout]) : request) }
    finally { if (timer) clearTimeout(timer) }
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.connection) throw new Error('DSH ACP 尚未连接。')
    await this.connection.agent.notify(method, params)
  }

  async dispose(): Promise<void> {
    this.stopping = true
    this.generation++
    this.connection?.close()
    const child = this.child
    this.child = undefined; this.connection = undefined; this.init = undefined
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGTERM'), 1500)
        const deadline = setTimeout(() => child.kill('SIGKILL'), 4000)
        child.once('exit', () => { clearTimeout(timer); clearTimeout(deadline); resolve() })
      })
    }
  }
}
