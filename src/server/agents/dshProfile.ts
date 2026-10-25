import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { parse, stringify } from 'yaml'

export type DshLaunch = { command: string; args: string[]; env: NodeJS.ProcessEnv }
type DshSettings = { command?: string; profile?: string; dshHome?: string; sourceProfile?: string }

export function agentDataHome(): string {
  return process.env.CODEXUI_AGENT_HOME || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'remote-agents')
}

export async function resolveDshSettings(): Promise<Required<DshSettings>> {
  let settings: DshSettings = {}
  try { settings = JSON.parse(await readFile(join(agentDataHome(), 'dsh.json'), 'utf8')) as DshSettings }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('DSH 连接配置无效，请检查 remote-agents/dsh.json。') }
  const profile = settings.profile || 'codex-remote-acp'
  const sourceProfile = settings.sourceProfile || 'web'
  if (settings.command !== undefined && (typeof settings.command !== 'string' || !settings.command.trim())) throw new Error('DSH 启动命令无效。')
  if (settings.dshHome !== undefined && (typeof settings.dshHome !== 'string' || !isAbsolute(settings.dshHome))) throw new Error('DSH 配置目录必须是绝对路径。')
  if (!/^[a-zA-Z0-9_-]+$/.test(profile) || !/^[a-zA-Z0-9_-]+$/.test(sourceProfile) || profile === 'web' || profile === 'desktop') throw new Error('请为 DSH ACP 使用独立的 profile 名称。')
  return { command: settings.command || process.env.CODEXUI_DSH_COMMAND || 'dsh', profile, sourceProfile, dshHome: settings.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh') }
}

export async function dshAvailable(): Promise<boolean> {
  try {
    const { command } = await resolveDshSettings()
    const paths = isAbsolute(command) ? [command] : (process.env.PATH || '').split(delimiter).map(dir => join(dir, command))
    for (const path of paths) { try { await access(path, constants.X_OK); return true } catch { /* try the next PATH entry */ } }
  } catch { /* invalid configuration is reported by connect */ }
  return false
}

/** Create only our profile. The existing Web profile and credentials stay in place. */
export async function prepareDshLaunch(): Promise<DshLaunch> {
  const settings = await resolveDshSettings()
  const dir = join(settings.dshHome, 'profiles', settings.profile)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await access(join(dir, 'package.json'))
  } catch {
    // Reuse model adapter overrides, never copy Web UI/plugin configuration.
    let rows: Array<Record<string, unknown>> = []
    try {
      const value: unknown = parse(await readFile(join(settings.dshHome, 'profiles', settings.sourceProfile, 'cordis.patch.yml'), 'utf8'))
      if (Array.isArray(value)) rows = value.filter(row => row && typeof row === 'object') as Array<Record<string, unknown>>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 DSH 模型配置。可在独立 ACP profile 中手动配置模型。')
    }
    const adapters = rows.filter(row => typeof row.id === 'string' && row.id.startsWith('llm-') && typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/dsh-llm-'))
    const defaults = rows.find(row => row.id === 'agent-default-model')?.config as Record<string, unknown> | undefined
    const acp = { id: 'acp', config: { provider: defaults?.provider || 'deepseek-official', model: defaults?.model || 'deepseek-v4-flash' } }
    await writeFile(join(dir, 'cordis.patch.yml'), stringify([...adapters, acp]), { mode: 0o600, flag: 'wx' }).catch(error => {
      // Recover an interrupted bootstrap without replacing an existing patch.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'codex-remote-dsh-acp', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } },
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await chmod(dir, 0o700)
  }
  return { command: settings.command, args: ['--profile', settings.profile], env: { ...process.env, DSH_HOME: settings.dshHome } }
}
