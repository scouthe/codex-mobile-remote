const { chromium, expect } = require('@playwright/test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

async function main() {
  const base = process.env.PROFILE_BASE_URL || 'http://127.0.0.1:4173'
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsh-ui-'))
  await fs.mkdir('output/playwright', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.url().includes('/agent-api/') || request.url().includes('/codex-api/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname }) })
  let sessionId
  try {
    await page.goto(base + '/#/dsh')
    await expect(page.getByRole('heading', { name: '用 DSH 开始开发' })).toBeVisible()
    await expect(page.getByRole('button', { name: '创建 DSH 对话', exact: true })).toBeEnabled()
    const initialRequests = requests.slice()
    if (initialRequests.some(row => row.path.includes('/codex-api/rpc'))) throw new Error('DSH boot unexpectedly initializes Codex')
    await page.getByRole('button', { name: '浏览目录', exact: true }).click()
    await page.getByRole('textbox', { name: '项目绝对路径' }).fill(project)
    await page.getByRole('button', { name: '前往', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '项目绝对路径' })).toHaveValue(project)
    await page.getByRole('button', { name: '使用此目录' }).click()
    await page.getByRole('button', { name: '创建 DSH 对话', exact: true }).click()
    await page.waitForURL(/#\/dsh\/session\/[a-f0-9-]+$/)
    sessionId = page.url().split('/').at(-1)
    const input = page.getByRole('textbox', { name: '向 DSH 发送消息' })
    await expect(input).toBeVisible()
    await expect(page.locator('.agent-thread-row')).toHaveCount(1)
    const snapshot = await page.request.get(`${base}/agent-api/sessions/${sessionId}`).then(response => response.json())
    console.log('Created DSH session', { id: sessionId, options: snapshot.configOptions.map(option => ({ name: option.name, values: option.options.map(value => value.label) })), imagesSupported: snapshot.imagesSupported })
    for (const [index, option] of snapshot.configOptions.entries()) {
      const alternative = option.options.find(value => value.value !== option.currentValue)
      const original = option.options.find(value => value.value === option.currentValue)
      if (!alternative || !original) continue
      const control = page.locator('.agent-composer-controls .composer-dropdown').nth(index)
      await control.getByRole('button').first().click()
      await control.getByRole('button', { name: alternative.label, exact: true }).click()
      await expect(control.locator('.composer-dropdown-value')).toHaveText(alternative.label)
      await expect(control.getByRole('button').first()).toBeEnabled()
      await control.getByRole('button').first().click()
      await control.getByRole('button', { name: original.label, exact: true }).click()
      await expect(control.locator('.composer-dropdown-value')).toHaveText(original.label)
    }
    if (process.env.DSH_UI_LIVE_PROMPT === '1') {
      await input.fill('这是连接验收。只回复“ACP连接验证通过”，不要调用工具，不要修改文件。')
      await page.getByRole('button', { name: '发送到 DSH', exact: true }).click()
      await expect(page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: 'ACP连接验证通过' }).first()).toBeVisible({ timeout: 150_000 })
      await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 150_000 })
      await page.reload()
      await expect(page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: 'ACP连接验证通过' }).first()).toBeVisible()
      if (snapshot.imagesSupported) {
        const imagePage = await browser.newPage({ viewport: { width: 64, height: 64 } })
        await imagePage.setContent('<style>html,body{margin:0;background:#ef4444;width:100%;height:100%}</style>')
        const imageBuffer = await imagePage.screenshot()
        await imagePage.close()
        await page.locator('input[type=file][accept]').setInputFiles({ name: 'acp-image.png', mimeType: 'image/png', buffer: imageBuffer })
        await expect(page.locator('.agent-attachment img')).toBeVisible()
        await input.fill('这是图片输入验收。如果收到了附图，只回复“图片连接验证通过”。不要调用工具。')
        await page.getByRole('button', { name: '发送到 DSH', exact: true }).click()
        await expect(page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: '图片连接验证通过' }).first()).toBeVisible({ timeout: 150_000 })
        await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 150_000 })
      }
    }
    await input.fill('保留这份 DSH 草稿')
    await page.reload()
    await expect(page.getByRole('textbox', { name: '向 DSH 发送消息' })).toHaveValue('保留这份 DSH 草稿')
    for (const width of [1280, 375, 768]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : width === 768 ? 1024 : 900 })
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { localStorage.setItem('codex-web-local.dark-mode.v1', theme); document.documentElement.classList.toggle('dark', theme === 'dark') }, theme)
        await page.waitForTimeout(2200)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
        if (overflow) throw new Error(`Horizontal overflow at ${width}/${theme}`)
        await expect(page.getByRole('textbox', { name: '向 DSH 发送消息' })).toBeVisible()
        await page.screenshot({ path: `output/playwright/dsh-workspace-${width}-${theme}.png`, fullPage: true })
      }
    }
    await page.setViewportSize({ width: 375, height: 812 })
    await page.locator('.content-leading .sidebar-thread-controls-button').first().click()
    await expect(page.locator('.mobile-drawer .workspace-tool-tabs')).toBeVisible()
    await page.screenshot({ path: 'output/playwright/dsh-mobile-drawer.png', fullPage: true })
    await page.locator('.mobile-drawer .workspace-tool-tabs').getByRole('button', { name: 'Codex', exact: true }).click()
    await page.waitForURL(url => !url.hash.startsWith('#/dsh'))
    await expect(page.locator('.workspace-tool-compact').first()).toBeVisible()
    await page.locator('.workspace-tool-compact').first().getByRole('button', { name: 'DSH', exact: true }).click()
    await page.waitForURL(new RegExp(sessionId))
    await expect(page.getByRole('textbox', { name: '向 DSH 发送消息' })).toHaveValue('保留这份 DSH 草稿')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log(JSON.stringify({ passed: true, sessionId, initialRequests, requestCount: requests.length, errors }, null, 2))
  } finally {
    if (sessionId) await page.request.post(`${base}/agent-api/sessions/${sessionId}/archive`, { data: {} }).catch(() => {})
    await browser.close()
    await fs.rm(project, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exit(1) })
