import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from './httpServer.js'

const servers: Server[] = []
const instances: Array<ReturnType<typeof createServer>> = []
const uploadDirectories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
  instances.splice(0).forEach((instance) => instance.dispose())
  await Promise.all(uploadDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function listen(): Promise<string> {
  const instance = createServer({ password: 'test-password' })
  instances.push(instance)
  const server = createHttpServer(instance.app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not start')
  return `http://127.0.0.1:${address.port}`
}

async function upload(endpoint: string, chunks: Buffer[], chunked = false): Promise<{ status: number; body: string }> {
  const url = new URL(endpoint)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/codex-api/upload-file',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=test-boundary',
        ...(chunked ? {} : { 'Content-Length': chunks.reduce((size, chunk) => size + chunk.length, 0) }),
      },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
    for (const chunk of chunks) request.write(chunk)
    request.end()
  })
}

describe('local file upload limit', () => {
  it('keeps ordinary multipart uploads working', async () => {
    const endpoint = await listen()
    const payload = Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="sample.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--test-boundary--\r\n')
    const response = await upload(endpoint, [payload])
    expect(response.status).toBe(200)
    const filePath = (JSON.parse(response.body) as { path: string }).path
    uploadDirectories.push(dirname(filePath))
    expect(await readFile(filePath, 'utf8')).toBe('hello')
  })

  it('rejects a chunked upload once it exceeds the body limit', async () => {
    const endpoint = await listen()
    const chunk = Buffer.alloc(1024 * 1024, 'a')
    const response = await upload(endpoint, Array.from({ length: 26 }, () => chunk), true)
    expect(response.status).toBe(413)
  })

  it('rejects a declared oversized upload before parsing it', async () => {
    const endpoint = await listen()
    const chunk = Buffer.alloc(1024 * 1024, 'a')
    const response = await upload(endpoint, Array.from({ length: 26 }, () => chunk))
    expect(response.status).toBe(413)
  })
})
