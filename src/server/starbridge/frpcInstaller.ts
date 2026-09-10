import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getStarbridgePaths } from './credentialStore.js'

const execFileAsync = promisify(execFile)
const DEFAULT_FRPC_VERSION = process.env.CODEXUI_FRPC_VERSION?.trim() || '0.71.0'

function architecture(): string {
  if (process.platform !== 'linux') throw new Error('星桥用户端目前仅支持 Linux 主机。')
  if (process.arch === 'x64') return 'amd64'
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'arm') return 'arm'
  throw new Error(`暂不支持当前 Linux 架构：${process.arch}`)
}

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`下载 FRPC 失败（HTTP ${response.status}）`)
  const declaredSize = Number(response.headers.get('content-length') || 0)
  if (declaredSize > maxBytes) throw new Error('FRPC 下载文件大小异常。')
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > maxBytes) throw new Error('FRPC 下载文件大小异常。')
  return body
}

async function checksumMatches(archive: Buffer, checksums: string, fileName: string): Promise<boolean> {
  const line = checksums.split(/\r?\n/u).find((entry) => entry.trim().endsWith(`  ${fileName}`) || entry.trim().endsWith(` *${fileName}`))
  if (!line) throw new Error('FRPC 校验文件中没有匹配当前架构的条目。')
  const expected = line.trim().split(/\s+/u)[0]?.toLowerCase()
  const actual = createHash('sha256').update(archive).digest('hex')
  return Boolean(expected && expected === actual)
}

export async function ensureFrpcInstalled(version = DEFAULT_FRPC_VERSION): Promise<{ path: string; version: string }> {
  const paths = getStarbridgePaths()
  try {
    const existing = await execFileAsync(paths.binary, ['--version'], { timeout: 5_000 })
    if (`${existing.stdout}\n${existing.stderr}`.includes(version)) {
      await chmod(paths.binary, 0o700)
      return { path: paths.binary, version }
    }
  } catch { /* install below */ }

  const arch = architecture()
  const fileName = `frp_${version}_linux_${arch}.tar.gz`
  const configuredBase = process.env.CODEXUI_FRPC_DOWNLOAD_BASE_URL?.trim().replace(/\/$/u, '')
  const baseUrl = configuredBase || `https://github.com/fatedier/frp/releases/download/v${version}`
  if (!/^https:\/\//iu.test(baseUrl)) throw new Error('FRPC 下载镜像必须使用 HTTPS。')
  const [archive, checksums] = await Promise.all([
    download(`${baseUrl}/${fileName}`, 100 * 1024 * 1024),
    download(`${baseUrl}/frp_sha256_checksums.txt`, 1024 * 1024).then((data) => data.toString('utf8')),
  ])
  if (!await checksumMatches(archive, checksums, fileName)) throw new Error('FRPC SHA256 校验失败，已停止安装。')

  const tempRoot = await mkdtemp(join(tmpdir(), 'codexapp-frpc-'))
  const archivePath = join(tempRoot, fileName)
  try {
    await writeFile(archivePath, archive, { mode: 0o600 })
    await execFileAsync('tar', ['-xzf', archivePath, '-C', tempRoot])
    const extracted = join(tempRoot, `frp_${version}_linux_${arch}`, 'frpc')
    await mkdir(dirname(paths.binary), { recursive: true, mode: 0o700 })
    const temporary = `${paths.binary}.tmp-${process.pid}-${Date.now()}`
    const binary = await readFile(extracted)
    await writeFile(temporary, binary, { mode: 0o700 })
    await chmod(temporary, 0o700)
    await rename(temporary, paths.binary)
    await chmod(paths.binary, 0o700)
    return { path: paths.binary, version }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}
