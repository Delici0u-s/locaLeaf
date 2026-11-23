// End-to-end: the warm-up race (settings.raceWhileCold). A cold tab compiling a slow document gets its first
// PDF from the server, the local build finishes in the background, and from then on compiles are local only.
// A new tab whose build is kept compiles locally within the head start, so the server isn't asked at all.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, readJson } from '../../scripts/lib.mjs'
import { EXTENSION_DIR, launch } from '../lib/browser.mjs'
import { harness, preflight } from '../lib/harness.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from './overleaf.mjs'

const h = harness('e2e-race')
await preflight(OVERLEAF_URL)
const { spinCount } = readJson('config/test.json')
const spin = String(spinCount)
const results = []
let failures = 0
const check = async (name, ok, detail = '') => {
  results.push({ check: name, result: ok ? 'ok' : 'FAIL', detail })
  h.step(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
  if (!ok) { failures++; await h.saveArtifacts(`check failed: ${name}`) }
}
const pdfHas = (page, text) => h.waitFor(`"${text}" in the PDF`, () => page.evaluate(t => [...document.querySelectorAll('.pdfViewer .textLayer')].some(e => e.textContent.includes(t)), text), h.pdfTextMs).then(() => true, () => false)

const dir = mkdtempSync(join(tmpdir(), 'olr-e2e-race-'))
cpSync(join(ROOT, 'test/e2e/projects/slow'), dir, { recursive: true })
writeFileSync(join(dir, 'main.tex'), readFileSync(join(dir, 'main.tex'), 'utf8').replace('SPINCOUNT', spin))

const { context, close } = await launch({ extensionDir: EXTENSION_DIR })
h.onCleanup(close)
context.setDefaultTimeout(h.stepMs)
const serverCompiles = []
context.on('request', r => { if (/\/project\/[^/]+\/compile(\?|$)/.test(r.url())) serverCompiles.push(r.url()) })
try {
  const setup = await context.newPage()
  await ensureAdmin(setup)
  await login(setup)
  const projectId = await uploadProject(setup, dir, `e2e-race-${Date.now()}`)
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  await sw.evaluate(() => chrome.storage.local.set({ settings: { raceWhileCold: true } })) // test builds default to off
  await setup.close()

  h.step('opening the slow project in a cold tab')
  const page = await context.newPage()
  const logs = h.track('editor', page)
  const ours = () => logs.filter(l => l.includes('[localeaf]'))
  await page.goto(`${OVERLEAF_URL}/project/${projectId}`)
  const first = await h.waitFor('the first compile to finish', () => ours().find(l => /the server was first|compiled .* locally|local compile failed/.test(l)))
  await check('cold tab: the server races and wins the slow first compile', /the server was first/.test(first) && serverCompiles.length === 1, `${first} · ${serverCompiles.length} server compile(s)`)
  await check('the server\'s PDF is shown', await pdfHas(page, 'SLOWDONE'))
  const bg = await h.waitFor('the local build to finish in the background', () => ours().find(l => /local build of .* finished in the background|local compile failed/.test(l)))
  await check('the local build finishes in the background', /finished in the background: success/.test(bg), bg)

  h.step('editing and recompiling: now local only')
  await page.locator('.cm-content .cm-line', { hasText: spin }).first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.type('\\loop\\advance\\n by 1 \\ifnum\\n<10\\repeat QUICKDONE.')
  await page.waitForTimeout(1000)
  const n = ours().length
  const before = serverCompiles.length
  await page.locator('button:has-text("Recompile")').first().click()
  const second = await h.waitFor('the recompile', () => ours().slice(n).find(l => /compiled .* locally|local compile failed/.test(l)))
  await check('after warm-up, compiles are local and the server isn\'t asked', /locally: success/.test(second) && serverCompiles.length === before && !ours().slice(n).some(l => /on the server too/.test(l)), second)
  await check('its PDF is shown', await pdfHas(page, 'QUICKDONE'))

  h.step('a new tab of the same project (build kept by the engine)')
  const before2 = serverCompiles.length
  const page2 = await context.newPage()
  const logs2 = h.track('editor-2', page2)
  await page2.goto(`${OVERLEAF_URL}/project/${projectId}`)
  const third = await h.waitFor('the compile on load', () => logs2.find(l => /\[localeaf\].*(compiled .* locally|the server was first|local compile failed)/.test(l)))
  await check('a warm engine wins within the head start: no server compile', /locally: success/.test(third) && serverCompiles.length === before2 && !logs2.some(l => /on the server too/.test(l)), third)
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
