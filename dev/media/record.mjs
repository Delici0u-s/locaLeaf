// Records the README screenshots against the local Overleaf CE (dev/overleaf-ce), with labels:
// docs/media/editor.png (progress chip during a recompile, PDF from the local build) and popup.png.
// Uses a release-like build (no built-in sites; the site is enabled like the popup does), so the popup looks
// the way users see it. Run: node dev/media/record.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from '../../scripts/lib.mjs'
import { findBrowser } from '../../test/lib/browser.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from '../../test/e2e/overleaf.mjs'
import { annotate } from './annotate.js'

const OUT = join(ROOT, 'docs/media')
const VIEW = { width: 1280, height: 720 }
const TITLE = 'Heat Flow on a Thin Rod'
const MARK = { color: '#d9480f', gap: 10 } // label colour (stands out against Overleaf's green) and spacing, px
const POPUP_VIEW = { width: 860, height: 900 } // wide enough for labels right of the popup
const STEP_MS = 60_000
mkdirSync(OUT, { recursive: true })
const EXTENSION_DIR = join(ROOT, 'dist-media')
execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], { stdio: 'ignore', env: { ...process.env, OLR_DIST_DIR: 'dist-media', LOCALEAF_SITES: '', LOCALEAF_ANY_SITE: '1' } })
const deadline = setTimeout(() => { console.error('deadline passed'); process.exit(124) }, 5 * 60_000)

const profile = mkdtempSync(join(tmpdir(), 'olr-media-profile-'))
const context = await chromium.launchPersistentContext(profile, {
  executablePath: findBrowser(),
  headless: true,
  viewport: VIEW,
  args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
})
context.setDefaultTimeout(STEP_MS)
const waitLog = (logs, re, from = 0) => new Promise((resolve, reject) => {
  const t0 = Date.now()
  const poll = setInterval(() => {
    const hit = logs.slice(from).find(l => re.test(l))
    if (hit) { clearInterval(poll); resolve(hit) } else if (Date.now() - t0 > STEP_MS) { clearInterval(poll); reject(new Error(`no log ${re}; last logs:\n${logs.filter(l => l.includes("localeaf")).slice(-8).join("\n")}`)) }
  }, 50)
})

try {
  const setup = await context.newPage()
  await ensureAdmin(setup)
  await login(setup)
  const projectId = await uploadProject(setup, join(ROOT, 'dev/media/demo'), `demo-${Date.now()}`)
  // a clean title (uploads of the same name get " (2)", " (3)", …)
  await setup.goto(`${OVERLEAF_URL}/project`)
  const renamed = await setup.evaluate(async ([id, name]) => {
    const csrf = document.querySelector('meta[name="ol-csrfToken"]')?.getAttribute('content') ?? ''
    const r = await fetch(`/project/${id}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': csrf }, body: JSON.stringify({ newProjectName: name }) })
    return r.status
  }, [projectId, TITLE])
  if (renamed >= 300) throw new Error(`renaming the demo project failed: ${renamed}`)
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  // enable the site like the popup's switch does; show the chip at once; local compiles only (no warm-up race)
  await sw.evaluate(o => chrome.storage.local.set({ origins: [o], settings: { statusDelayMs: 0, raceWhileCold: false } }), new URL(OVERLEAF_URL).origin)
  for (let i = 0; i < 100 && !(await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then(s => s.length > 0))); i++) await setup.waitForTimeout(100)
  await setup.close()

  // 1. editor with the chip during a recompile (the PDF of the first compile still shown)
  const page = await context.newPage()
  const logs = []
  page.on('console', m => logs.push(m.text()))
  await page.goto(`${OVERLEAF_URL}/project/${projectId}`)
  await waitLog(logs, /compiled .* locally/)
  await page.waitForTimeout(1500)
  await page.locator('.cm-content .cm-line', { hasText: 'Higher modes decay' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' ')
  const n0 = logs.length
  await page.keyboard.press('Control+Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some(e => /TeX pass/.test(e.textContent)), null, { polling: 10 })
  // the chip is copied into the overlay at once: the recompile may be over before the screenshot
  await page.evaluate(annotate, { ...MARK, items: [
    { selector: '[role=status][title^="LocaLeaf"]', label: 'LocaLeaf compiling on your computer', side: 'below', clone: true },
    { selector: '.pdfViewer .page', label: 'PDF from the local build, in Overleaf\'s own viewer', side: 'inside-bottom' },
  ] })
  await page.screenshot({ path: join(OUT, 'editor.png') })
  await page.evaluate(() => document.getElementById('__annotations')?.remove())
  await waitLog(logs, /compiled .* locally/, n0)

  // 2. the popup for that tab
  const tabId = await sw.evaluate(u => chrome.tabs.query({}).then(ts => ts.find(t => t.url?.startsWith(u))?.id), `${OVERLEAF_URL}/project/${projectId}`)
  const extId = new URL(sw.url()).host
  const popup = await context.newPage()
  await popup.setViewportSize(POPUP_VIEW)
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`)
  await popup.waitForSelector('#stats:not([hidden])')
  await popup.waitForTimeout(500)
  const clip = await popup.evaluate(annotate, { ...MARK, items: [
    { selector: 'header', label: 'Engine status; ↻ restarts it', side: 'right' },
    { selector: '#site', label: 'Turn LocaLeaf on for this Overleaf site', side: 'right' },
    { selector: '#project', label: 'Compile this project locally or on the server', side: 'right' },
    { selector: '#stats', label: 'What it is doing now, and compile statistics', side: 'right' },
    { selector: '#settings', label: 'All settings, with explanations', side: 'right' },
  ] })
  await popup.screenshot({ path: join(OUT, 'popup.png'), clip: { x: 0, y: 0, width: clip.x + clip.width, height: clip.y + clip.height } })
  await sw.evaluate(() => chrome.storage.local.remove('settings'))

  console.log(`wrote ${readdirSync(OUT).join(', ')} to ${OUT}`)
} finally {
  clearTimeout(deadline)
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}
