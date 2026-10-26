import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { agentDataHome } from './dshProfile.js'

const name = z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
const entries = z.array(z.object({ name, value: z.string().max(32_000) })).max(200).default([])
const remote = { name, url: z.string().url().max(8192).refine(value => ['http:', 'https:'].includes(new URL(value).protocol)), headers: entries }
const servers = z.array(z.union([
  z.object({ name, command: z.string().max(4096).refine(isAbsolute), args: z.array(z.string().max(8192)).max(200).default([]), env: entries }),
  z.object({ ...remote, type: z.literal('http') }),
  z.object({ ...remote, type: z.literal('sse') }),
])).max(50).refine(rows => new Set(rows.map(row => row.name)).size === rows.length)

/** Host-only standard ACP declarations. Never return MCP credentials to the browser. */
export async function readDshMcpServers(directory = agentDataHome()): Promise<McpServer[]> {
  try {
    const config: unknown = JSON.parse(await readFile(join(directory, 'dsh.json'), 'utf8'))
    const value = z.object({ mcpServers: servers.default([]) }).parse(config)
    return value.mcpServers
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    // Zod/JSON errors may contain headers, environment values or URL credentials.
    throw new Error('DSH MCP 配置无效，请检查 remote-agents/dsh.json 中的 mcpServers。')
  }
}
