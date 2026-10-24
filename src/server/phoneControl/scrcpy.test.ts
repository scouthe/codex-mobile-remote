import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { PhoneMirror } from './scrcpy.js'

it('removes an ADB forward that finishes being created after startup was cancelled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phone-mirror-cancel-'))
  const adb = join(root, 'adb.cjs'), jar = join(root, 'server.jar'), log = join(root, 'log.jsonl')
  await writeFile(jar, 'fixture')
  await writeFile(adb, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.includes('tcp:0')) setTimeout(()=>console.log('12345'),200);
`, { mode: 0o755 })
  const mirror = new PhoneMirror({ adb, server: jar, deviceId: 'phone-test', format() {}, data() {}, ended() {} })
  try {
    const starting = mirror.start().catch(error => error)
    await vi.waitFor(async () => expect(await readFile(log, 'utf8')).toContain('tcp:0'))
    await mirror.stop()
    expect((await starting).message).toContain('关闭')
    const commands = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(commands.some(args => args.includes('--remove') && args.includes('tcp:12345'))).toBe(true)
    expect(commands.some(args => args.includes('app_process'))).toBe(false)
    expect(commands.some(args => args.includes('rm'))).toBe(true)
  } finally { await mirror.stop(); await rm(root, { recursive: true, force: true }) }
})
