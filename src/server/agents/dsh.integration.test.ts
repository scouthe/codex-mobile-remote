import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentManager } from './agentManager.js'
import { AgentSessionStore } from './sessionStore.js'

it.skipIf(!process.env.CODEXUI_TEST_DSH)('connects to installed DSH, creates, closes and resumes its native session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-real-dsh-'))
  let manager = new AgentManager(new AgentSessionStore(join(directory, 'display')))
  try {
    const detail = await manager.create(directory)
    expect(detail.session.nativeId).toBeTruthy()
    expect(detail.configOptions.some(option => option.category === 'model')).toBe(true)
    expect((await manager.list())[0]?.id).toBe(detail.session.id)
    await manager.dispose()
    manager = new AgentManager(new AgentSessionStore(join(directory, 'display')))
    const resumed = await manager.activate(detail.session.id)
    expect(resumed.session.nativeId).toBe(detail.session.nativeId)
    expect(resumed.configOptions.length).toBeGreaterThan(0)
    console.log('DSH ACP verified:', { models: resumed.configOptions.find(option => option.category === 'model')?.options.map(option => option.label), optionCategories: resumed.configOptions.map(option => option.category), imageInput: resumed.imagesSupported })
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 90_000)
