import { PHONE_VIDEO_DATA, PHONE_VIDEO_ERROR, PHONE_VIDEO_FORMAT, PHONE_VIDEO_MAX_PACKET, type PhoneVideoFormat } from '../types/phoneControl'

/** HTTP + MediaSource works on LAN HTTP as well as HTTPS; WebCodecs isn't required. */
export class PhoneVideoPlayer {
  private readonly controller = new AbortController()
  private source?: MediaSource
  private buffer?: SourceBuffer
  private objectUrl = ''
  private stopped = false

  constructor(private readonly video: HTMLVideoElement, private readonly output: {
    format: (format: PhoneVideoFormat) => void
    ready: () => void
  }) {}

  static supported(): boolean { return typeof MediaSource !== 'undefined' && typeof ReadableStream !== 'undefined' }

  async play(url: string): Promise<void> {
    const response = await fetch(url, { signal: this.controller.signal, cache: 'no-store' })
    if (!response.ok) throw new Error((await response.json()).error || '投屏连接失败。')
    if (!response.body) throw new Error('浏览器不支持视频流，请使用新版 Chrome 或 Edge。')
    const reader = response.body.getReader()
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    try {
      while (!this.stopped) {
        const { value, done } = await reader.read()
        if (done) break
        if (pending.length + value.length > PHONE_VIDEO_MAX_PACKET + 65536) throw new Error('投屏缓冲已满，请重新接管。')
        const joined = new Uint8Array(pending.length + value.length)
        joined.set(pending); joined.set(value, pending.length); pending = joined
        while (pending.length >= 5) {
          const size = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(1)
          if (size > PHONE_VIDEO_MAX_PACKET) throw new Error('视频数据格式不正确。')
          if (pending.length < 5 + size) break
          const kind = pending[0], bytes = pending.slice(5, 5 + size)
          pending = pending.subarray(5 + size)
          if (kind === PHONE_VIDEO_FORMAT) await this.configure(JSON.parse(new TextDecoder().decode(bytes)))
          else if (kind === PHONE_VIDEO_DATA) await this.append(bytes)
          else if (kind === PHONE_VIDEO_ERROR) throw new Error(new TextDecoder().decode(bytes))
          else throw new Error('不支持此视频消息。')
        }
      }
      if (!this.stopped) throw new Error('投屏连接已断开，Agent 保持停止。')
    } finally { await reader.cancel().catch(() => {}) }
  }

  private wait(target: EventTarget, event: string, action?: () => void): Promise<void> {
    const signal = this.controller.signal
    return new Promise((resolve, reject) => {
      const cleanup = () => { target.removeEventListener(event, done); target.removeEventListener('error', error); signal.removeEventListener('abort', abort) }
      const done = () => { cleanup(); resolve() }
      const error = () => { cleanup(); reject(new Error('视频播放失败，请使用新版 Chrome 或 Edge。')) }
      const abort = () => { cleanup(); reject(new DOMException('播放已停止。', 'AbortError')) }
      target.addEventListener(event, done, { once: true }); target.addEventListener('error', error, { once: true })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else if (action) { try { action() } catch (cause) { cleanup(); reject(cause) } }
    })
  }

  private async configure(format: PhoneVideoFormat): Promise<void> {
    const mime = `video/mp4; codecs="${format.codec}"`
    if (!PhoneVideoPlayer.supported() || !MediaSource.isTypeSupported(mime)) throw new Error('浏览器不支持此手机的视频编码，请使用新版 Chrome 或 Edge。')
    this.video.pause()
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    const source = new MediaSource()
    this.source = source; this.buffer = undefined
    this.objectUrl = URL.createObjectURL(source)
    const opened = this.wait(source, 'sourceopen')
    this.video.src = this.objectUrl
    await opened
    if (this.stopped) return
    this.buffer = source.addSourceBuffer(mime)
    this.output.format(format)
    this.video.addEventListener('loadeddata', () => { if (!this.stopped) this.output.ready() }, { once: true, signal: this.controller.signal })
  }

  private async append(bytes: Uint8Array): Promise<void> {
    const buffer = this.buffer
    if (!buffer || this.stopped) return
    if (this.video.error) throw new Error('视频解码失败，请重新接管。')
    await this.wait(buffer, 'updateend', () => buffer.appendBuffer(new Uint8Array(bytes)))
    if (this.stopped || !buffer.buffered.length) return
    const end = buffer.buffered.end(buffer.buffered.length - 1)
    // Bound both playback lag and memory. Never accumulate a recording in the browser.
    if (end - this.video.currentTime > 0.55) this.video.currentTime = Math.max(buffer.buffered.start(0), end - 0.15)
    if (this.video.paused) void this.video.play().catch(() => {})
    const trim = this.video.currentTime - 8
    if (trim > 0 && buffer.buffered.start(0) < trim) {
      await this.wait(buffer, 'updateend', () => buffer.remove(0, trim))
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true; this.controller.abort()
    this.video.pause(); this.video.removeAttribute('src'); this.video.load()
    this.source = undefined; this.buffer = undefined
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = ''
  }
}
