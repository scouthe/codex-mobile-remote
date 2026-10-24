import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhoneAgentManager } from './phoneAgent.js'
import { createPhoneAgentMiddleware } from './phoneAgentMiddleware.js'
import { createAuthSession } from './authMiddleware.js'
import express from 'express'
import { PhoneControlManager } from './phoneControl/manager.js'

const writeFailure = vi.hoisted(() => ({ request: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn(async (...args: any[]) => {
      if (writeFailure.request && String(args[0]).endsWith('/request.json')) {
        throw new Error('simulated request persistence failure')
      }
      return actual.writeFile(...args as Parameters<typeof actual.writeFile>)
    }),
  }
})

const directories: string[] = []
const managers: PhoneAgentManager[] = []
const servers: Server[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'venus-agent-test-'))
  directories.push(root)
  await mkdir(join(root, 'deployment'))
  await writeFile(join(root, 'deployment', 'run_mobile.py'), '')
  const adb = join(root, 'adb.cjs')
  await writeFile(adb, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='devices') console.log('List of devices attached\\nphone-test device model:Redmi_K60_Ultra');
else if(args.includes('getprop')) console.log('Redmi K60 Ultra');
else if(args.includes('settings')) console.log('com.android.adbkeyboard/.AdbIME');
else if(args.includes('screencap')) process.stdout.write(Buffer.from('screenshot'));
`, { mode: 0o755 })
  const runner = join(root, 'worker.cjs')
  await writeFile(runner, `const fs=require('node:fs'),path=require('node:path');
const dir=process.argv[process.argv.indexOf('--run-dir')+1];
const input=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8'));
const send=(event)=>console.log(JSON.stringify(event));
send({type:'status',message:'model ready',status:'running'});
fs.writeFileSync(path.join(dir,'preview-1.jpg'),'preview');
send({type:'screen',message:'screen',step:1,screenshot:'preview-1.jpg'});
send({type:'action',message:'查看设置',step:1,action:{action_type:'CLK'}});
process.on('SIGTERM',()=>{send({type:'result',message:'stopped',status:'stopped'});process.exit(0)});
setTimeout(()=>{send({type:'result',message:input.purpose,status:'succeeded'});process.exit(0)},input.purpose==='slow'?10000:80);
`)
  const options = { root, stateDir: join(root, 'state'), runner, python: process.execPath, adb }
  const manager = new PhoneAgentManager(options)
  managers.push(manager)
  return { manager, options, root }
}

afterEach(async () => {
  writeFailure.request = false
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve())
  })))
  managers.splice(0).forEach(manager => manager.dispose())
  await new Promise(resolve => setTimeout(resolve, 100))
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('local phone agent task lifecycle', () => {
  it('discovers the phone without starting a model or task', async () => {
    const { manager } = await fixture()
    const state = await manager.state()
    expect(state.available).toBe(true)
    expect(state.runs).toEqual([])
    expect(state.devices).toEqual([{ id: 'phone-test', model: 'Redmi K60 Ultra', state: 'device', keyboardReady: true }])
  })

  it('rejects simultaneous submissions before async discovery completes', async () => {
    const { manager } = await fixture()
    const results = await Promise.allSettled([manager.start({ purpose: 'slow' }), manager.start({ purpose: 'slow' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason.status).toBe(409)
  })

  it('streams cursor deltas, keeps screenshots out of JSON, and restores history', async () => {
    const { manager, options } = await fixture()
    const purpose = '查看设置；保留引号 " $() `literal`'
    const run = await manager.start({ purpose, stepLimit: 8 })
    await vi.waitFor(async () => expect((await manager.detail(run.id)).run.status).toBe('succeeded'))
    const detail = await manager.detail(run.id)
    expect(detail.events.some(event => event.type === 'action')).toBe(true)
    expect((await manager.detail(run.id, detail.cursor)).events).toEqual([])
    expect(detail.run.message).toBe(purpose)
    expect(await readFile(await manager.screenshot(run.id), 'utf8')).toBe('preview')
    expect(JSON.stringify(detail)).not.toContain('data:image')
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(options.stateDir, run.id + '.json'), 'utf8')).status).toBe('succeeded'))
    const restored = new PhoneAgentManager(options)
    managers.push(restored)
    expect((await restored.state()).runs[0]?.message).toBe(purpose)
  })

  it('stops the worker and releases the active task slot', async () => {
    const { manager } = await fixture()
    const run = await manager.start({ purpose: 'slow' })
    await vi.waitFor(async () => expect((await manager.detail(run.id)).run.step).toBe(1))
    expect((await manager.stop(run.id)).status).toBe('stopping')
    await vi.waitFor(async () => expect((await manager.detail(run.id)).run.status).toBe('stopped'))
    expect(await manager.start({ purpose: 'next' })).toHaveProperty('id')
  })

  it('waits for the Agent to exit, reserves control across browsers, and releases explicitly', async () => {
    const { manager } = await fixture()
    const run = await manager.start({ purpose: 'slow' })
    await vi.waitFor(async () => expect((await manager.detail(run.id)).run.step).toBe(1))
    const lease = await manager.claimManual()
    expect((await manager.detail(run.id)).run.status).toBe('stopped')
    expect(lease.previousRun?.id).toBe(run.id)
    await expect(manager.claimManual()).rejects.toMatchObject({ status: 409 })
    await expect(manager.start({ purpose: 'competing task' })).rejects.toMatchObject({ status: 409 })
    lease.release()
    expect(await manager.start({ purpose: 'next' })).toHaveProperty('id')
  })

  it('can take over while Agent startup is still discovering the phone', async () => {
    const { manager } = await fixture()
    const starting = manager.start({ purpose: 'slow' })
    const claiming = manager.claimManual()
    const [started, claimed] = await Promise.allSettled([starting, claiming])
    expect(started.status).toBe('rejected')
    expect(claimed.status).toBe('fulfilled')
    if (claimed.status === 'fulfilled') claimed.value.release()
    expect(await manager.start({ purpose: 'next' })).toHaveProperty('id')
  })

  it('serializes manual input and waits for input and encoder cleanup before handback', async () => {
    const { manager } = await fixture()
    const first = await manager.start({ purpose: 'slow' })
    await vi.waitFor(async () => expect((await manager.detail(first.id)).run.step).toBe(1))
    let finishInput!: () => void, finishMirror!: () => void
    const inputDone = new Promise<void>(resolve => { finishInput = resolve })
    const mirrorDone = new Promise<void>(resolve => { finishMirror = resolve })
    const stopMirror = vi.fn(() => mirrorDone)
    const execute = vi.fn(() => inputDone)
    const control = new PhoneControlManager(manager, {
      available: () => true,
      mirror: () => ({ start: async () => {}, stop: stopMirror, format: { width: 560, height: 1280, epoch: 1, codec: 'avc1.640020' } }),
      input: () => ({ execute }),
    })
    const session = await control.acquire({ deviceId: 'phone-test' })
    expect(session.previousRunId).toBe(first.id)
    await expect(control.acquire({ deviceId: 'phone-test' })).rejects.toMatchObject({ status: 409 })
    await control.stream(session.id, { format() {}, data() {}, error() {}, close() {} })
    const action = control.input(session.id, { type: 'key', key: 'home' })
    await expect(control.input(session.id, { type: 'key', key: 'back' })).rejects.toMatchObject({ status: 409 })
    const resuming = control.resume({ sessionId: session.id, previousRunId: first.id, deviceId: 'phone-test', note: '弹窗已处理' })
    await vi.waitFor(() => expect(stopMirror).toHaveBeenCalledOnce())
    finishMirror()
    await expect(manager.start({ purpose: 'too early' })).rejects.toMatchObject({ status: 409 })
    finishInput(); await action
    const resumed = await resuming
    expect(execute).toHaveBeenCalledOnce()
    expect(resumed.purpose).toContain('弹窗已处理')
    expect(resumed.purpose).toContain('请先查看当前屏幕')
    expect(control.state().busy).toBe(false)
    control.dispose()
  })

  it('expires a disconnected manual lease without restarting the Agent', async () => {
    const { manager } = await fixture()
    const stop = vi.fn(async () => {})
    const control = new PhoneControlManager(manager, { available: () => true, leaseMs: 60,
      mirror: () => ({ start: async () => {}, stop, format: undefined }) })
    const session = await control.acquire({ deviceId: 'phone-test' })
    await control.stream(session.id, { format() {}, data() {}, error() {}, close() {} })
    await vi.waitFor(() => expect(control.state().busy).toBe(false))
    expect(stop).toHaveBeenCalledOnce()
    expect((await manager.state()).runs).toHaveLength(0)
    await expect(control.input(session.id, { type: 'key', key: 'home' })).rejects.toMatchObject({ status: 409 })
    control.dispose()
  })

  it('allows only wake before the first video frame, so a sleeping phone can be reached', async () => {
    const { manager } = await fixture()
    const execute = vi.fn(async () => {})
    const control = new PhoneControlManager(manager, { available: () => true,
      input: () => ({ execute }), mirror: () => ({ start: async () => {}, stop: async () => {}, format: undefined }) })
    const session = await control.acquire({ deviceId: 'phone-test' })
    await control.stream(session.id, { format() {}, data() {}, error() {}, close() {} })
    await control.input(session.id, { type: 'key', key: 'wake' })
    expect(execute).toHaveBeenCalledExactlyOnceWith({ type: 'key', key: 'wake' }, undefined)
    await expect(control.input(session.id, { type: 'key', key: 'home' })).rejects.toMatchObject({ status: 409 })
    await control.release(session.id); control.dispose()
  })

  it('maps sleep to the Android power key while keeping the manual lease active', async () => {
    const { manager } = await fixture()
    const execute = vi.fn(async () => {})
    const control = new PhoneControlManager(manager, {
      available: () => true,
      input: () => ({ execute }),
      mirror: () => ({ start: async () => {}, stop: async () => {}, format: { width: 560, height: 1280, epoch: 1, codec: 'avc1.640020' } }),
    })
    const session = await control.acquire({ deviceId: 'phone-test' })
    await control.stream(session.id, { format() {}, data() {}, error() {}, close() {} })
    await control.input(session.id, { type: 'key', key: 'sleep' })
    expect(execute).toHaveBeenCalledExactlyOnceWith({ type: 'key', key: 'sleep' }, { width: 560, height: 1280, epoch: 1, codec: 'avc1.640020' })
    expect(control.state().busy).toBe(true)
    await control.release(session.id); control.dispose()
  })

  it('releases the encoder on HTTP stream disconnect and rejects a second stream', async () => {
    const { manager } = await fixture()
    const stop = vi.fn(async () => {})
    const control = new PhoneControlManager(manager, { available: () => true, mirror: output => ({
      start: async () => { output.format({ width: 560, height: 1280, epoch: 1, codec: 'avc1.640020' }) },
      stop, format: undefined,
    }) })
    const middleware = createPhoneAgentMiddleware(manager, control)
    const server = createServer((req, res) => middleware(req, res, () => res.end())); servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/phone-agent-api/control`
    const acquired = await fetch(base + '/sessions', { method: 'POST', body: JSON.stringify({ deviceId: 'phone-test' }) })
    const { session } = await acquired.json() as { session: { id: string } }
    const abort = new AbortController()
    const stream = await fetch(`${base}/sessions/${session.id}/stream`, { signal: abort.signal })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toBe('application/octet-stream')
    const duplicate = await fetch(`${base}/sessions/${session.id}/stream`)
    expect(duplicate.status).toBe(409)
    expect(control.state().busy).toBe(true)
    abort.abort()
    await vi.waitFor(() => expect(control.state().busy).toBe(false))
    expect(stop).toHaveBeenCalledOnce()
    middleware.dispose()
  })

  it('uses the selected completed task as context for follow-up instructions', async () => {
    const { manager, options } = await fixture()
    const first = await manager.start({ purpose: 'first' })
    await vi.waitFor(async () => expect((await manager.detail(first.id)).run.status).toBe('succeeded'))
    const next = await manager.start({ purpose: '继续查看', previousRunId: first.id })
    const request = JSON.parse(await readFile(join(options.stateDir, next.id, 'request.json'), 'utf8'))
    expect(request.purpose).toContain('上一个任务：first')
    expect(request.purpose).toContain('上一个任务的结果：first')
    expect(request.purpose).toContain('继续查看')
    expect(next.purpose).toBe('继续查看')
  })

  it('rejects empty instructions and excessive step counts without reserving the phone', async () => {
    const { manager } = await fixture()
    await expect(manager.start({ purpose: '' })).rejects.toMatchObject({ status: 400 })
    await expect(manager.start({ purpose: 'test', stepLimit: 51 })).rejects.toMatchObject({ status: 400 })
    expect((await manager.state()).runs).toHaveLength(0)
  })

  it('records a failed terminal state when request persistence fails after reservation', async () => {
    const { manager } = await fixture()
    writeFailure.request = true

    await expect(manager.start({ purpose: 'persist failure' })).rejects.toThrow('simulated request persistence failure')

    const state = await manager.state()
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]).toMatchObject({ status: 'failed', message: 'Agent 启动失败：simulated request persistence failure' })
  })

  it('preserves Chinese instructions split across HTTP byte chunks and rejects invalid JSON', async () => {
    const { manager } = await fixture()
    const server = createServer((req, res) => createPhoneAgentMiddleware(manager)(req, res, () => res.end()))
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const bytes = Buffer.from(JSON.stringify({ purpose: '查看手机型号' }))
    const cut = Buffer.from('{"purpose":"查').length - 1
    const run = await new Promise<{ purpose: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/phone-agent-api/runs', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve(JSON.parse(body).run))
      })
      req.on('error', reject); req.write(bytes.subarray(0, cut)); setTimeout(() => req.end(bytes.subarray(cut)), 10)
    })
    expect(run.purpose).toBe('查看手机型号')
    const invalid = await fetch(`http://127.0.0.1:${address.port}/phone-agent-api/runs`, { method: 'POST', body: 'null' })
    expect(invalid.status).toBe(400)
  })

  it('keeps phone endpoints behind the existing external-host login gate', async () => {
    const { manager } = await fixture()
    const app = express()
    app.use(createAuthSession({ password: 'test-password' }).middleware)
    app.use(createPhoneAgentMiddleware(manager))
    const server = createServer(app); servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    for (const path of ['/phone-agent-api/state', '/phone-agent-api/control/sessions/test/stream']) {
    const response = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, headers: { Host: 'external.example.com' } }, res => {
        let body = ''; res.on('data', chunk => { body += chunk }); res.on('end', () => resolve(body))
      }); req.on('error', reject); req.end()
    })
    expect(response.toLowerCase()).toContain('<!doctype html>')
    expect(response).not.toContain('phone-test')
    }
  })
})
