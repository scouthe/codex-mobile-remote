import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PhoneAgentManager } from './phoneAgent.js'
import { PhoneAgentError, phoneBody as body, phoneJson as json } from './phoneHttp.js'
import { PhoneControlManager } from './phoneControl/manager.js'
import { handlePhoneControl } from './phoneControl/routes.js'

export function createPhoneAgentMiddleware(manager = new PhoneAgentManager(), control = new PhoneControlManager(manager)) {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (!url.pathname.startsWith('/phone-agent-api/')) return next()
    void (async () => {
      if (url.pathname.startsWith('/phone-agent-api/control/')) return handlePhoneControl(req, res, url, control)
      if (req.method === 'GET' && url.pathname === '/phone-agent-api/state') return json(res, 200, { ...await manager.state(), control: control.state() })
      if (req.method === 'POST' && url.pathname === '/phone-agent-api/runs') return json(res, 201, { run: await manager.start(await body(req)) })
      const match = /^\/phone-agent-api\/runs\/([\da-f-]+)(\/stop|\/screenshot)?$/.exec(url.pathname)
      if (match && req.method === 'POST' && match[2] === '/stop') return json(res, 200, { run: await manager.stop(match[1]!) })
      if (match && req.method === 'GET' && !match[2]) return json(res, 200, await manager.detail(match[1]!, Math.max(0, Number(url.searchParams.get('after')) || 0)))
      let path = ''
      if (match && req.method === 'GET' && match[2] === '/screenshot') path = await manager.screenshot(match[1]!)
      if (req.method === 'GET' && url.pathname === '/phone-agent-api/screen') path = await manager.capture(url.searchParams.get('deviceId') || '')
      if (path) {
        const stream = createReadStream(path)
        stream.once('error', () => { if (!res.headersSent) json(res, 404, { error: '截图不存在。' }); else res.destroy() })
        res.setHeader('Content-Type', path.endsWith('.jpg') ? 'image/jpeg' : 'image/png')
        res.setHeader('Cache-Control', 'private, no-store')
        stream.pipe(res)
        return
      }
      json(res, 404, { error: '接口不存在。' })
    })().catch(error => { if (!res.headersSent) json(res, error instanceof PhoneAgentError ? error.status : 500, { error: error instanceof Error ? error.message : '请求失败。' }) })
  }
  middleware.dispose = () => { control.dispose(); manager.dispose() }
  return middleware
}
