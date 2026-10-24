import type { PhoneVideoFormat } from '../../types/phoneControl.js'
import { mp4Fragment, mp4Initialization } from './fragmentedMp4.js'

const MAX_PACKET = 4 * 1024 * 1024

/** Annex B NALs -> length-prefixed AVC samples. No decoding or transcoding. */
function nals(data: Buffer): Buffer[] {
  const starts: Array<{ start: number; end: number }> = []
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue
    const size = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0
    if (size) { starts.push({ start: i, end: i + size }); i += size - 1 }
  }
  return starts.map((entry, index) => data.subarray(entry.end, starts[index + 1]?.start ?? data.length)).filter(nal => nal.length)
}

function configuration(sps: Buffer, pps: Buffer): Buffer {
  const data = Buffer.alloc(11 + sps.length + pps.length)
  data.set([1, sps[1]!, sps[2]!, sps[3]!, 255, 225])
  data.writeUInt16BE(sps.length, 6); sps.copy(data, 8)
  const offset = 8 + sps.length
  data[offset] = 1; data.writeUInt16BE(pps.length, offset + 1); pps.copy(data, offset + 3)
  return data
}

/** Parses the pinned scrcpy 5 protocol and emits a fresh fMP4 stream on rotation. */
export class ScrcpyMp4Stream {
  private buffer: Buffer = Buffer.alloc(0)
  private header = false
  private width = 0
  private height = 0
  private epoch = 0
  private sps?: Buffer
  private pps?: Buffer
  private origin?: number
  private previous?: { data: Buffer; timestamp: number; key: boolean }
  private sequence = 0
  private lastTimestamp = -1

  constructor(private readonly output: {
    format: (format: PhoneVideoFormat) => void
    data: (data: Uint8Array) => void
  }) {}

  push(chunk: Buffer): void {
    if (this.buffer.length + chunk.length > MAX_PACKET + 65536) throw new Error('手机视频数据超出缓冲限制。')
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    if (!this.header) {
      if (this.buffer.length < 4) return
      if (this.buffer.subarray(0, 4).toString() !== 'h264') throw new Error('手机未提供 H.264 视频。')
      this.buffer = this.buffer.subarray(4); this.header = true
    }
    while (this.buffer.length >= 12) {
      const flags = this.buffer[0]!
      if (flags & 0x80) {
        this.reset(this.buffer.readUInt32BE(4), this.buffer.readUInt32BE(8))
        this.buffer = this.buffer.subarray(12)
        continue
      }
      const size = this.buffer.readUInt32BE(8)
      if (!size || size > MAX_PACKET) throw new Error('手机视频帧大小不正确。')
      if (this.buffer.length < 12 + size) return
      const data = this.buffer.subarray(12, 12 + size)
      const timestamp = Number(this.buffer.readBigUInt64BE(0) & ((1n << 61n) - 1n))
      this.packet(data, timestamp, !!(flags & 0x40), !!(flags & 0x20))
      this.buffer = this.buffer.subarray(12 + size)
    }
  }

  private reset(width: number, height: number): void {
    if (!width || !height || width > 8192 || height > 8192) throw new Error('手机视频尺寸不正确。')
    // Each display session has its own init segment and timestamp origin.
    this.width = width; this.height = height; this.epoch++
    this.sps = this.pps = undefined; this.origin = undefined; this.previous = undefined
    this.sequence = 0; this.lastTimestamp = -1
  }

  private packet(data: Buffer, timestamp: number, config: boolean, key: boolean): void {
    const units = nals(data)
    for (const unit of units) {
      if ((unit[0]! & 31) === 7) this.sps = unit
      if ((unit[0]! & 31) === 8) this.pps = unit
    }
    if (config) return
    if (!this.sps || !this.pps || !this.width || !this.height) throw new Error('手机视频缺少编码配置。')
    if (timestamp <= this.lastTimestamp) return
    this.lastTimestamp = timestamp
    if (this.origin === undefined) {
      const codec = 'avc1.' + this.sps.subarray(1, 4).toString('hex')
      this.output.format({ width: this.width, height: this.height, codec, epoch: this.epoch })
      this.output.data(mp4Initialization(this.width, this.height, configuration(this.sps, this.pps)))
      this.origin = timestamp
    }
    const samples = units.filter(unit => ![7, 8, 9].includes(unit[0]! & 31)).map(unit => {
      const length = Buffer.alloc(4); length.writeUInt32BE(unit.length)
      return Buffer.concat([length, unit])
    })
    if (this.previous) {
      const previous = this.previous
      this.output.data(mp4Fragment(++this.sequence, {
        ...previous, timestamp: previous.timestamp - this.origin, duration: Math.min(0xffffffff, timestamp - previous.timestamp),
      }))
    }
    this.previous = { data: Buffer.concat(samples), timestamp, key }
  }
}
