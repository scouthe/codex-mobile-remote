const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')

const threadId = process.env.LAYOUT_TEST_THREAD_ID || '01a0534a-677b-7ba3-9223-f13858598491'
const baseUrl = process.env.LAYOUT_TEST_BASE_URL || 'http://127.0.0.1:5900'
const outputDir = path.resolve(process.cwd(), 'output/playwright')
fs.mkdirSync(outputDir, { recursive: true })

async function waitForApp(page) {
  await page.goto(`${baseUrl}/#/thread/${threadId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.locator('.conversation-list').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('.composer-with-queue').waitFor({ state: 'visible', timeout: 10000 })
}

async function verifyViewport(browser, width, height, theme = 'light') {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  await waitForApp(page)
  if (theme === 'dark') {
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await page.waitForTimeout(100)
  }
  const readGeometry = () => page.evaluate(() => {
    const conversation = document.querySelector('.conversation-list')
    const composer = document.querySelector('.composer-with-queue')
    const thread = document.querySelector('.content-thread')
    if (!conversation || !composer || !thread) return null
    const conversationBox = conversation.getBoundingClientRect()
    const composerBox = composer.getBoundingClientRect()
    const threadBox = thread.getBoundingClientRect()
    return {
      conversationBottom: conversationBox.bottom,
      composerTop: composerBox.top,
      threadBottom: threadBox.bottom,
      overlapPx: Math.max(0, conversationBox.bottom - composerBox.top),
      conversationScrollHeight: conversation.scrollHeight,
      conversationClientHeight: conversation.clientHeight,
    }
  })
  const geometry = await readGeometry()
  await page.screenshot({ path: path.join(outputDir, `composer-safe-area-${theme}-${width}x${height}.png`), fullPage: true })
  if (!geometry) throw new Error(`thread conversation/composer not rendered at ${width}x${height}`)
  if (geometry.overlapPx > 1) {
    throw new Error(`conversation overlaps composer by ${geometry.overlapPx.toFixed(1)}px at ${width}x${height}: ${JSON.stringify(geometry)}`)
  }
  const input = page.locator('.thread-composer-input').first()
  if (await input.count() && await input.isEnabled()) {
    await input.fill(Array.from({ length: 20 }, (_, index) => `layout regression line ${index + 1}`).join('\n'))
    await page.waitForTimeout(100)
    const expandedGeometry = await readGeometry()
    if (!expandedGeometry || expandedGeometry.overlapPx > 1) {
      throw new Error(`expanded composer overlaps conversation at ${width}x${height}: ${JSON.stringify(expandedGeometry)}`)
    }
    console.log(`${theme} ${width}x${height}: PASS short+expanded ${JSON.stringify(expandedGeometry)}`)
  } else {
    console.log(`${theme} ${width}x${height}: PASS ${JSON.stringify(geometry)} (composer input unavailable)`)
  }
  await page.close()
}

;(async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const theme of ['light', 'dark']) {
      await verifyViewport(browser, 375, 812, theme)
      await verifyViewport(browser, 768, 1024, theme)
    }
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
