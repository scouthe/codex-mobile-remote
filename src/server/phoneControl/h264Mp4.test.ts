import { describe, expect, it } from 'vitest'
import { ScrcpyMp4Stream } from './h264Mp4.js'
import type { PhoneVideoFormat } from '../../types/phoneControl.js'

function size(width = 560, height = 1280) { const data = Buffer.alloc(12); data[0] = 128; data.writeUInt32BE(width, 4); data.writeUInt32BE(height, 8); return data }
function packet(timestamp: number, flags = 0, data = Buffer.from([0, 0, 0, 1, flags & 32 ? 0x65 : 0x41, 0x88])) {
  const header = Buffer.alloc(12); header.writeBigUInt64BE(BigInt(timestamp) | (BigInt(flags) << 56n)); header.writeUInt32BE(data.length, 8)
  return Buffer.concat([header, data])
}
const config = packet(0, 64, Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x20, 0x95, 0, 0, 1, 0x68, 0xeb, 0xef]))

describe('scrcpy to append-only fragmented MP4', () => {
  it('handles byte boundaries and emits delta frames without waiting for another keyframe', () => {
    const formats: PhoneVideoFormat[] = [], chunks: Buffer[] = []
    const stream = new ScrcpyMp4Stream({ format: value => formats.push(value), data: data => chunks.push(Buffer.from(data)) })
    const wire = Buffer.concat([Buffer.from('h264'), size(), config, packet(9000000, 32), packet(9033333), packet(9066666)])
    for (const byte of wire) stream.push(Buffer.from([byte]))
    expect(formats).toEqual([{ width: 560, height: 1280, codec: 'avc1.640020', epoch: 1 }])
    expect(chunks).toHaveLength(3) // init + keyframe + delta frame
    expect(chunks[0]!.includes(Buffer.from('moov'))).toBe(true)
    for (const fragment of chunks.slice(1)) {
      expect(fragment.subarray(4, 8).toString()).toBe('moof')
      expect(fragment.includes(Buffer.from('mdat'))).toBe(true)
    }
    const key = chunks[1]!, delta = chunks[2]!
    expect(key.readBigUInt64BE(key.indexOf('tfdt') + 8)).toBe(0n)
    expect(delta.readBigUInt64BE(delta.indexOf('tfdt') + 8)).toBe(33333n)
    expect(key.readUInt32BE(key.indexOf('trun') + 24)).toBe(0x02000000)
    expect(delta.readUInt32BE(delta.indexOf('trun') + 24)).toBe(0x01010000)
  })

  it('starts a fresh timestamp origin and init segment when the phone rotates', () => {
    const formats: PhoneVideoFormat[] = [], chunks: Buffer[] = []
    const stream = new ScrcpyMp4Stream({ format: value => formats.push(value), data: data => chunks.push(Buffer.from(data)) })
    stream.push(Buffer.concat([Buffer.from('h264'), size(), config, packet(1000, 32), packet(2000), size(1280, 560), config, packet(9000, 32), packet(10000)]))
    expect(formats.map(f => [f.width, f.height, f.epoch])).toEqual([[560, 1280, 1], [1280, 560, 2]])
    expect(chunks.filter(data => data.includes(Buffer.from('ftyp')))).toHaveLength(2)
    const last = chunks.at(-1)!
    expect(last.readBigUInt64BE(last.indexOf('tfdt') + 8)).toBe(0n)
  })

  it('rejects invalid codecs and oversized packets without buffering their payloads', () => {
    const stream = new ScrcpyMp4Stream({ format() {}, data() {} })
    expect(() => stream.push(Buffer.from('av1 '))).toThrow('H.264')
    const other = new ScrcpyMp4Stream({ format() {}, data() {} })
    const oversized = Buffer.alloc(12); oversized.writeUInt32BE(5 * 1024 * 1024, 8)
    expect(() => other.push(Buffer.concat([Buffer.from('h264'), oversized]))).toThrow('大小')
  })
})
