import type { IncomingMessage, ServerResponse } from 'node:http'
import { PHONE_VIDEO_DATA, PHONE_VIDEO_ERROR, PHONE_VIDEO_FORMAT, PHONE_VIDEO_MAX_PACKET } from '../../types/phoneControl.js'
import { PhoneAgentError, phoneBody, phoneJson } from '../phoneHttp.js'
import type { PhoneControlManager } from './manager.js'

/** Kept inside the existing authenticated phone middleware; no public media port. */
export async function handlePhoneControl(req: IncomingMessage, res: ServerResponse, url: URL, manager: PhoneControlManager): Promise<void> {
  const path = url.pathname.slice('/phone-agent-api/control/'.length)
  if (path === 'sessions' && req.method === 'POST') {
    const controller = new AbortController()
    const cancel = () => { if (!res.writableEnded) controller.abort() }
    res.once('close', cancel)
    try { phoneJson(res, 201, { session: await manager.acquire(await phoneBody(req), controller.signal) }) }
    finally { res.off('close', cancel) }
    return
  }
  if (path === 'resume' && req.method === 'POST') return phoneJson(res, 201, { run: await manager.resume(await phoneBody(req)) })
  const match = /^sessions\/([\da-f-]+)\/(stream|input|heartbeat|release)$/.exec(path)
  if (!match) return phoneJson(res, 404, { error: '接口不存在。' })
  const id = match[1]!, action = match[2]!
  if (req.method === 'POST') {
    if (action === 'input') await manager.input(id, await phoneBody(req))
    else if (action === 'heartbeat') manager.heartbeat(id)
    else if (action === 'release') await manager.release(id)
    else throw new PhoneAgentError('不支持此操作。', 405)
    return phoneJson(res, 200, { ok: true })
  }
  if (req.method !== 'GET' || action !== 'stream') return phoneJson(res, 405, { error: '不支持此操作。' })
  const disconnected = () => { void manager.release(id) }
  res.once('close', disconnected)
  const packet = (kind: number, value: Uint8Array) => {
    if (res.destroyed || res.writableEnded) return
    if (value.length > PHONE_VIDEO_MAX_PACKET || res.writableLength > 1024 * 1024) {
      res.destroy(); void manager.release(id); return
    }
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' })
      res.flushHeaders()
    }
    const header = Buffer.alloc(5); header[0] = kind; header.writeUInt32BE(value.length, 1)
    res.write(header); res.write(value)
  }
  try {
    await manager.stream(id, {
      format: format => packet(PHONE_VIDEO_FORMAT, Buffer.from(JSON.stringify(format))),
      data: data => packet(PHONE_VIDEO_DATA, data),
      error: error => packet(PHONE_VIDEO_ERROR, Buffer.from(error.message)),
      close: () => { if (!res.destroyed) res.end() },
    })
  } catch (error) {
    res.off('close', disconnected)
    if (res.headersSent) { packet(PHONE_VIDEO_ERROR, Buffer.from(error instanceof Error ? error.message : '投屏失败。')); res.end() }
    else throw error
  }
}
