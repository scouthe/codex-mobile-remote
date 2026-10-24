import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { PhoneAdbInput, validatePhoneInput } from './adbInput.js'

const paths: string[] = []
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'phone-input-')); paths.push(root)
  const log = join(root, 'commands.jsonl'), adb = join(root, 'adb.cjs')
  await writeFile(adb, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.includes('dumpsys')) console.log('Viewport INTERNAL: displayId=0, orientation=0, logicalFrame=[0, 0, 1220, 2712]');
if(args.includes('settings')) console.log('com.android.adbkeyboard/.AdbIME');
`, { mode: 0o755 })
  return { input: new PhoneAdbInput(adb, 'phone-test'), commands: async () => (await readFile(log, 'utf8')).trim().split('\n').map(row => JSON.parse(row) as string[]) }
}

describe('manual ADB input', () => {
  it('maps normalized coordinates to current logical display pixels', async () => {
    const { input, commands } = await setup()
    await input.execute({ type: 'tap', point: { x: 0.5, y: 0.25 }, epoch: 2 }, { width: 560, height: 1280, epoch: 2, codec: 'avc1.640020' })
    expect((await commands()).at(-1)).toEqual(['-s', 'phone-test', 'shell', 'input', 'tap', '610', '678'])
  })
  it('passes arbitrary Chinese text as base64 without shell interpolation', async () => {
    const { input, commands } = await setup()
    const text = '你好，手机！ " $() `literal` ; &\n第二行'
    await input.execute({ type: 'text', text })
    const args = (await commands()).at(-1)!
    expect(args.slice(-6, -1)).toEqual(['broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg'])
    expect(Buffer.from(args.at(-1)!, 'base64').toString('utf8')).toBe(text)
  })
  it('rejects stale rotations, invalid points and unknown keys before issuing actions', async () => {
    const { input } = await setup()
    await expect(input.execute({ type: 'tap', point: { x: 0.5, y: 0.5 }, epoch: 1 }, { width: 560, height: 1280, epoch: 2, codec: 'avc1.640020' })).rejects.toMatchObject({ status: 409 })
    await expect(input.execute({ type: 'tap', point: { x: 0.5, y: 0.5 }, epoch: 2 }, { width: 1280, height: 560, epoch: 2, codec: 'avc1.640020' })).rejects.toMatchObject({ status: 409 })
    for (const value of [{ type: 'tap', point: { x: -1, y: 0 }, epoch: 1 }, { type: 'key', key: 'constructor' }, { type: 'shell', command: 'echo bad' }, { type: 'text', text: '' }]) {
      expect(() => validatePhoneInput(value)).toThrow()
    }
  })
})
