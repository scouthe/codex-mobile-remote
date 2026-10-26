const { chromium, expect } = require('@playwright/test')
const fs = require('node:fs/promises')
const base = process.env.DSH_TEST_BASE || 'http://127.0.0.1:4173'
const firstId = '00000000-0000-5000-a000-000000000071'
const nextId = '00000000-0000-5000-a000-000000000072'
const capabilities = { listSessions: true, resumeSession: true, closeSession: true, loadSession: false, image: true, mcpHttp: true, mcpSse: false }
const session = (id, nativeId) => ({ id, nativeId, agentId: 'dsh', title: `原生对话 · ${nativeId}`, cwd: '/tmp/native-project', createdAt: '', updatedAt: '', state: 'idle', error: '', runId: '', lastRequestId: '', revision: 0, archived: false, source: 'native', historyUnavailable: true })

async function main() {
  await fs.mkdir('output/playwright', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const results = []
  try {
    for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: theme })
      const page = await context.newPage()
      const calls = [], errors = []
      const first = session(firstId, 'old-web-one'), second = session(nextId, 'old-web-two')
      const detail = { session: first, messages: [], configOptions: [{ id: 'model', name: '模型', category: 'model', currentValue: 'deepseek', options: [{ value: 'deepseek', label: 'DeepSeek' }] }], permissions: [], imagesSupported: true, nextCursor: null, attached: false }
      let listFailure = false, holdList = false, releaseOldList
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(theme => {
        localStorage.setItem('codex-web-local.dark-mode.v1', theme)
        window.EventSource = class {
          readyState = 1
          listeners = new Map()
          constructor() { window.__nativeStream = this; setTimeout(() => this.emit('ready', {}), 0) }
          addEventListener(name, callback) { this.listeners.set(name, callback) }
          emit(name, value) { this.listeners.get(name)?.({ data: JSON.stringify(value) }) }
          close() { this.readyState = 2 }
        }
      }, theme)
      await page.route('**/agent-api/**', async route => {
        const request = route.request(), url = new URL(request.url())
        calls.push({ method: request.method(), path: url.pathname, cursor: url.searchParams.get('cursor') })
        let result
        if (url.pathname.endsWith('/status')) result = { available: true, connected: true, message: '', imagesSupported: true, capabilities }
        else if (url.pathname.endsWith('/directories')) result = { path: '/tmp', parent: '/', directories: [] }
        else if (url.pathname === '/agent-api/sessions') {
          result = { sessions: url.searchParams.has('cursor') ? [second, second] : [first], nextCursor: url.searchParams.has('cursor') ? null : 'next-native-page', capabilities, warning: listFailure ? '原生会话列表读取失败：测试中断' : '' }
          if (holdList) {
            holdList = false
            result.nextCursor = 'stale-page'
            await new Promise(resolve => { releaseOldList = resolve })
          }
        } else if (url.pathname.endsWith('/activate')) { detail.attached = true; detail.session = { ...detail.session, revision: detail.session.revision + 1 }; result = detail }
        else if (url.pathname.endsWith('/close')) { detail.attached = false; detail.session = { ...detail.session, revision: detail.session.revision + 1 }; result = detail }
        else result = detail
        await route.fulfill({ json: result })
      })
      const openSidebar = async () => {
        if (viewport.width < 768) await page.locator('.content-header .sidebar-thread-controls-button').first().click()
      }
      try {
        await page.goto(base + '/#/dsh')
        await page.waitForLoadState('networkidle')
        await openSidebar()
        await expect(page.getByRole('button', { name: /^原生对话 · old-web-one/ })).toBeVisible()
        expect(calls.filter(call => call.path.endsWith('/activate'))).toHaveLength(0)
        expect(calls.filter(call => call.path === '/agent-api/sessions' && call.method === 'GET')).toHaveLength(1)
        await page.getByRole('button', { name: '加载更多原生对话', exact: true }).click()
        await expect(page.getByRole('button', { name: /^原生对话 · old-web-two/ })).toHaveCount(1)
        await expect(page.getByRole('button', { name: '加载更多原生对话', exact: true })).toHaveCount(0)
        await page.getByRole('button', { name: /^原生对话 · old-web-one/ }).click()
        await expect(page.getByText(/旧消息暂不支持回放/)).toBeVisible()
        await expect(page.getByText('No messages in this thread yet.', { exact: true })).toHaveCount(0)
        await expect(page.getByRole('textbox', { name: '向 DSH 发送消息' })).toHaveCount(0)
        expect(calls.filter(call => call.path.endsWith('/activate'))).toHaveLength(0)
        await page.getByRole('button', { name: '恢复原生会话', exact: true }).click()
        await expect(page.getByRole('textbox', { name: '向 DSH 发送消息' })).toBeVisible()
        expect(calls.filter(call => call.path.endsWith('/activate'))).toHaveLength(1)
        detail.session = { ...detail.session, revision: detail.session.revision + 1, usage: { used: 1200, size: 128000 } }
        await page.evaluate(session => window.__nativeStream.emit('update', { session }), detail.session)
        await expect(page.locator('.agent-context-usage')).toContainText('1,200 / 128,000')
        await page.getByRole('button', { name: '更多 DSH 操作', exact: true }).click()
        await page.getByRole('button', { name: '释放会话连接', exact: true }).click()
        await expect(page.getByRole('button', { name: '恢复原生会话', exact: true })).toBeVisible()
        await expect(page.getByRole('textbox', { name: '向 DSH 发送消息' })).toHaveCount(0)
        await page.reload()
        await expect(page.getByText(/旧消息暂不支持回放/)).toBeVisible()
        expect(calls.filter(call => /\/(prompt|archive)$/.test(call.path))).toHaveLength(0)
        // A delayed response from the old stream must not roll back pagination.
        holdList = true
        await page.evaluate(() => window.__nativeStream.emit('ready', {}))
        await expect.poll(() => typeof releaseOldList).toBe('function')
        await page.evaluate(() => window.__nativeStream.emit('ready', {}))
        await expect.poll(() => calls.filter(call => call.path === '/agent-api/sessions').length).toBeGreaterThanOrEqual(5)
        releaseOldList()
        await page.waitForTimeout(150)
        await openSidebar()
        await page.getByRole('button', { name: '加载更多原生对话', exact: true }).click()
        expect(calls.filter(call => call.cursor).at(-1).cursor).toBe('next-native-page')
        if (viewport.width < 768) await page.getByRole('button', { name: /^原生对话 · old-web-one/ }).click()
        listFailure = true
        await page.getByRole('button', { name: '更多 DSH 操作', exact: true }).click()
        await page.getByRole('button', { name: '刷新状态', exact: true }).click()
        await expect(page.getByText('原生会话列表读取失败：测试中断', { exact: false })).toBeVisible()
        listFailure = false
        await page.getByRole('button', { name: '重试读取列表', exact: true }).click()
        await expect(page.getByRole('button', { name: '重试读取列表', exact: true })).toHaveCount(0)
        await openSidebar()
        await expect(page.getByRole('button', { name: /^原生对话 · old-web-one/ })).toBeVisible()
        await page.getByRole('button', { name: '加载更多原生对话', exact: true }).click()
        await expect(page.getByRole('button', { name: /^原生对话 · old-web-two/ })).toHaveCount(1)
        if (viewport.width < 768) await page.getByRole('button', { name: /^原生对话 · old-web-one/ }).click()
        const appearance = await page.locator('.agent-workspace').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, overflow: document.documentElement.scrollWidth > innerWidth + 1 }))
        expect(appearance.overflow).toBe(false)
        expect(appearance.background).toBe(theme === 'dark' ? 'rgb(24, 24, 27)' : 'rgb(255, 255, 255)')
        expect(errors).toEqual([])
        await page.waitForTimeout(2200)
        const screenshot = `output/playwright/dsh-native-${viewport.width}-${theme}.png`
        await page.screenshot({ path: screenshot, fullPage: true })
        results.push({ viewport, theme, sessionListPages: true, explicitResume: true, closeKeepsHistory: true, usage: true, reconnectListRace: true, warningRetry: true, modelRequests: 0, screenshot })
      } finally { releaseOldList?.(); await context.close() }
    }
    await fs.writeFile('output/playwright/dsh-native-results.json', JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exit(1) })
