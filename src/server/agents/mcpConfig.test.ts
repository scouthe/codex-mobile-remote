import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { readDshMcpServers } from './mcpConfig.js'

it('reads standard ACP MCP declarations while keeping validation errors free of credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-mcp-config-'))
  try {
    expect(await readDshMcpServers(directory)).toEqual([])
    const mcpServers = [
      { name: 'stdio', command: '/usr/bin/node', args: ['server.cjs'], env: [{ name: 'TEST_KEY', value: 'fixture-secret' }] },
      { name: 'http', type: 'http', url: 'https://mcp.example/api', headers: [{ name: 'Authorization', value: 'Bearer fixture-secret' }] },
    ]
    await writeFile(join(directory, 'dsh.json'), JSON.stringify({ profile: 'test-acp', mcpServers }))
    expect(await readDshMcpServers(directory)).toEqual(mcpServers)
    for (const invalid of [
      [...mcpServers, mcpServers[0]],
      [{ name: 'bad', type: 'http', url: 'file:///fixture-secret', headers: [] }],
      [{ name: 'bad', command: 'relative/fixture-secret', args: [], env: [] }],
    ]) {
      await writeFile(join(directory, 'dsh.json'), JSON.stringify({ mcpServers: invalid }))
      let message = ''
      try { await readDshMcpServers(directory) } catch (error) { message = (error as Error).message }
      expect(message).toContain('MCP 配置无效')
      expect(message).not.toContain('fixture-secret')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
