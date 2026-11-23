// End-to-end: "Stop compilation" during a long local compile, then a working local compile afterwards
// (stopping restarts the engine, so the page must send a full snapshot again).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, readJson } from '../../scripts/lib.mjs'
import { EXTENSION_DIR, launch } from '../lib/browser.mjs'
import { harness, preflight } from '../lib/harness.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from './overleaf.mjs'

const h = harness('e2e-stop')
await preflight(OVERLEAF_URL)
const { spinCount, stopMaxMs } = readJson('config/test.json')
const spin = String(spinCount)
const results = []
let failures = 0
const check = async (name, ok, detail = '') => {
  results.push({ check: name, result: ok ? 'ok' : 'FAIL', detail })
  h.step(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
  if (!ok) { failures++; await h.saveArtifacts(`check failed: ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'olr-e2e-stop-'))
cpSync(join(ROOT, 'test/e2e/projects/slow'), dir, { recursive: true })
writeFileSync(join(dir, 'main.tex'), readFileSync(join(dir, 'main.tex'), 'utf8').replace('SPINCOUNT', spin))

const { context, close } = await launch({ extensionDir: EXTENSION_DIR })
h.onCleanup(close)
context.setDefaultTimeout(h.stepMs)
const serverCompiles = []
context.on('request', r => {
  if (/\/project\/[^/]+\/compile(\?|$)/.test(r.url())) serverCompiles.push(r.url())
  if (/\/compile\/stop/.test(r.url())) h.step(`network: ${r.method()} ${r.url()}`)
})
try {
  const setup = await context.newPage()
  await ensureAdmin(setup)
  await login(setup)
  const projectId = await uploadProject(setup, dir, `e2e-stop-${Date.now()}`)
  await setup.close()

  const page = await context.newPage()
  const logs = h.track('editor', page)
  const ours = () => logs.filter(l => l.includes('[localeaf]'))
  await page.goto(`${OVERLEAF_URL}/project/${projectId}`)
  h.step('waiting for the slow compile to be running')
  await h.waitFor('the compile to start', () => page.locator('button:has-text("Compiling")').count())
  const t0 = Date.now()
  await page.locator('button[aria-label="Toggle compile options menu"]').click()
  await page.locator('[role=menuitem]:has-text("Stop compilation"), .dropdown-item:has-text("Stop compilation")').first().click()
  const stopped = await h.waitFor('the stop to be logged', () => ours().find(l => /compile stopped|compiled .* locally|local compile failed/.test(l)))
  await check('stop ends the local compile', /compile stopped/.test(stopped), `${Date.now() - t0} ms · ${stopped}`)
  await check('the UI is no longer compiling', await h.waitFor('Recompile button', async () => (await page.locator('button:has-text("Compiling")').count()) === 0, h.stepMs).then(() => true, () => false))

  h.step('making the document quick and recompiling')
  await page.locator('.cm-content .cm-line', { hasText: spin }).first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.type('\\loop\\advance\\n by 1 \\ifnum\\n<10\\repeat')
  await page.waitForTimeout(1000)
  const n = ours().length
  await page.locator('button:has-text("Recompile")').first().click()
  const after = await h.waitFor('a compile result', () => ours().slice(n).find(l => /compiled .* locally|local compile failed/.test(l)))
  await check('the next compile after a stop is local and succeeds', /locally: success/.test(after), after)
  await check('its PDF is shown', await h.waitFor('SLOWDONE in the PDF', () => page.evaluate(() => [...document.querySelectorAll('.pdfViewer .textLayer')].some(e => e.textContent.includes('SLOWDONE'))), h.pdfTextMs).then(() => true, () => false))

  // Second case: stop while TeX is running in an already warm engine.
  h.step('making the document slow again and stopping mid-compile')
  await page.locator('.cm-content .cm-line', { hasText: '\\ifnum\\n<10' }).first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.type(`\\loop\\advance\\n by 1 \\ifnum\\n<${spin}\\repeat`)
  await page.waitForTimeout(1000)
  const n2 = ours().length
  await page.locator('button:has-text("Recompile")').first().click()
  await page.waitForTimeout(3000) // well into the TeX run
  const indicator = await page.locator('[role=status]:has-text("LocaLeaf")').first().textContent().catch(() => '')
  await check('progress indicator shows the running TeX pass', /TeX pass \d/.test(indicator ?? ''), indicator ?? '')
  const t1 = Date.now()
  await page.locator('button[aria-label="Toggle compile options menu"]').click()
  await page.locator('[role=menuitem]:has-text("Stop compilation"), .dropdown-item:has-text("Stop compilation")').first().click()
  const midStop = await h.waitFor('the stop to be logged', () => ours().slice(n2).find(l => /compile stopped|compiled .* locally|local compile failed/.test(l)))
  const took = Date.now() - t1
  await check('stopping a running TeX pass ends it quickly', /compile stopped/.test(midStop) && took < stopMaxMs, `${took} ms · ${midStop}`)
  await check('no compile request reached the server', serverCompiles.length === 0, serverCompiles.join(', '))
  await check('indicator is gone after the compile', (await page.locator('[role=status]:has-text("LocaLeaf")').count()) === 0)

  // Time limit: with localTimeoutSeconds set low, the slow compile is abandoned and compiled on the server.
  h.step('setting a 5 s time limit and compiling the slow document again')
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  await sw.evaluate(() => chrome.storage.local.set({ settings: { localTimeoutSeconds: 5 } }))
  await page.reload()
  const n3 = ours().length
  const serverBefore = serverCompiles.length
  await h.waitFor('the compile on load', () => ours().slice(n3).find(l => /compiled .* locally|local compile failed/.test(l)))
  const limited = ours().slice(n3).find(l => /local compile failed/.test(l)) ?? ''
  await check('a compile over the time limit falls back to the server', /took longer than 5 s/.test(limited) && serverCompiles.length > serverBefore, limited)
  await sw.evaluate(() => chrome.storage.local.remove('settings'))
} catch (e) {
  await check('test ran to the end', false, String(e?.stack ?? e).slice(0, 800))
} finally {
  await close()
  rmSync(dir, { recursive: true, force: true })
  h.done()
}
console.table(results)
process.exit(failures ? 1 : 0)
