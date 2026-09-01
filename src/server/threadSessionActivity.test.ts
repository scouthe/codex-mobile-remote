import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readThreadSessionActivity, ThreadSessionActivityReader } from './threadSessionActivity.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function makeSession(lines: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-session-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'rollout-test.jsonl')
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  return path
}

describe('thread session activity', () => {
  it('reports a session as active after task_started until task_complete', async () => {
    const path = await makeSession([
      { timestamp: '2026-08-31T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { timestamp: '2026-08-31T01:00:05.000Z', type: 'event_msg', payload: { type: 'agent_reasoning' } },
    ])

    await expect(readThreadSessionActivity(path)).resolves.toMatchObject({
      known: true,
      inProgress: true,
      turnId: 'turn-1',
    })
  })

  it('reports a session as idle after a terminal task event', async () => {
    const path = await makeSession([
      { timestamp: '2026-08-31T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { timestamp: '2026-08-31T01:01:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    ])

    await expect(readThreadSessionActivity(path)).resolves.toMatchObject({
      known: true,
      inProgress: false,
      turnId: '',
    })
  })

  it('treats an aborted turn as terminal', async () => {
    const path = await makeSession([
      { timestamp: '2026-08-31T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { timestamp: '2026-08-31T01:00:10.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-1' } },
    ])

    await expect(readThreadSessionActivity(path)).resolves.toMatchObject({
      known: true,
      inProgress: false,
      terminalState: 'canceled',
      terminalTurnId: 'turn-1',
    })
  })

  it('preserves a failed terminal marker and its error for observers', async () => {
    const path = await makeSession([
      { timestamp: '2026-08-31T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      {
        timestamp: '2026-08-31T01:00:10.000Z',
        type: 'event_msg',
        payload: { type: 'task_failed', turn_id: 'turn-1', error: { message: 'provider unavailable' } },
      },
    ])

    await expect(readThreadSessionActivity(path)).resolves.toMatchObject({
      known: true,
      inProgress: false,
      terminalState: 'failed',
      terminalError: 'provider unavailable',
      terminalTurnId: 'turn-1',
    })
  })

  it('treats a task_complete marker with an embedded failure as failed', async () => {
    const path = await makeSession([
      { timestamp: '2026-08-31T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      {
        timestamp: '2026-08-31T01:00:10.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-1', status: 'failed', reason: 'upstream timeout' },
      },
    ])

    await expect(readThreadSessionActivity(path)).resolves.toMatchObject({
      known: true,
      inProgress: false,
      terminalState: 'failed',
      terminalError: 'upstream timeout',
    })
  })

  it('distinguishes an unreadable activity marker from an explicit idle marker', async () => {
    const path = await makeSession([
      { timestamp: '2026-08-31T01:00:00.000Z', type: 'response_item', payload: { type: 'message' } },
    ])

    await expect(readThreadSessionActivity(path)).resolves.toMatchObject({
      known: false,
      inProgress: false,
      turnId: '',
    })
  })

  it('updates a cached revision and clears active state when task_complete is appended', async () => {
    const path = await makeSession([
      { timestamp: '2026-08-31T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    ])
    const reader = new ThreadSessionActivityReader()
    const started = await reader.read(path)
    expect(started).toMatchObject({ known: true, inProgress: true, turnId: 'turn-1' })

    await appendFile(path, JSON.stringify({
      timestamp: '2026-08-31T01:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1' },
    }) + '\n', 'utf8')

    const completed = await reader.read(path)
    expect(completed).toMatchObject({ known: true, inProgress: false, turnId: '' })
    expect(completed.revision).not.toBe(started.revision)
  })

  it('keeps an active marker when verbose output pushes task_started out of the tail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-session-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'rollout-large.jsonl')
    const started = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-large' },
    })
    // Keep this above SESSION_TAIL_BYTES without making the test needlessly
    // large.  The filler is valid JSONL but contains no activity markers.
    const filler = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', text: 'x'.repeat(1024) } })
    await writeFile(path, [started, ...Array.from({ length: 4300 }, () => filler)].join('\n') + '\n', 'utf8')

    const reader = new ThreadSessionActivityReader()
    await expect(reader.read(path)).resolves.toMatchObject({
      known: true,
      inProgress: true,
      turnId: 'turn-large',
    })

    await appendFile(path, `${filler}\n`.repeat(100), 'utf8')
    await expect(reader.read(path)).resolves.toMatchObject({
      known: true,
      inProgress: true,
      turnId: 'turn-large',
    })

    await appendFile(path, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-large' },
    }) + '\n', 'utf8')
    await expect(reader.read(path)).resolves.toMatchObject({ known: true, inProgress: false })
  })
})
