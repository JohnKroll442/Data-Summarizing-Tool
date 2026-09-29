import { chromium } from 'playwright'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:5174'
const CSV = path.resolve('.superpowers/sdd/smoke.csv')
const results = []
const consoleErrors = []
const pageErrors = []

const shot = (page, name) => page.screenshot({ path: `tmp_shot_${name}.png` }).catch(() => {})

async function ask(page, text, { label }) {
  const before = await page.locator('.ai-chat-markdown').count()
  await page.fill('.ai-chat-input', text)
  await page.click('.ai-chat-send-btn')
  // A plan card may appear (HITL). Wait for either a confirm button or a response.
  try {
    await page.waitForSelector('.ai-chat-confirm-btn', { timeout: 45000 })
    await page.click('.ai-chat-confirm-btn')
  } catch {
    // no plan card — some intents answer directly
  }
  // Wait for a new markdown response to appear.
  await page.waitForFunction(
    (n) => document.querySelectorAll('.ai-chat-markdown').length > n,
    before,
    { timeout: 120000 },
  )
  // Let ECharts mount.
  await page.waitForTimeout(1500)
  const last = page.locator('.ai-chat-markdown').last()
  const charts = await last.locator('.ai-chat-chart canvas').count()
  const unavailable = await last.locator('.ai-chat-chart-unavailable').count()
  const codeBlocks = await last.locator('pre.ai-chat-code').count()
  await shot(page, label)
  return { charts, unavailable, codeBlocks }
}

const browser = await (async () => {
  try { return await chromium.launch({ channel: 'msedge' }) }
  catch { return await chromium.launch({ channel: 'chrome' }) }
})()
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e)))

// Capture backend confirm responses so we can see the raw response_text.
const confirmBodies = []
page.on('response', async (resp) => {
  const u = resp.url()
  if (u.includes('/confirm')) {
    try { confirmBodies.push(await resp.json()) } catch { /* non-json */ }
  }
})

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })

  // Upload the CSV via the (shadow-DOM) file input.
  const input = page.locator('input[type=file]')
  await input.setInputFiles(CSV)

  // Missing-column dialog → Continue anyway.
  try {
    await page.getByText('Continue anyway', { exact: false }).click({ timeout: 8000 })
  } catch { /* no validation dialog */ }

  // Land on a summary view, then go to Action View.
  await page.waitForURL('**/summary/**', { timeout: 15000 })
  await page.getByText('Action View', { exact: true }).click()
  await page.waitForTimeout(1000)

  // Open the chat.
  await page.click('.agent-chat-fab')
  await page.waitForSelector('.ai-chat-input', { timeout: 10000 })

  const cases = [
    { label: 'action_waterfall', q: 'show me the waterfall chart for the Open story action', expect: 'chart' },
    { label: 'widget_waterfall',  q: 'show me the timing chart for Widget A in the Open story action', expect: 'chart' },
    { label: 'registry_pareto',   q: 'show me a pareto chart of action durations', expect: 'chart' },
    { label: 'auto_trace',        q: 'trace what happened inside the Open story action', expect: 'chart' },
    { label: 'negative',          q: 'show me the waterfall chart for a Nonexistent action', expect: 'unavailable_or_none' },
    { label: 'no_chart_default',  q: 'how slow is the Open story action?', expect: 'no_chart' },
  ]

  for (const c of cases) {
    try {
      const r = await ask(page, c.q, { label: c.label })
      let pass
      if (c.expect === 'chart') pass = r.charts >= 1 && r.codeBlocks === 0
      else if (c.expect === 'no_chart') pass = r.charts === 0
      else pass = true // negative: unavailable OR no chart is acceptable; must not crash
      results.push({ ...c, ...r, pass })
    } catch (e) {
      results.push({ ...c, error: String(e), pass: false })
    }
  }
} catch (e) {
  results.push({ label: 'SETUP', error: String(e), pass: false })
} finally {
  console.log('\n===== SMOKE RESULTS =====')
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}  charts=${r.charts ?? '-'} unavailable=${r.unavailable ?? '-'} code=${r.codeBlocks ?? '-'}${r.error ? '  ERR=' + r.error : ''}`)
  }
  console.log('\n--- console errors ---'); console.log(consoleErrors.slice(0, 20).join('\n') || '(none)')
  console.log('\n--- page errors ---'); console.log(pageErrors.slice(0, 20).join('\n') || '(none)')
  console.log('\n===== RAW response_text (per confirm) =====')
  confirmBodies.forEach((b, i) => {
    const txt = b?.response_text ?? b?.response?.response_text ?? JSON.stringify(b).slice(0, 300)
    const hasChartFence = /```chart/.test(txt || '')
    const hasJsonFence = /```json/.test(txt || '')
    const mentionsFamily = /"family"|family:/.test(txt || '')
    console.log(`\n[[${i}]] chartFence=${hasChartFence} jsonFence=${hasJsonFence} mentionsFamily=${mentionsFamily} len=${(txt||'').length}\n${(txt || '')}`)
  })
  await browser.close()
}
