const { chromium, expect } = require('@playwright/test')
const fs = require('node:fs/promises')
const base = process.env.DSH_TEST_BASE || 'http://127.0.0.1:4173'

async function main() {
  await fs.mkdir('output/playwright', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const results = []
  try {
    for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: theme })
      const page = await context.newPage(), errors = [], calls = [], sockets = []
      async function switchTool(value) {
        const picker = page.locator('.content-header .workspace-tool-compact')
        await picker.locator('.composer-dropdown-trigger').click()
        await picker.locator('.composer-dropdown-option', { hasText: value }).click()
      }
      await page.addInitScript(theme => localStorage.setItem('codex-web-local.dark-mode.v1', theme), theme)
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        const url = new URL(request.url())
        if (/^\/(agent-api|dsh-api)\//.test(url.pathname)) calls.push(url.pathname)
        expect(url.port).not.toBe('8080')
        expect(url.searchParams.has('token')).toBe(false)
      })
      page.on('websocket', socket => {
        if (!new URL(socket.url()).pathname.startsWith('/dsh/')) return
        const row = { path: new URL(socket.url()).pathname, closed: false }
        sockets.push(row); socket.on('close', () => { row.closed = true })
      })
      try {
        const started = Date.now()
        await page.goto(base + '/#/dsh')
        await expect(page.locator('.dsh-frame')).toBeVisible()
        const frame = page.frameLocator('.dsh-frame')
        await expect(frame.locator('textarea,[contenteditable="true"]').first()).toBeVisible({ timeout: 45000 })
        const nativeFrame = await (await page.locator('.dsh-frame').elementHandle()).contentFrame()
        expect(await nativeFrame.title()).toBe('DeepSeek Harness')
        await expect.poll(() => sockets.some(row => row.path === '/dsh/api/remote.mux')).toBe(true)
        const readyMs = Date.now() - started
        await expect(page.locator('.agent-sidebar,.agent-composer,.desktop-sidebar,.dsh-toolbar')).toHaveCount(0)
        expect(calls.filter(path => path.startsWith('/agent-api/'))).toHaveLength(0)
        expect(calls.filter(path => path === '/dsh-api/status')).toHaveLength(1)
        const outer = await page.locator('.dsh-native-workspace').evaluate(element => {
          const canvas = document.createElement('canvas'), context = canvas.getContext('2d')
          context.fillStyle = getComputedStyle(element.querySelector('.content-header')).backgroundColor
          context.fillRect(0, 0, 1, 1)
          return {
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          frame: element.querySelector('iframe').getBoundingClientRect().height,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          headerColor: [...context.getImageData(0, 0, 1, 1).data],
          }
        })
        expect(outer.width).toBe(viewport.width)
        expect(outer.frame).toBeGreaterThan(viewport.height - 120)
        expect(outer.overflow).toBe(false)
        if (theme === 'dark') expect(Math.max(...outer.headerColor.slice(0, 3))).toBeLessThan(64)
        else expect(Math.min(...outer.headerColor.slice(0, 3))).toBeGreaterThan(240)
        await page.getByRole('button', { name: '更多 DSH 操作', exact: true }).click()
        await expect(page.getByRole('link', { name: '独立打开 ↗', exact: true })).toHaveAttribute('href', '/dsh/')
        await page.getByRole('button', { name: '更多 DSH 操作', exact: true }).click()
        await page.waitForTimeout(2200)
        const screenshot = `output/playwright/dsh-embedded-${viewport.width}-${theme}.png`
        await page.screenshot({ path: screenshot, fullPage: true })
        if (viewport.width === 1280 && theme === 'light') {
          await page.getByRole('button', { name: '更多 DSH 操作', exact: true }).click()
          await page.getByRole('button', { name: '重新加载', exact: true }).click()
          await expect(frame.locator('textarea,[contenteditable="true"]').first()).toBeVisible({ timeout: 45000 })
          expect(calls.filter(path => path === '/dsh-api/status')).toHaveLength(2)
          await page.goto(base + '/#/dsh/session/00000000-0000-4000-a000-000000000071')
          await expect(page).toHaveURL(/#\/dsh$/)
          await page.goto(base + '/#/dsh/native')
          await expect(page).toHaveURL(/#\/dsh$/)
        }
        expect(errors).toEqual([])
        await switchTool('Codex')
        await expect(page.locator('.dsh-frame')).toHaveCount(0)
        await expect.poll(() => sockets.every(row => row.closed), { timeout: 10000 }).toBe(true)
        expect(calls.filter(path => path.startsWith('/agent-api/'))).toHaveLength(0)
        results.push({ url: base + '/#/dsh', viewport, theme, readyMs, acpRequests: 0, outer, socketsClosedOnLeave: true, modelPrompts: 0, errors, screenshot })
      } finally { await context.close() }
    }
    // Explicit offline/retry fixture. It does not contact or modify the native engine.
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
    let attempts = 0
    await page.route('**/dsh-api/status', route => route.fulfill({ json: ++attempts === 1 ? { available: false, message: '测试服务离线' } : { available: true, message: '' } }))
    await page.route('**/dsh/', route => route.fulfill({ contentType: 'text/html', body: '<textarea aria-label="原生输入框"></textarea>' }))
    await page.goto(base + '/#/dsh')
    await expect(page.getByRole('alert')).toContainText('测试服务离线')
    await expect(page.locator('.dsh-frame')).toHaveCount(0)
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.frameLocator('.dsh-frame').getByRole('textbox', { name: '原生输入框' })).toBeVisible()
    expect(attempts).toBe(2)
    await page.close()
    await fs.writeFile('output/playwright/dsh-embedded-results.json', JSON.stringify({ results, unavailableRetry: true }, null, 2))
    console.log(JSON.stringify({ results, unavailableRetry: true }, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exit(1) })
