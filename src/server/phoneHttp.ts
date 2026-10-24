import type { IncomingMessage, ServerResponse } from 'node:http'

export class PhoneAgentError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function phoneJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

export async function phoneBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 32768) throw new PhoneAgentError('请求内容过长。', 413)
    chunks.push(buffer)
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('object required')
    return data
  } catch { throw new PhoneAgentError('请求格式不正确。') }
}
