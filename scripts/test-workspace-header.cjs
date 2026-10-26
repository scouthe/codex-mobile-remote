const { chromium, expect } = require('@playwright/test')
const fs = require('node:fs/promises')
const base = process.env.HEADER_TEST_BASE || 'http://127.0.0.1:4173'
const id = '00000000-0000-4000-a000-000000000051'
const cwd = '/tmp/workspace-header-fixture'

async function main() {
  await fs.mkdir('output/playwright', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const results = []
  try {
    for (const viewport of [{ width: 320, height: 812 }, { width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport, colorScheme: theme })
        const page = await context.newPage()
        const errors = [], calls = []
        let tool = 'codex'
        const thread = { id, name: 'Codex 顶部布局验收：长标题不应遮挡工具切换或右侧操作', preview: 'Codex 顶部布局验收', cwd, createdAt: 1792983600, updatedAt: 1792983600, modelProvider: 'openai', status: { type: 'idle' }, sessionActivityKnown: true, sessionRevision: 'header-revision', taskState: 'completed', taskError: '', terminalTurnId: 'codex-turn', turns: [{ id: 'codex-turn', status: 'completed', items: [{ id: 'codex-answer', type: 'agentMessage', phase: 'final_answer', text: 'CODEX_HEADER_READY' }] }] }
        page.on('pageerror', error => errors.push(error.message))
        await page.addInitScript(({ theme, id }) => {
          localStorage.setItem('codex-web-local.dark-mode.v1', theme)
          localStorage.setItem('codex-remote.workspace.dsh.last-route', '/dsh/session/' + id)
          window.CodexAndroid = { getClientInfo: () => JSON.stringify({ clientType: 'android', clientId: 'header-fixture', mode: 'observer', version: 'test' }), setTaskState() {}, clearTaskState() {} }
          const NativeWebSocket = window.WebSocket
          window.WebSocket = class {
            static OPEN = 1
            readyState = 1
            constructor(url, protocols) { if (!String(url).includes('/codex-api/ws')) return new NativeWebSocket(url, protocols); setTimeout(() => this.onopen?.({}), 0) }
            close() { this.readyState = 3 }
            send() {}
          }
          window.EventSource = class {
            readyState = 1
            listeners = new Map()
            constructor() { setTimeout(() => this.listeners.get('ready')?.({ data: '{}' }), 10) }
            addEventListener(name, callback) { this.listeners.set(name, callback) }
            close() { this.readyState = 2 }
          }
        }, { theme, id })
        await page.route('**/agent-api/**', async route => {
          const request = route.request(), path = new URL(request.url()).pathname
          calls.push({ tool, method: request.method(), path })
          await route.fulfill({ status: 500, json: { error: 'Native DSH must not call ACP routes' } })
        })
        await page.route('**/dsh-api/status', async route => {
          calls.push({ tool, method: 'GET', path: '/dsh-api/status' })
          await route.fulfill({ json: { available: true, message: '' } })
        })
        await page.route('**/dsh/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>DSH_NATIVE_HEADER_READY</h1><textarea aria-label="原生 DSH 输入框"></textarea>' }))
        await page.route('**/codex-api/**', async route => {
          const request = route.request(), path = new URL(request.url()).pathname
          const body = request.postDataJSON?.()
          calls.push({ tool, method: body?.method || request.method(), path })
          let result = { data: [] }
          if (path.endsWith('/rpc')) {
            if (body?.method === 'thread/list') result = { data: [thread], nextCursor: null }
            else if (body?.method === 'thread/read') result = { thread }
            else if (body?.method === 'model/list') result = { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', isDefault: true, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }], defaultReasoningEffort: 'medium' }], nextCursor: null }
            else if (body?.method === 'config/read') result = { config: { model: 'gpt-6.1-sol', model_provider: 'openai' } }
            else if (body?.method === 'account/rateLimits/read') result = { rateLimits: null }
            else if (body?.method === 'thread/goal/get') result = { goal: null }
            return route.fulfill({ json: { result } })
          }
          if (/thread-(fast|live)-state/.test(path)) result = { thread, conversationState: { turns: thread.turns }, inProgress: false, taskState: 'completed', error: null, currentActivity: { kind: 'idle', label: 'Completed', details: [] }, sessionActivityKnown: true, sessionRevision: 'header-revision', terminalTurnId: 'codex-turn', threadTurnStartIndex: 0, hasMoreOlder: false, partial: true, fullHydrationDeferred: true, queueDepth: 0, activeRequest: null, liveStateError: null, streamCursor: { streamEpoch: 'header-fixture', latestSeq: 0, oldestSeq: null } }
          else if (path.endsWith('/workspace-roots-state')) result = { data: { order: [cwd], active: [cwd], projectOrder: [cwd], labels: {} } }
          else if (path.endsWith('/thread-queue-state')) result = { data: {} }
          else if (path.endsWith('/thread-stream-events')) result = { events: [], cursor: { streamEpoch: 'header-fixture', latestSeq: 0, oldestSeq: null } }
          else if (path.endsWith('/git-worktree-branches')) result = { currentBranch: 'main', branches: [{ value: 'main', label: 'main', isRemote: false }], dirty: false }
          else if (path.endsWith('/thread-terminal/status')) result = { available: true, reason: null }
          await route.fulfill({ json: result })
        })
        const mobile = viewport.width < 768
        async function checkHeader(currentTool) {
          const header = page.locator('.content-header')
          await expect(header.locator('.workspace-tool-compact')).toBeVisible()
          await expect(header.locator('.workspace-tool-compact .composer-dropdown-trigger')).toHaveAttribute('aria-label', currentTool)
          await expect(header.locator('.sidebar-thread-controls-button')).toHaveCount(currentTool === 'Codex' ? 2 : 0)
          await expect(header).toHaveClass(currentTool === 'DSH' && mobile ? /has-center/ : /^(?!.*\bhas-center\b)/)
          await expect(page.locator('.android-observer-badge')).toHaveCount(0)
          const boxes = await header.evaluate(element => {
            const rect = value => { const r = value.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
            const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')
            const color = node => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
            return { header: rect(element), picker: rect(element.querySelector('.workspace-tool-compact')), leading: [...element.querySelectorAll('.sidebar-thread-controls-button')].map(rect), title: rect(element.querySelector('.content-title')), actions: [...element.querySelector('.content-actions').querySelectorAll('button')].filter(button => button.getClientRects().length && button.closest('.header-git-trigger, .composer-dropdown-trigger, .agent-header-button')).map(rect), overflow: document.documentElement.scrollWidth > innerWidth + 1, background: color(element), selectedBackground: color(element.querySelector('.workspace-tool-compact')) }
          })
          expect(boxes.overflow).toBe(false)
          if (mobile) {
            if (currentTool === 'DSH') {
              expect(Math.abs(boxes.picker.x + boxes.picker.width / 2 - (boxes.header.x + boxes.header.width / 2))).toBeLessThan(1)
              for (const action of boxes.actions) expect(action.x).toBeGreaterThanOrEqual(boxes.picker.x + boxes.picker.width - 1)
            } else {
              expect(Math.abs(boxes.picker.y - (boxes.header.y + (boxes.header.height - boxes.picker.height) / 2))).toBeLessThanOrEqual(2)
              expect(boxes.title.y).toBeGreaterThanOrEqual(boxes.header.y)
              expect(boxes.title.y + boxes.title.height).toBeLessThanOrEqual(boxes.header.y + boxes.header.height)
              expect(boxes.title.height).toBeLessThanOrEqual(boxes.picker.height)
            }
          }
          if (theme === 'dark') {
            expect(Math.max(...boxes.background.slice(0, 3))).toBeLessThan(64)
            expect(Math.max(...boxes.selectedBackground.slice(0, 3))).toBeLessThan(128)
          } else expect(Math.min(...boxes.background.slice(0, 3))).toBeGreaterThan(240)
          return boxes.leading
        }
        await page.goto(base + '/#/thread/' + id)
        await expect(page.getByText('CODEX_HEADER_READY', { exact: true })).toBeVisible()
        await checkHeader('Codex')
        await expect(page.locator('.content-header-terminal-command')).toBeVisible()
        await page.locator('.header-git-trigger').click()
        await expect(page.locator('.header-git-menu')).toBeVisible()
        await page.locator('.header-git-trigger').click()
        expect(calls.filter(call => call.path.startsWith('/agent-api/'))).toHaveLength(0)
        await page.waitForTimeout(2200)
        await page.screenshot({ path: `output/playwright/workspace-header-${viewport.width}-${theme}-codex.png`, fullPage: true })
        tool = 'dsh'
        async function switchTool(value) {
          const picker = page.locator('.content-header .workspace-tool-compact')
          await picker.locator('.composer-dropdown-trigger').click()
          await picker.locator('.composer-dropdown-option', { hasText: value }).click()
        }
        await switchTool('DSH')
        await expect(page.frameLocator('.dsh-frame').getByRole('heading', { name: 'DSH_NATIVE_HEADER_READY', exact: true })).toBeVisible()
        await expect(page).toHaveURL(/#\/dsh$/)
        await checkHeader('DSH')
        await expect(page.locator('.desktop-sidebar,.agent-sidebar,.agent-composer')).toHaveCount(0)
        expect(calls.filter(call => call.path.startsWith('/agent-api/'))).toHaveLength(0)
        await page.getByRole('button', { name: '更多 DSH 操作', exact: true }).click()
        await expect(page.getByRole('link', { name: '独立打开 ↗', exact: true })).toHaveAttribute('href', '/dsh/')
        await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible()
        await page.getByRole('button', { name: '更多 DSH 操作', exact: true }).click()
        await page.waitForTimeout(2200)
        await page.screenshot({ path: `output/playwright/workspace-header-${viewport.width}-${theme}-dsh.png`, fullPage: true })
        await switchTool('Codex')
        await expect(page.getByText('CODEX_HEADER_READY', { exact: true })).toBeVisible()
        await switchTool('DSH')
        await expect(page.frameLocator('.dsh-frame').getByRole('heading', { name: 'DSH_NATIVE_HEADER_READY', exact: true })).toBeVisible()
        expect(calls.filter(call => call.method === 'turn/start' || /\/prompt$/.test(call.path) || call.method === 'POST' && call.path === '/agent-api/sessions')).toHaveLength(0)
        expect(errors).toEqual([])
        results.push({ viewport, theme, codexActionsPreserved: true, codexMobileHeaderSingleRow: mobile, dshMobilePickerCentered: mobile, dshNativeEmbedded: true, duplicateSidebar: false, acpRequests: 0, modelRequests: 0, requests: calls.length, pageErrors: 0 })
        await context.close()
      }
    }
    await fs.writeFile('output/playwright/workspace-header-results.json', JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exit(1) })
