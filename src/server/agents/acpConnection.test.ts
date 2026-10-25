import { describe, expect, it } from 'vitest'
import { AcpConnection } from './acpConnection.js'
import type { DshLaunch } from './dshProfile.js'

// A minimal peer intentionally never answers session/new. The official SDK
// still owns all framing and correlation on the production client side.
const peer = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(p.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n')})`
const launch = (): DshLaunch => ({ command: process.execPath, args: ['-e', peer], env: process.env })

describe('official ACP transport lifecycle', () => {
  it('bounds an uncooperative RPC and reports a disconnect only once', async () => {
    let exits = 0
    const connection = new AcpConnection({ update: () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }), exit: () => { exits++ } }, async () => launch())
    try {
      await connection.initialize()
      const start = performance.now()
      await expect(connection.request('session/new', { cwd: '/tmp', mcpServers: [] }, 40)).rejects.toThrow()
      expect(performance.now() - start).toBeLessThan(1000)
      await expect.poll(() => exits).toBe(1)
    } finally { await connection.dispose() }
    expect(exits).toBe(1)
  })

  it('does not spawn a cancelled launch or let its failure close a later connection', async () => {
    let release!: (launch: DshLaunch) => void
    let first = true
    const connection = new AcpConnection({ update: () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }), exit: () => {} }, () => {
      if (first) { first = false; return new Promise(resolve => { release = resolve }) }
      return Promise.resolve(launch())
    })
    try {
      const old = connection.initialize()
      await connection.dispose()
      const current = connection.initialize()
      release(launch())
      await expect(old).rejects.toThrow('已关闭')
      expect((await current).protocolVersion).toBe(1)
    } finally { await connection.dispose() }
  })
})
