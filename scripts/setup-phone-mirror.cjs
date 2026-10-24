#!/usr/bin/env node
// Install only the pinned Android server. Video encoding runs on the phone.
const { createHash } = require('node:crypto')
const { mkdir, readFile, writeFile, rename } = require('node:fs/promises')
const { homedir } = require('node:os')
const { join } = require('node:path')
const VERSION = '5.0.1'
const SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536'

async function main() {
  const path = process.env.VENUS_SCRCPY_SERVER || join(homedir(), '.local', 'share', 'codexapp', 'scrcpy', VERSION, 'server.jar')
  const valid = bytes => createHash('sha256').update(bytes).digest('hex') === SHA256
  try { if (valid(await readFile(path))) { console.log('Phone mirror ready:', path); return } } catch {}
  const response = await fetch(`https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`)
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!valid(bytes)) throw new Error('scrcpy server checksum mismatch')
  await mkdir(require('node:path').dirname(path), { recursive: true })
  await writeFile(path + '.tmp', bytes, { mode: 0o600 }); await rename(path + '.tmp', path)
  console.log('Phone mirror ready:', path)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
