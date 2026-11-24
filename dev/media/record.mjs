// Records the README visuals against the local Overleaf CE (dev/overleaf-ce) with the test build:
// docs/media/editor.png (progress chip during a compile), popup.png and recompile.gif (edit → PDF).
// Uses a release-like build (no built-in sites; the site is enabled like the popup does), so the popup looks
// the way users see it. Run: node dev/media/record.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from '../../scripts/lib.mjs'
import { findBrowser } from '../../test/lib/browser.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from '../../test/e2e/overleaf.mjs'

const OUT = join(ROOT, 'docs/media')
const VIEW = { width: 1280, height: 720 }
const GIF_WIDTH = 960
const TITLE = 'Heat Flow on a Thin Rod'
const GIF_FPS = 12
const STEP_MS = 60_000
mkdirSync(OUT, { recursive: true })
const EXTENSION_DIR = join(ROOT, 'dist-media')
execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], { stdio: 'ignore', env: { ...process.env, OLR_DIST_DIR: 'dist-media', LOCALEAF_SITES: '', LOCALEAF_ANY_SITE: '1' } })
const deadline = setTimeout(() => { console.error('deadline passed'); process.exit(124) }, 5 * 60_000)

const profile = mkdtempSync(join(tmpdir(), 'olr-media-profile-'))
const videoDir = mkdtempSync(join(tmpdir(), 'olr-media-frames-'))
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
  await page.screenshot({ path: join(OUT, 'editor.png') })
  await waitLog(logs, /compiled .* locally/, n0)
  await page.waitForTimeout(1500)

  // 2. the GIF: an edit, Ctrl+Enter, the new PDF (frames from the DevTools screencast, with their timestamps)
  const frames = []
  const cdp = await context.newCDPSession(page)
  cdp.on('Page.screencastFrame', f => {
    frames.push({ data: f.data, t: f.metadata.timestamp })
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  })
  // the title: a short line (End stays on it) and big in the PDF; clicked before recording so the editor doesn't jump
  await page.locator('.cm-content .cm-line', { hasText: '\\title{' }).first().click()
  await page.waitForTimeout(300)
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  await page.waitForTimeout(600)
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type(', Revisited', { delay: 60 })
  const n = logs.length
  console.log('edit typed, recompiling')
  await page.keyboard.press('Control+Enter')
  await waitLog(logs, /compiled .* locally/, n)
  await page.waitForTimeout(1800)
  await cdp.send('Page.stopScreencast')

  // 3. the popup for that tab
  const tabId = await sw.evaluate(u => chrome.tabs.query({}).then(ts => ts.find(t => t.url?.startsWith(u))?.id), `${OVERLEAF_URL}/project/${projectId}`)
  const extId = new URL(sw.url()).host
  const popup = await context.newPage()
  await popup.setViewportSize({ width: 400, height: 900 })
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`)
  await popup.waitForSelector('#stats:not([hidden])')
  await popup.waitForTimeout(500)
  await popup.locator('body').screenshot({ path: join(OUT, 'popup.png') })
  await sw.evaluate(() => chrome.storage.local.remove('settings'))

  // frames → concat list with each frame's real duration → GIF (palette pass for clean colours)
  const list = frames.map((f, i) => {
    const file = join(videoDir, `f${String(i).padStart(5, '0')}.png`)
    writeFileSync(file, Buffer.from(f.data, 'base64'))
    const dur = i + 1 < frames.length ? frames[i + 1].t - f.t : 1.5 // hold the last frame
    return `file '${file}'\nduration ${dur.toFixed(3)}`
  })
  const concat = join(videoDir, 'frames.txt')
  writeFileSync(concat, `${list.join('\n')}\nfile '${join(videoDir, `f${String(frames.length - 1).padStart(5, '0')}.png`)}'\n`)
  const palette = join(videoDir, 'palette.png')
  const filters = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`
  const input = ['-f', 'concat', '-safe', '0', '-i', concat]
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...input, '-vf', `${filters},palettegen=stats_mode=diff`, palette])
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...input, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, join(OUT, 'recompile.gif')])
  console.log(`wrote ${readdirSync(OUT).join(', ')} to ${OUT} (${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)} s)`)
} finally {
  clearTimeout(deadline)
  await context.close()
  rmSync(profile, { recursive: true, force: true })
  rmSync(videoDir, { recursive: true, force: true })
}
