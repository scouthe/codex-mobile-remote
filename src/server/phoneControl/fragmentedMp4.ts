/** Minimal ISO BMFF for one AVC video track. Append-only, one sample per fragment. */
const u16 = (value: number) => { const data = Buffer.alloc(2); data.writeUInt16BE(value); return data }
const u32 = (value: number) => { const data = Buffer.alloc(4); data.writeUInt32BE(value); return data }
const u64 = (value: number) => { const data = Buffer.alloc(8); data.writeBigUInt64BE(BigInt(value)); return data }
const zeros = (size: number) => Buffer.alloc(size)
const text = (value: string) => Buffer.from(value, 'ascii')
const full = (version = 0, flags = 0) => u32((version << 24) | flags)
const box = (name: string, ...parts: Buffer[]) => Buffer.concat([u32(8 + parts.reduce((size, part) => size + part.length, 0)), text(name), ...parts])
const matrix = Buffer.concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)])
const TIMESCALE = 1000000 // scrcpy's microsecond presentation timestamps

export function mp4Initialization(width: number, height: number, avcC: Buffer): Buffer {
  const ftyp = box('ftyp', text('isom'), u32(0x200), text('isomiso6avc1mp41'))
  const mvhd = box('mvhd', full(), zeros(8), u32(TIMESCALE), u32(0), u32(0x10000), u16(0x100), zeros(10), matrix, zeros(24), u32(2))
  const tkhd = box('tkhd', full(0, 7), zeros(8), u32(1), zeros(16), zeros(8), matrix, u32(width * 65536), u32(height * 65536))
  const mdhd = box('mdhd', full(), zeros(8), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0))
  const hdlr = box('hdlr', full(), u32(0), text('vide'), zeros(12), text('Phone video\0'))
  const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x480000), u32(0x480000),
    u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff), box('avcC', avcC))
  const stbl = box('stbl', box('stsd', full(), u32(1), avc1), box('stts', full(), u32(0)),
    box('stsc', full(), u32(0)), box('stsz', full(), zeros(8)), box('stco', full(), u32(0)))
  const dinf = box('dinf', box('dref', full(), u32(1), box('url ', full(0, 1))))
  const minf = box('minf', box('vmhd', full(0, 1), zeros(8)), dinf, stbl)
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf))
  const mvex = box('mvex', box('trex', full(), u32(1), u32(1), zeros(12)))
  return Buffer.concat([ftyp, box('moov', mvhd, trak, mvex)])
}

export function mp4Fragment(sequence: number, sample: { data: Buffer; timestamp: number; duration: number; key: boolean }): Buffer {
  const moof = (offset: number) => box('moof', box('mfhd', full(), u32(sequence)), box('traf',
    box('tfhd', full(0, 0x020000), u32(1)),
    box('tfdt', full(1), u64(sample.timestamp)),
    box('trun', full(0, 0x000701), u32(1), u32(offset), u32(sample.duration), u32(sample.data.length), u32(sample.key ? 0x02000000 : 0x01010000))))
  const header = moof(0)
  return Buffer.concat([moof(header.length + 8), box('mdat', sample.data)])
}
