import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function worker() {
  type Event = { request: { method: string; url: string; mode: string; destination: string }; respondWith: ReturnType<typeof vi.fn> }
  const handlers = new Map<string, (event: Event) => void>()
  const cache = { put: vi.fn(), match: vi.fn() }
  const open = vi.fn(async () => cache)
  const fetch = vi.fn(async () => new Response('<title>Codex Remote</title>'))
  runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
    self: { location: { origin: 'http://localhost' }, addEventListener: (name: string, handler: (event: Event) => void) => handlers.set(name, handler) },
    caches: { open }, fetch, URL, Response,
  })
  function dispatch(path: string, destination = 'document') {
    const respondWith = vi.fn()
    handlers.get('fetch')!({ request: { method: 'GET', url: 'http://localhost' + path, mode: destination === 'document' ? 'navigate' : 'cors', destination }, respondWith })
    return respondWith
  }
  return { cache, open, fetch, dispatch }
}

describe('application shell cache ownership', () => {
  it('leaves DSH navigation to the network without replacing the Codex shell', () => {
    const { cache, open, dispatch } = worker()
    expect(dispatch('/dsh/')).not.toHaveBeenCalled()
    expect(dispatch('/dsh')).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('does not cache DSH plugin resources or intercept its status API', () => {
    const { open, dispatch } = worker()
    expect(dispatch('/dsh/plugins/??example/client.js&rev=abc', 'script')).not.toHaveBeenCalled()
    expect(dispatch('/dsh-api/status', '')).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps normal Codex navigation in the outer application cache', async () => {
    const { cache, fetch, dispatch } = worker()
    const respondWith = dispatch('/')
    expect(respondWith).toHaveBeenCalledOnce()
    const response = await respondWith.mock.calls[0]![0] as Response
    expect(await response.text()).toContain('Codex Remote')
    expect(fetch).toHaveBeenCalledOnce()
    expect(cache.put).toHaveBeenCalledWith('/', expect.any(Response))
  })
})
