const { chromium, expect } = require('@playwright/test')
const fs = require('node:fs/promises')

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const id = '00000000-0000-4000-a000-000000000001', otherId = '00000000-0000-4000-a000-000000000002'
  const now = new Date().toISOString()
  const session = { id, nativeId: 'native-fixture', agentId: 'dsh', title: 'DSH 交互验收', cwd: '/tmp/acp-ui-fixture', createdAt: now, updatedAt: now, state: 'waiting_approval', error: '', runId: 'turn-2', lastRequestId: '', revision: 10, archived: false }
  const messages = [
    { id: 'user', role: 'user', text: 'TestChat ACP_MARKER：请检查项目。', messageType: 'userMessage', turnId: 'turn-1', turnIndex: 0 },
    { id: 'thought', role: 'assistant', text: '这是应该默认折叠的 DSH 过程说明。', messageType: 'agentMessage', messagePhase: 'commentary', turnId: 'turn-1', turnIndex: 0 },
    { id: 'tool', role: 'system', text: '', messageType: 'commandExecution', turnId: 'turn-1', turnIndex: 0, commandExecution: { command: '读取项目', cwd: '/tmp/acp-ui-fixture', status: 'completed', aggregatedOutput: 'fixture output', exitCode: 0 } },
    { id: 'answer', role: 'assistant', text: '# ACP_MARKER\n\n**最终结果**\n\n[官方项目](https://github.com/deepseek-ai/DeepSeek-Harness)\n\n[本地文件](/tmp/acp-ui-fixture/README.md)', messageType: 'agentMessage', messagePhase: 'final_answer', turnStatus: 'completed', turnId: 'turn-1', turnIndex: 0 },
  ]
  const permission = { id: '00000000-0000-4000-a000-000000000010', sessionId: id, title: '允许写入测试文件？', details: '仅测试当前项目文件。', options: [{ optionId: 'allow-opaque', name: '仅本次允许', kind: 'allow_once' }, { optionId: 'reject-opaque', name: '拒绝', kind: 'reject_once' }] }
  const detail = { session, messages, configOptions: [], permissions: [permission], imagesSupported: false, nextCursor: null }
  const other = { ...detail, session: { ...session, id: otherId, nativeId: 'other', title: '另一条 DSH 对话', state: 'idle' }, messages: [], permissions: [] }
  const submitted = []
  let holdNextDetail = false, releaseStale
  await page.addInitScript(() => {
    window.EventSource = class {
      listeners = new Map()
      constructor() { window.__acpStream = this; setTimeout(() => this.emit('ready', {}), 0) }
      addEventListener(name, callback) { this.listeners.set(name, callback) }
      emit(name, value) { this.listeners.get(name)?.({ data: JSON.stringify(value) }) }
      close() {}
    }
  })
  await page.route('**/agent-api/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (holdNextDetail && request.method() === 'GET' && url.pathname === '/agent-api/sessions/' + id) {
      holdNextDetail = false
      const stale = JSON.parse(JSON.stringify(detail))
      await new Promise(resolve => { releaseStale = resolve })
      await route.fulfill({ json: stale })
      return
    }
    let result
    if (url.pathname.endsWith('/status')) result = { available: true, connected: true, message: '', imagesSupported: false }
    else if (url.pathname.endsWith('/directories')) result = { path: '/tmp', parent: '/', directories: [] }
    else if (url.pathname === '/agent-api/sessions') result = [session, other.session]
    else if (url.pathname.endsWith('/permission')) { submitted.push(request.postDataJSON()); result = { ok: true } }
    else result = url.pathname.includes(otherId) ? other : detail
    await route.fulfill({ json: result })
  })
  try {
    await page.goto('http://127.0.0.1:4173/#/dsh/session/' + id)
    await expect(page.getByRole('heading', { name: 'DSH 交互验收', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: permission.title })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('region', { name: permission.title })).toBeVisible()
    await expect(page.getByText('这是应该默认折叠的 DSH 过程说明。', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Fork thread/ })).toHaveCount(0)
    const link = page.getByRole('link', { name: '官方项目', exact: true })
    const checks = { hrefOk: await link.getAttribute('href') === 'https://github.com/deepseek-ai/DeepSeek-Harness', titleOk: await link.getAttribute('title') === 'https://github.com/deepseek-ai/DeepSeek-Harness', textOk: await page.getByRole('heading', { name: 'ACP_MARKER', exact: true }).isVisible() }
    if (!Object.values(checks).every(Boolean)) throw new Error(JSON.stringify({ ...checks, actual: await link.evaluate(el => el.outerHTML) }))
    await page.getByRole('button', { name: '拒绝', exact: true }).click()
    expect(submitted).toEqual([{ permissionId: permission.id, optionId: 'reject-opaque' }])
    detail.session = { ...session, revision: 11, state: 'completed' }; detail.permissions = []
    await page.evaluate(update => window.__acpStream.emit('update', update), { session: detail.session, permissions: [] })
    await expect(page.getByRole('region', { name: permission.title })).toHaveCount(0)
    await page.getByRole('button', { name: 'Work details', exact: true }).click()
    await expect(page.getByText('这是应该默认折叠的 DSH 过程说明。', { exact: true })).toBeVisible()
    await fs.mkdir('output/playwright', { recursive: true })
    await page.waitForTimeout(2200)
    await page.screenshot({ path: 'output/playwright/testchat-dsh-acp-cjs.png', fullPage: true })
    // A connection gap requests a fresh durable snapshot, without resending a prompt.
    await page.evaluate(() => window.__acpStream.onerror?.())
    await expect(page.getByText(/连接中断，正在重新连接/)).toBeVisible()
    detail.messages.push({ id: 'recovered', role: 'assistant', text: '断线期间已完成的结果', messageType: 'agentMessage', messagePhase: 'final_answer', turnId: 'turn-2', turnIndex: 1 })
    await page.evaluate(() => window.__acpStream.emit('ready', {}))
    await expect(page.getByText('断线期间已完成的结果', { exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: '向 DSH 发送消息' }).fill('第一条会话的草稿')
    await page.getByRole('button', { name: '另一条 DSH 对话', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '向 DSH 发送消息' })).toHaveValue('')
    await page.getByRole('textbox', { name: '向 DSH 发送消息' }).fill('另一条会话的草稿')
    await page.getByRole('button', { name: 'DSH 交互验收', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '向 DSH 发送消息' })).toHaveValue('第一条会话的草稿')
    // Hold a read from the previous connection. Reconnect must start a fresh
    // read, then ignore the older response when it eventually arrives.
    holdNextDetail = true
    await page.getByRole('button', { name: '更多 DSH 操作', exact: true }).click()
    await page.getByRole('button', { name: '刷新状态', exact: true }).click()
    await expect.poll(() => typeof releaseStale).toBe('function')
    for (let index = 0; index < 35; index++) {
      detail.messages.push({ id: `long-user-${index}`, role: 'user', text: `Long question ${index}`, messageType: 'userMessage', turnId: `long-${index}`, turnIndex: index + 2 })
      detail.messages.push({ id: `long-answer-${index}`, role: 'assistant', text: `Long answer ${index}\n\n${'用于验证阅读位置的对话内容。'.repeat(12)}`, messageType: 'agentMessage', messagePhase: 'final_answer', turnId: `long-${index}`, turnIndex: index + 2 })
    }
    detail.session.revision++
    await page.evaluate(() => window.__acpStream.emit('ready', {}))
    await expect(page.getByText(/Long answer 34/).first()).toBeVisible()
    releaseStale()
    await expect(page.getByText(/Long answer 34/).first()).toBeVisible()
    await page.locator('.conversation-list').evaluate(element => { element.scrollTop = 400 })
    await page.waitForTimeout(600)
    const savedTop = await page.locator('.conversation-list').evaluate(element => element.scrollTop)
    await page.getByRole('button', { name: '另一条 DSH 对话', exact: true }).click()
    await expect(page.getByRole('heading', { name: '另一条 DSH 对话', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'DSH 交互验收', exact: true }).click()
    await expect.poll(() => page.locator('.conversation-list').evaluate(element => element.scrollTop)).toBe(savedTop)
    console.log(JSON.stringify({ passed: true, markdown: checks, permissions: submitted, reconnectRestored: true, draftsIsolated: true, readingPositionRestored: savedTop }, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exit(1) })
