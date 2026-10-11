import { spawnSync, type SpawnOptions } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleReviewRoutes, invalidateReviewReads } from './reviewGit.js'

const commands = vi.hoisted(() => ({
  rows: [] as Array<{ args: string[]; cwd: string | undefined }>,
  activeDiffs: 0,
  peakDiffs: 0,
  closeGate: null as null | ((args: string[]) => Promise<void> | null),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
      const child = actual.spawn(command, args, options)
      const argv = [...args]
      commands.rows.push({ args: [...argv], cwd: options?.cwd?.toString() })
      if (argv.includes('--no-index')) {
        commands.activeDiffs += 1
        commands.peakDiffs = Math.max(commands.peakDiffs, commands.activeDiffs)
        child.once('close', () => { commands.activeDiffs -= 1 })
      }
      const closeGate = commands.closeGate
      if (closeGate) {
        const emit = child.emit.bind(child)
        child.emit = ((event, ...values) => {
          if (event === 'close') {
            const gate = closeGate(argv)
            if (gate) {
              void gate.then(() => emit(event, ...values))
              return true
            }
          }
          return emit(event, ...values)
        }) as typeof child.emit
      }
      return child
    },
  }
})

const directories: string[] = []

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-review-git-test-'))
  directories.push(cwd)
  git(cwd, 'init', '-b', 'main')
  git(cwd, 'config', 'user.email', 'review-test@example.invalid')
  git(cwd, 'config', 'user.name', 'Review Test')
  await writeFile(join(cwd, 'tracked.txt'), 'original\n')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-m', 'Initial fixture')
  return cwd
}

type ResponsePayload = {
  data?: {
    scope?: string
    workspaceView?: string
    baseBranch?: string
    commitSha?: string
    summary?: { fileCount: number; addedLineCount: number; removedLineCount: number }
    files?: Array<{ path: string; diff: string }>
    fileCount?: number
    addedLineCount?: number
  }
  error?: string
}

async function request(
  route: 'summary' | 'snapshot' | 'action' | 'git/init',
  query: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; payload: ResponsePayload }> {
  let payload: ResponsePayload = {}
  const res = {
    statusCode: 0,
    setHeader() {},
    end(raw: string) { payload = JSON.parse(raw) as ResponsePayload },
  }
  const handled = await handleReviewRoutes(
    { method: body === undefined ? 'GET' : 'POST' } as IncomingMessage,
    res as unknown as ServerResponse,
    new URL(`/codex-api/review/${route}?${new URLSearchParams(query)}`, 'http://localhost'),
    { readJsonBody: async () => body },
  )
  expect(handled).toBe(true)
  return { status: res.statusCode, payload }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  commands.rows = []
  commands.activeDiffs = 0
  commands.peakDiffs = 0
  commands.closeGate = null
  invalidateReviewReads()
})

afterEach(async () => {
  commands.closeGate = null
  invalidateReviewReads()
  await Promise.all(directories.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })))
})

describe('review Git read workload', () => {
  it('shares duplicate snapshots and bounds all untracked diff children while preserving every patch', async () => {
    const repositories = await Promise.all([repository(), repository()])
    const paths = Array.from({ length: 12 }, (_, index) => `new-${String(index).padStart(2, '0')}.txt`)
    await Promise.all(repositories.flatMap((cwd) => paths.map((path) => writeFile(join(cwd, path), `${path}\nsecond line\n`))))

    const responses = await Promise.all(repositories.flatMap((cwd) => (
      Array.from({ length: 5 }, () => request('snapshot', { cwd }))
    )))

    for (const response of responses) {
      expect(response.status).toBe(200)
      expect(response.payload.data?.summary).toEqual({ fileCount: 12, addedLineCount: 24, removedLineCount: 0 })
      expect(response.payload.data?.files?.map((file) => file.path)).toEqual(paths)
      for (const file of response.payload.data?.files ?? []) {
        expect(file.diff).toContain(`+${file.path}\n+second line`)
      }
    }
    expect(commands.rows.filter(({ args }) => args.includes('--no-index'))).toHaveLength(24)
    expect(commands.rows.filter(({ args }) => args[0] === 'rev-parse' && args[1] === '--show-toplevel')).toHaveLength(2)
    expect(commands.peakDiffs).toBeLessThanOrEqual(4)
    expect(commands.peakDiffs).toBeGreaterThan(1)
    expect(commands.activeDiffs).toBe(0)
    console.info(`[review perf] 10 snapshot requests, 2 repositories, 24 untracked files: 24 diff children, peak ${commands.peakDiffs}`)
  })

  it('shares concurrent summaries but immediately reads subsequent external edits', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'tracked.txt'), 'original\nfirst change\n')
    const responses = await Promise.all(Array.from({ length: 10 }, () => request('summary', { cwd })))
    expect(responses.every((response) => response.status === 200 && response.payload.data?.addedLineCount === 1)).toBe(true)
    expect(commands.rows.filter(({ args }) => args.includes('--numstat'))).toHaveLength(1)
    await writeFile(join(cwd, 'tracked.txt'), 'original\nfirst change\nsecond change\n')
    expect((await request('summary', { cwd })).payload.data?.addedLineCount).toBe(2)
    expect(commands.rows.filter(({ args }) => args.includes('--numstat'))).toHaveLength(2)
    console.info('[review perf] 10 simultaneous summaries: 1 numstat command; the next request reads an external edit immediately')
  })

  it('keeps cwd, scope, staged view, base branch and commit separate', async () => {
    const cwd = await repository()
    const initial = git(cwd, 'rev-parse', 'HEAD')
    git(cwd, 'branch', 'base')
    await writeFile(join(cwd, 'committed.txt'), 'committed\n')
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-m', 'Second fixture commit')
    const current = git(cwd, 'rev-parse', 'HEAD')
    await writeFile(join(cwd, 'tracked.txt'), 'original\nstaged\n')
    git(cwd, 'add', 'tracked.txt')
    await writeFile(join(cwd, 'tracked.txt'), 'original\nstaged\nunstaged\n')
    const otherCwd = await repository()
    const responses = await Promise.all([
      request('snapshot', { cwd, workspaceView: 'unstaged' }),
      request('snapshot', { cwd, workspaceView: 'staged' }),
      request('snapshot', { cwd, scope: 'baseBranch', baseBranch: 'base' }),
      request('snapshot', { cwd, scope: 'baseBranch', baseBranch: 'main' }),
      request('snapshot', { cwd, scope: 'commit', commitSha: initial }),
      request('snapshot', { cwd, scope: 'commit', commitSha: current }),
      request('snapshot', { cwd: otherCwd }),
    ])
    expect(responses.map((response) => response.status)).toEqual(Array(7).fill(200))
    expect(responses[0]?.payload.data?.files?.[0]?.diff).toContain('+unstaged')
    expect(responses[1]?.payload.data?.files?.[0]?.diff).toContain('+staged')
    expect(responses[1]?.payload.data?.files?.[0]?.diff).not.toContain('+unstaged')
    expect(responses[2]?.payload.data?.files?.map((file) => file.path)).toEqual(['committed.txt'])
    expect(responses[3]?.payload.data?.files).toEqual([])
    expect(responses[4]?.payload.data?.commitSha).toBe(initial)
    expect(responses[5]?.payload.data?.commitSha).toBe(current)
    expect(responses[6]?.payload.data?.files).toEqual([])
    expect(commands.rows.filter(({ args }) => args[0] === 'rev-parse' && args[1] === '--show-toplevel')).toHaveLength(7)
  })

  it('does not join a pre-stage read and keeps its replacement registered when the old read finishes', async () => {
    const cwd = await repository()
    await writeFile(join(cwd, 'tracked.txt'), 'original\nchange\n')
    const firstGate = deferred()
    const secondGate = deferred()
    const firstStarted = deferred()
    const secondStarted = deferred()
    let numstats = 0
    commands.closeGate = (args) => {
      if (!args.includes('--numstat')) return null
      numstats += 1
      if (numstats === 1) { firstStarted.resolve(); return firstGate.promise }
      if (numstats === 2) { secondStarted.resolve(); return secondGate.promise }
      return null
    }
    const oldRead = request('summary', { cwd })
    try {
      await firstStarted.promise
      const action = await request('action', {}, { cwd, action: 'stage', level: 'all' })
      expect(action.status).toBe(200)
      const freshRead = request('summary', { cwd })
      await secondStarted.promise
      firstGate.resolve()
      await oldRead
      const duplicateFreshRead = request('summary', { cwd })
      secondGate.resolve()
      const responses = await Promise.all([freshRead, duplicateFreshRead])
      expect(responses.every((response) => response.status === 200 && response.payload.data?.fileCount === 0)).toBe(true)
      expect(numstats).toBe(2)
      expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('tracked.txt')
    } finally {
      firstGate.resolve()
      secondGate.resolve()
      await oldRead
    }
  })

  it('does not retain a failed request after the repository is repaired', async () => {
    const cwd = await repository()
    const failed = await request('snapshot', { cwd, scope: 'commit', commitSha: 'missing-ref' })
    expect(failed.status).toBe(500)
    git(cwd, 'branch', 'missing-ref')
    const repaired = await request('snapshot', { cwd, scope: 'commit', commitSha: 'missing-ref' })
    expect(repaired.status).toBe(200)
    expect(repaired.payload.data?.files?.map((file) => file.path)).toEqual(['tracked.txt'])
  })
})
