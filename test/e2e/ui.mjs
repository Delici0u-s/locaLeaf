// End-to-end for the UI: the popup (for a real Overleaf tab) and the progress chip's placement.
// Screenshots go to test/.artifacts/ui-*.png for review.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, readJson } from '../../scripts/lib.mjs'
import { EXTENSION_DIR, launch } from '../lib/browser.mjs'
import { harness, preflight } from '../lib/harness.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from './overleaf.mjs'

const h = harness('e2e-ui')
await preflight(OVERLEAF_URL)
const ART = join(ROOT, 'test/.artifacts')
mkdirSync(ART, { recursive: true })
const results = []
let failures = 0
/** The chip is right of Overleaf's download button and vertically centred on it. */
async function nextToDownload(pg, chipLocator) {
  const d = await pg.locator('[aria-label="Download PDF"]').first().boundingBox().catch(() => null)
  const c = await chipLocator.boundingBox().catch(() => null)
  if (!d || !c) return false
  return c.x >= d.x + d.width && c.x - (d.x + d.width) < 40 && Math.abs((c.y + c.height / 2) - (d.y + d.height / 2)) < 4
}

const check = async (name, ok, detail = '') => {
  results.push({ check: name, result: ok ? 'ok' : 'FAIL', detail })
  h.step(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
  if (!ok) { failures++; await h.saveArtifacts(`check failed: ${name}`) }
}

const { context, close } = await launch({ extensionDir: EXTENSION_DIR })
h.onCleanup(close)
context.setDefaultTimeout(h.stepMs)
const slowDir = mkdtempSync(join(tmpdir(), 'olr-e2e-ui-'))
try {
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const extId = new URL(sw.url()).host
  const setup = await context.newPage()
  await ensureAdmin(setup)
  await login(setup)
  const projectId = await uploadProject(setup, join(ROOT, 'test/e2e/projects/basic'), `e2e-ui-${Date.now()}`)

  const page = await context.newPage()
  const logs = h.track('editor', page)
  await page.goto(`${OVERLEAF_URL}/project/${projectId}`)
  await h.waitFor('a local compile', () => logs.find(l => /compiled .* locally/.test(l)))
  const tabId = await sw.evaluate(u => chrome.tabs.query({}).then(ts => ts.find(t => t.url?.startsWith(u))?.id), `${OVERLEAF_URL}/project/${projectId}`)

  h.step('opening the popup for the Overleaf tab')
  const popup = await context.newPage()
  h.track('popup', popup)
  await popup.setViewportSize({ width: 420, height: 900 })
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`)
  await popup.locator('#stats .tile').nth(1).waitFor()
  const now = await h.waitFor('the Now tile', async () => { const t = await popup.locator('#stats .tile.now').textContent(); return /Idle/.test(t ?? '') ? t : null })
  await check('popup "Now" tile shows the tab is idle with the last result', /last compile: done.*local/.test(now), now)
  await popup.screenshot({ path: join(ART, 'ui-popup.png'), fullPage: true })
  const sw1 = popup.locator('#site input[type=checkbox]')
  await check('site switch is on (and locked: built in)', (await sw1.isChecked()) && (await sw1.isDisabled()))
  await check('project shows "Locally" selected', (await popup.locator('#project button[aria-pressed=true]').textContent()) === 'Locally')
  const firstTile = await popup.locator('#stats .tile:not(.now) .n').first().textContent()
  await check('statistics show the local compile', Number(firstTile) >= 1, firstTile ?? '')
  const groups = await popup.locator('#groups details summary').allTextContents()
  await check('settings are grouped, unknown ones under Advanced', groups.length >= 5 && groups.at(-1) === 'Advanced', groups.join(' | '))
  await popup.locator('#groups details').first().evaluate(d => { d.open = true })
  await popup.screenshot({ path: join(ART, 'ui-popup-settings.png'), fullPage: true })
  await popup.emulateMedia({ colorScheme: 'dark' })
  await popup.screenshot({ path: join(ART, 'ui-popup-dark.png'), fullPage: true })

  h.step('changing the position while the tab is open (no reload)')
  // toolbar is the default, so go via another position to see a change
  await sw.evaluate(() => chrome.storage.local.set({ settings: { statusPosition: 'bottom-right', previewMs: 8000 } }))
  await page.waitForTimeout(500)
  await sw.evaluate(() => chrome.storage.local.set({ settings: { statusPosition: 'toolbar', previewMs: 8000 } }))
  const preview = page.locator('[role=status]:has-text("LocaLeaf")').first()
  await preview.waitFor({ timeout: 5000 }).catch(() => undefined)
  await check('a new position is previewed right away, next to the download button', await nextToDownload(page, preview))
  await sw.evaluate(() => chrome.storage.local.set({ settings: { statusPosition: 'top-right', previewMs: 8000 } }))
  await page.waitForTimeout(500)
  const box0 = await page.locator('[role=status]:has-text("LocaLeaf")').first().boundingBox()
  const vp = page.viewportSize()
  await check('switching to top-right moves it there', !!box0 && box0.y < vp.height / 4 && box0.x + box0.width > vp.width * 3 / 4, JSON.stringify(box0))
  await page.screenshot({ path: join(ART, 'ui-chip-preview.png') })
  await sw.evaluate(() => chrome.storage.local.remove('settings'))

  h.step('chip in the toolbar next to the download button')
  writeFileSync(join(slowDir, 'main.tex'), readFileSync(join(ROOT, 'test/e2e/projects/slow/main.tex'), 'utf8').replace('SPINCOUNT', String(readJson('config/test.json').spinCount)))
  const slowId = await uploadProject(setup, slowDir, `e2e-ui-slow-${Date.now()}`)
  await sw.evaluate(() => chrome.storage.local.set({ settings: { statusDelayMs: 0 } })) // default position: toolbar
  const slow = await context.newPage()
  const slowLogs = h.track('slow', slow)
  await slow.goto(`${OVERLEAF_URL}/project/${slowId}`)
  const chip = slow.locator('[role=status]:has-text("LocaLeaf")').first()
  await chip.waitFor()
  await slow.waitForTimeout(1500)
  await slow.screenshot({ path: join(ART, 'ui-chip-toolbar.png') })
  const slowTab = await sw.evaluate(u => chrome.tabs.query({}).then(ts => ts.find(t => t.url?.startsWith(u))?.id), `${OVERLEAF_URL}/project/${slowId}`)
  const popup2 = await context.newPage()
  await popup2.setViewportSize({ width: 420, height: 700 })
  await popup2.goto(`chrome-extension://${extId}/popup.html?tabId=${slowTab}`)
  const nowCompiling = await h.waitFor('the Now tile during the compile', async () => { const t = await popup2.locator('#stats .tile.now').textContent(); return /Compiling/.test(t ?? '') ? t : null }).catch(() => '')
  await check('popup "Now" tile shows the running compile', /Compiling.*TeX pass/.test(nowCompiling), nowCompiling)
  await popup2.screenshot({ path: join(ART, 'ui-popup-compiling.png') })
  await popup2.close()
  await check('by default the chip sits right of the download button', await nextToDownload(slow, chip))

  h.step('simulating an Overleaf UI change (download button not found)')
  const errorsBefore = slowLogs.filter(l => l.includes('[pageerror]')).length
  await slow.evaluate(() => document.querySelectorAll('[aria-label="Download PDF"]').forEach(e => e.removeAttribute('aria-label')))
  await slow.waitForTimeout(1500) // the chip re-places itself every second
  const fb = await chip.boundingBox()
  const vp2 = slow.viewportSize()
  await check('without the download button the chip falls back to bottom left', !!fb && fb.x < vp2.width / 4 && fb.y > vp2.height * 3 / 4, JSON.stringify(fb))
  await check('and nothing throws in the page', slowLogs.filter(l => l.includes('[pageerror]')).length === errorsBefore)

  h.step('dragging the chip')
  const box = await chip.boundingBox()
  await slow.mouse.move(box.x + 10, box.y + box.height / 2)
  await slow.mouse.down()
  await slow.mouse.move(400, 300, { steps: 8 })
  await slow.mouse.up()
  const saved = await h.waitFor('custom position stored', () => sw.evaluate(() => chrome.storage.local.get('settings').then(r => r.settings?.statusPosition === 'custom' ? r.settings : null)))
  await check('dragging stores a custom position (fractions of the window)', saved.statusX > 0 && saved.statusX < 1 && saved.statusY > 0 && saved.statusY < 1, JSON.stringify(saved))
  await slow.screenshot({ path: join(ART, 'ui-chip-dragged.png') })
  await h.waitFor('slow compile to finish', () => slowLogs.find(l => /compiled .* locally|local compile failed/.test(l)))
  await check('chip is gone after the compile', (await slow.locator('[role=status]:has-text("LocaLeaf")').count()) === 0)
  await sw.evaluate(() => chrome.storage.local.remove('settings'))

  h.step('switching the project to the server in the popup')
  await popup.locator('#project button:has-text("On the server")').click()
  const modes = await h.waitFor('project mode stored', () => sw.evaluate(() => chrome.storage.local.get('projectModes').then(r => r.projectModes)))
  await check('"On the server" stores the project mode', modes?.[projectId] === 'server', JSON.stringify(modes))
  await sw.evaluate(() => chrome.storage.local.remove('projectModes'))

} catch (e) {
  await check('test ran to the end', false, String(e?.stack ?? e).slice(0, 800))
} finally {
  await close()
  rmSync(slowDir, { recursive: true, force: true })
  h.done()
}
console.table(results)
process.exit(failures ? 1 : 0)
