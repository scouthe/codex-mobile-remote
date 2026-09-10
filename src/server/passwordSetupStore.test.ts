import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { persistWebPassword, persistWebPasswordSkip, resolveWebPassword } from './passwordSetupStore.js'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('web password startup choice', () => {
  it('requires first-run setup when the user has not made a choice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-password-setup-'))
    tempDirectories.push(root)

    expect(resolveWebPassword(true, root)).toEqual({
      password: undefined,
      setupRequired: true,
      source: 'setup',
    })
  })

  it('persists and reuses the user password across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-password-stored-'))
    tempDirectories.push(root)

    await persistWebPassword('correct-horse-battery', root)

    expect(resolveWebPassword(true, root)).toEqual({
      password: 'correct-horse-battery',
      setupRequired: false,
      source: 'stored',
    })
    expect((await stat(join(root, 'codexui-password'))).mode & 0o777).toBe(0o600)
  })

  it('persists the LAN-only choice without creating a password', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-password-skipped-'))
    tempDirectories.push(root)

    await persistWebPasswordSkip(root)

    expect(resolveWebPassword(true, root)).toEqual({
      password: undefined,
      setupRequired: false,
      source: 'skipped',
    })
    expect((await stat(join(root, 'codexui-password-skipped'))).mode & 0o777).toBe(0o600)
  })
})
