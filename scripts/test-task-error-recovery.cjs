const { chromium, expect } = require('@playwright/test')
const fs = require('node:fs/promises')

const base = process.env.TASK_ERROR_TEST_BASE || 'http://127.0.0.1:4173'
const id = '00000000-0000-4000-a000-000000000031'
const cwd = '/tmp/task-error-recovery-fixture'

async function main() {
  await fs.mkdir('output/playwright', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const results = []
  try {
    for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport, colorScheme: theme })
        const page = await context.newPage()
        const errors = [], calls = []
        let phase = 'initial', revision = 1
        const failure = 'HTTP 401: authentication failed (test fixture)'
        function snapshot() {
          const failed = phase === 'interrupted' || phase === 'failed'
          const running = phase === 'running'
          const turnId = phase === 'initial' ? 'initial-turn' : phase === 'interrupted' ? 'old-turn' : 'new-turn'
          const error = failed ? phase === 'interrupted' ? 'interrupted' : failure : null
          const state = failed ? 'failed' : running ? 'running' : 'completed'
          const turn = {
            id: turnId, status: phase === 'failed' ? 'failed' : running ? 'inProgress' : 'completed',
            error: phase === 'failed' ? { message: failure } : null,
            items: [
              { id: 'user-' + turnId, type: 'userMessage', content: [{ type: 'text', text: '你好' }] },
              { id: 'answer-' + turnId, type: 'agentMessage', phase: 'final_answer', text: '你好，在的。TASK_ERROR_RECOVERY' },
            ],
          }
          const thread = {
            id, name: '状态恢复验收', cwd, preview: '你好', modelProvider: 'openai',
            createdAt: 1792947000, updatedAt: 1792947000 + revision,
            status: { type: running ? 'active' : 'idle' }, turns: [turn],
            sessionActivityKnown: true, sessionRevision: 'revision-' + revision,
            taskState: state, taskError: error || '', terminalState: running ? '' : state,
            terminalError: error || '', terminalTurnId: running ? '' : turnId,
          }
          return {
            thread, conversationState: { turns: [turn] }, partial: true, hasMoreOlder: false,
            threadTurnStartIndex: 0, threadTurnStartIndexKnown: true, fullHydrationDeferred: true,
            sessionActivityKnown: true, sessionRevision: thread.sessionRevision,
            inProgress: running, isInProgress: running, taskState: state,
            activeTurnId: running ? turnId : '', terminalTurnId: running ? '' : turnId,
            currentActivity: { kind: failed ? 'error' : running ? 'thinking' : 'idle', label: failed ? 'Task failed' : running ? 'Thinking' : 'Completed', details: error ? [error] : [] },
            error, queueDepth: 0, activeRequest: null, writerClient: null, liveStateError: null,
            streamCursor: { streamEpoch: 'recovery-fixture', latestSeq: revision, oldestSeq: 1 }, timeline: [],
          }
        }
        page.on('pageerror', error => errors.push(error.message))
        await page.addInitScript(() => {
          const NativeWebSocket = window.WebSocket
          window.WebSocket = class {
            static OPEN = 1
            static CLOSED = 3
            readyState = 1
            constructor(url, protocols) {
              if (!String(url).includes('/codex-api/ws')) return new NativeWebSocket(url, protocols)
              window.__taskErrorSocket = this
              setTimeout(() => this.onopen?.({}), 0)
            }
            close() { this.readyState = 3 }
            send() {}
          }
        })
        await page.route('**/codex-api/**', async route => {
          const request = route.request(), url = new URL(request.url())
          const body = request.postDataJSON?.()
          calls.push(body?.method || url.pathname)
          let result
          if (url.pathname === '/codex-api/rpc') {
            const method = body?.method
            if (method === 'thread/list') result = { data: [snapshot().thread], nextCursor: null }
            else if (method === 'thread/read') result = snapshot()
            else if (method === 'model/list') result = { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }], defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'] }], nextCursor: null }
            else if (method === 'config/read') result = { config: { model: 'gpt-6.1-sol', model_provider: 'openai' } }
            else if (method === 'thread/goal/get') result = { goal: null }
            else if (method === 'account/rateLimits/read') result = { rateLimits: null }
            else result = { data: [] }
            return route.fulfill({ json: { result } })
          }
          if (/thread-(fast|live)-state/.test(url.pathname)) result = snapshot()
          else if (url.pathname.endsWith('/workspace-roots-state')) result = { data: { order: [cwd], active: [cwd], labels: {}, projectOrder: [cwd] } }
          else if (url.pathname.endsWith('/thread-queue-state')) result = { data: {} }
          else if (url.pathname.endsWith('/requests')) result = { data: [] }
          else if (url.pathname.endsWith('/thread-stream-events')) result = { events: [], cursor: snapshot().streamCursor }
          else if (url.pathname.endsWith('/provider-models')) result = { data: [] }
          else result = { data: [] }
          await route.fulfill({ json: result })
        })
        function emit(value) {
          return page.evaluate(value => window.__taskErrorSocket.onmessage({ data: JSON.stringify(value) }), value)
        }
        async function reconnect(next) {
          phase = next
          revision++
          await emit({ method: 'ready', params: { streamEpoch: 'recovery-fixture', latestSeq: revision } })
        }
        await page.goto(base + '/#/thread/' + id)
        await expect(page.getByText('你好，在的。TASK_ERROR_RECOVERY', { exact: true }).last()).toBeVisible()
        phase = 'interrupted'
        revision++
        await emit({ method: 'error', params: { threadId: id, turnId: 'old-turn', message: 'interrupted', willRetry: false } })
        await expect(page.locator('.live-overlay-error')).toContainText('interrupted')
        await reconnect('completed')
        await expect(page.locator('.live-overlay-inline')).toHaveCount(0)
        await expect(page.getByText('你好，在的。TASK_ERROR_RECOVERY', { exact: true }).last()).toBeVisible()
        await page.reload()
        await expect(page.getByText('你好，在的。TASK_ERROR_RECOVERY', { exact: true }).last()).toBeVisible()
        await expect(page.locator('.live-overlay-inline')).toHaveCount(0)
        await page.waitForTimeout(2200)
        const screenshot = `output/playwright/task-error-recovery-${viewport.width}-${theme}.png`
        await page.screenshot({ path: screenshot, fullPage: true })
        phase = 'interrupted'
        revision++
        await emit({ method: 'error', params: { threadId: id, turnId: 'old-turn', message: 'interrupted', willRetry: false } })
        await expect(page.locator('.live-overlay-error')).toContainText('interrupted')
        await reconnect('running')
        await expect(page.locator('.live-overlay-error')).toHaveCount(0)
        await reconnect('failed')
        await expect(page.getByText(failure, { exact: true }).first()).toBeVisible()
        await page.reload()
        await expect(page.getByText(failure, { exact: true }).first()).toBeVisible()
        await expect(page.locator('.live-overlay-inline')).toHaveCount(0)
        expect(errors).toEqual([])
        expect(calls.filter(call => call === 'turn/start' || call === 'thread/resume')).toEqual([])
        results.push({ viewport, theme, screenshot, recoveredAfterReload: true, realFailurePersisted: true, duplicateLiveOverlayCount: 0, requests: calls.length, modelRequests: 0 })
        await context.close()
      }
    }
    await fs.writeFile('output/playwright/task-error-recovery-results.json', JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exit(1) })
