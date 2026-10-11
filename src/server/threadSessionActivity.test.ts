import { appendFile, mkdtemp, open, readFile, rename, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readThreadSessionActivity, ThreadSessionActivityReader } from './threadSessionActivity.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat), open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) }
})

const temporaryDirectories: string[] = []

beforeEach(() => vi.clearAllMocks())

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

function marker(type: string, turnId: string) {
  return { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, turn_id: turnId } }
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

  it('coalesces concurrent stat and scan work but sees an append on the next read', async () => {
    const path = await makeSession([marker('task_started', 'concurrent-turn')])
    const reader = new ThreadSessionActivityReader()
    const results = await Promise.all(Array.from({ length: 25 }, () => reader.read(path)))
    expect(results.every((activity) => activity.inProgress && activity.turnId === 'concurrent-turn')).toBe(true)
    expect(stat).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(readFile).not.toHaveBeenCalled()

    vi.clearAllMocks()
    await Promise.all(Array.from({ length: 25 }, () => reader.read(path)))
    expect(stat).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()

    await appendFile(path, JSON.stringify(marker('task_complete', 'concurrent-turn')) + '\n')
    vi.clearAllMocks()
    const completed = await Promise.all(Array.from({ length: 25 }, () => reader.read(path)))
    expect(completed.every((activity) => activity.terminalTurnId === 'concurrent-turn' && !activity.inProgress)).toBe(true)
    expect(stat).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not rescan marker-free history after a complete initial scan', async () => {
    const filler = { type: 'response_item', payload: { type: 'reasoning', text: 'x'.repeat(1024) } }
    const path = await makeSession(Array.from({ length: 4300 }, () => filler))
    const reader = new ThreadSessionActivityReader()
    await expect(reader.read(path)).resolves.toMatchObject({ known: false })
    expect(readFile).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 3; index += 1) {
      await appendFile(path, JSON.stringify(filler) + '\n')
      await expect(reader.read(path)).resolves.toMatchObject({ known: false })
    }
    expect(readFile).toHaveBeenCalledTimes(1)
    await appendFile(path, JSON.stringify(marker('task_started', 'first-marker')) + '\n')
    await expect(reader.read(path)).resolves.toMatchObject({ known: true, inProgress: true, turnId: 'first-marker' })
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('replays an incomplete trailing marker from its byte offset, including split UTF-8', async () => {
    const path = await makeSession([marker('task_started', 'partial-turn')])
    const reader = new ThreadSessionActivityReader()
    await reader.read(path)
    const terminal = Buffer.from(JSON.stringify({
      ...marker('task_failed', 'partial-turn'),
      payload: { type: 'task_failed', turn_id: 'partial-turn', error: '暂时 unavailable' },
    }) + '\n')
    const split = terminal.indexOf(Buffer.from('暂')) + 1
    await appendFile(path, terminal.subarray(0, split))
    await expect(reader.read(path)).resolves.toMatchObject({ inProgress: true, turnId: 'partial-turn' })
    await appendFile(path, terminal.subarray(split))
    await expect(reader.read(path)).resolves.toMatchObject({ inProgress: false, terminalState: 'failed', terminalError: '暂时 unavailable' })
  })

  it('waits for a newline even when the trailing JSON object is already valid', async () => {
    const path = await makeSession([marker('task_started', 'newline-turn')])
    const reader = new ThreadSessionActivityReader()
    await appendFile(path, JSON.stringify(marker('task_complete', 'newline-turn')))
    await expect(reader.read(path)).resolves.toMatchObject({ inProgress: true })
    await appendFile(path, '\n')
    await expect(reader.read(path)).resolves.toMatchObject({ inProgress: false, terminalTurnId: 'newline-turn' })
  })

  it('rescans after truncation and detects a truncate-and-regrow at the previous append boundary', async () => {
    const path = await makeSession([marker('task_started', 'old-turn')])
    const reader = new ThreadSessionActivityReader()
    await reader.read(path)
    await truncate(path, 0)
    await expect(reader.read(path)).resolves.toMatchObject({ known: false })
    await appendFile(path, JSON.stringify(marker('task_started', 'new-turn')) + '\n')
    await expect(reader.read(path)).resolves.toMatchObject({ inProgress: true, turnId: 'new-turn' })

    await writeFile(path, [
      JSON.stringify(marker('task_complete', 'replaced-turn')),
      JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1024) } }),
    ].join('\n') + '\n')
    await expect(reader.read(path)).resolves.toMatchObject({ inProgress: false, terminalTurnId: 'replaced-turn' })
  })

  it('invalidates an atomically replaced file even if its size and mtime are preserved', async () => {
    const original = marker('task_started', 'old-turn')
    const replacement = { ...original, payload: { type: 'task_started', turn_id: 'new-turn' } }
    const path = await makeSession([original])
    const metadata = await stat(path)
    const reader = new ThreadSessionActivityReader()
    const previous = await reader.read(path)
    await writeFile(`${path}.replacement`, JSON.stringify(replacement) + '\n')
    await utimes(`${path}.replacement`, metadata.atime, metadata.mtime)
    await rename(`${path}.replacement`, path)
    const next = await reader.read(path)
    expect(next).toMatchObject({ inProgress: true, turnId: 'new-turn' })
    expect(next.revision).not.toBe(previous.revision)
  })

  it('keeps stale logs unknown and scans them when a current append makes them recent again', async () => {
    const path = await makeSession([marker('task_started', 'stale-turn')])
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(path, oldTime, oldTime)
    const reader = new ThreadSessionActivityReader()
    await expect(reader.read(path)).resolves.toMatchObject({ known: false, inProgress: false })
    expect(open).not.toHaveBeenCalled()
    await appendFile(path, JSON.stringify({ type: 'response_item', payload: { text: 'recent output' } }) + '\n')
    await expect(reader.read(path)).resolves.toMatchObject({ known: true, inProgress: true, turnId: 'stale-turn' })
  })

  it('evicts old activity results while keeping recently read files reusable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-mobile-session-cache-'))
    temporaryDirectories.push(directory)
    const paths = Array.from({ length: 513 }, (_, index) => join(directory, `rollout-${index}.jsonl`))
    await Promise.all(paths.map((path, index) => writeFile(path, JSON.stringify(marker('task_started', `turn-${index}`)) + '\n')))
    const reader = new ThreadSessionActivityReader()
    for (const path of paths) await reader.read(path)
    vi.clearAllMocks()
    await reader.read(paths[512]!)
    expect(open).not.toHaveBeenCalled()
    await reader.read(paths[0]!)
    expect(open).toHaveBeenCalledTimes(1)
  })
})
