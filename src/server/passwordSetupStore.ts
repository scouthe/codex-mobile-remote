import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type WebPasswordResolution = {
  password: string | undefined
  setupRequired: boolean
  source: 'disabled' | 'explicit' | 'stored' | 'skipped' | 'setup'
}

export function resolveWebPassword(input: string | boolean, codexHome: string): WebPasswordResolution {
  if (input === false) return { password: undefined, setupRequired: false, source: 'disabled' }
  if (typeof input === 'string') return { password: input, setupRequired: false, source: 'explicit' }

  const passwordPath = join(codexHome, 'codexui-password')
  if (existsSync(passwordPath)) {
    const password = readFileSync(passwordPath, 'utf8').replace(/[\r\n]+$/u, '')
    if (password) return { password, setupRequired: false, source: 'stored' }
  }

  const skippedPath = join(codexHome, 'codexui-password-skipped')
  if (existsSync(skippedPath)) return { password: undefined, setupRequired: false, source: 'skipped' }
  return { password: undefined, setupRequired: true, source: 'setup' }
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

export async function persistWebPassword(password: string, codexHome: string): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  await writePrivateFile(join(codexHome, 'codexui-password'), `${password}\n`)
  await rm(join(codexHome, 'codexui-password-skipped'), { force: true })
}

export async function persistWebPasswordSkip(codexHome: string): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 })
  await writePrivateFile(join(codexHome, 'codexui-password-skipped'), 'lan-only\n')
  await rm(join(codexHome, 'codexui-password'), { force: true })
}
