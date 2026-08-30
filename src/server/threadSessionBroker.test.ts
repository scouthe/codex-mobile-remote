import { describe, expect, it } from 'vitest'
import { ThreadSessionBroker } from './threadSessionBroker'

describe('ThreadSessionBroker', () => {
  it('serializes writes for the same thread and releases the lock after failure', async () => {
    const broker = new ThreadSessionBroker()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = broker.runExclusive('thread-1', async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
      return 'first'
    })
    const second = broker.runExclusive('thread-1', async () => {
      events.push('second')
      return 'second'
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(events).toEqual(['first:start', 'first:end', 'second'])

    await expect(broker.runExclusive('thread-1', async () => {
      throw new Error('failed write')
    })).rejects.toThrow('failed write')
    await expect(broker.runExclusive('thread-1', async () => 'after failure')).resolves.toBe('after failure')
  })

  it('does not serialize unrelated threads', async () => {
    const broker = new ThreadSessionBroker()
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = broker.runExclusive('thread-a', async () => {
      events.push('a:start')
      await gate
      events.push('a:end')
    })
    const second = broker.runExclusive('thread-b', async () => {
      events.push('b')
    })

    await second
    expect(events).toEqual(['a:start', 'b'])
    release()
    await first
  })

  it('resumes a thread once before serialized turns', async () => {
    const broker = new ThreadSessionBroker()
    const events: string[] = []
    const resume = async () => {
      events.push('resume')
    }
    const start = async (label: string) => {
      events.push(label)
      return label
    }

    await expect(broker.runTurn('thread-1', resume, () => start('first'))).resolves.toBe('first')
    await expect(broker.runTurn('thread-1', resume, () => start('second'))).resolves.toBe('second')
    expect(events).toEqual(['resume', 'first', 'second'])
  })

  it('re-resumes after the app-server generation changes', async () => {
    let generation = 1
    const broker = new ThreadSessionBroker(() => generation)
    let resumeCount = 0

    await broker.runTurn('thread-1', async () => { resumeCount += 1 }, async () => undefined)
    await broker.runTurn('thread-1', async () => { resumeCount += 1 }, async () => undefined)
    generation = 2
    await broker.runTurn('thread-1', async () => { resumeCount += 1 }, async () => undefined)

    expect(resumeCount).toBe(2)
  })
})
