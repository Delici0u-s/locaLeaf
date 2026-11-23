// End-to-end test: the built extension (dist/) in Brave against a local Overleaf CE (dev/overleaf-ce).
// Prereqs: docker compose -f dev/overleaf-ce/compose.yml up -d; OLR_DEV_ORIGINS=<overleaf url> npm run build
// Usage: node test/e2e/run.mjs
import { join } from 'node:path'
import { ROOT } from '../../scripts/lib.mjs'
import { launch } from '../lib/browser.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from './overleaf.mjs'
import { harness, preflight } from '../lib/harness.mjs'

const h = harness('e2e')
await preflight(OVERLEAF_URL)
const TIMEOUT = h.stepMs
const results = []
let failures = 0
const check = async (name, ok, detail = '') => {
  results.push({ check: name, result: ok ? 'ok' : 'FAIL', detail })
  h.step(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) { failures++; await h.saveArtifacts(`check failed: ${name}`) }
}

const { context, close } = await launch({ extensionDir: join(ROOT, 'dist') })
h.onCleanup(close)
context.setDefaultTimeout(TIMEOUT)
const serverCompiles = []
const notFound = []
context.on('request', r => { if (/\/project\/[^/]+\/compile(\?|$)/.test(r.url())) serverCompiles.push(r.url()) })
context.on('response', r => { if (r.status() === 404) notFound.push(r.url()) })

function watchConsole(page, tag) {
  h.track(tag, page)
  const lines = []
  page.on('console', m => { if (m.text().includes('[overleaf-local-render]')) lines.push(m.text()) })
  page.on('pageerror', e => lines.push(`pageerror: ${e.message}`))
  return {
    lines,
    async waitFor(re, from = 0) {
      const t0 = Date.now()
      for (;;) {
        const hit = lines.slice(from).find(l => re.test(l))
        if (hit) return hit
        if (Date.now() - t0 > TIMEOUT) throw new Error(`${tag}: timed out waiting for ${re}; saw:\n${lines.join('\n')}`)
        await new Promise(r => setTimeout(r, 100))
      }
    },
  }
}

const pdfText = page => page.evaluate(() => [...document.querySelectorAll('.pdfViewer .textLayer')].map(e => e.textContent).join(' '))
async function waitForPdfText(page, needle) {
  const t0 = Date.now()
  while (!(await pdfText(page)).includes(needle)) {
    if (Date.now() - t0 > TIMEOUT) return false
    await page.waitForTimeout(200)
  }
  return true
}
async function recompile(page) {
  await page.locator('button:has-text("Recompile")').first().click()
}
async function typeAtEndOfLine(page, lineText, text) {
  const line = page.locator('.cm-content .cm-line', { hasText: lineText }).first()
  await line.click()
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

try {
  const setup = await context.newPage()
  await ensureAdmin(setup)
  await login(setup)
  const projectId = await uploadProject(setup, join(ROOT, 'test/e2e/projects/basic'), `e2e-${Date.now()}`)
  await setup.close()

  // 1. Opening the project compiles it locally and the PDF shows up in Overleaf's viewer.
  const page = await context.newPage()
  const con = watchConsole(page, 'tab1')
  const t0 = Date.now()
  await page.goto(`${OVERLEAF_URL}/project/${projectId}`)
  const first = await con.waitFor(/compiled .* locally|local compile failed/)
  await check('compile on load is local', /compiled main\.tex locally: success/.test(first), first)
  await check('PDF from the local build is shown', await waitForPdfText(page, 'MARKER-SECOND-ORIGINAL'), `${Date.now() - t0} ms from navigation`)

  // 2. Editing the open file and recompiling shows the change.
  const n2 = con.lines.length
  await typeAtEndOfLine(page, 'This paragraph comes from the main file.', ' EDITEDINMAIN.')
  await recompile(page)
  const second = await con.waitFor(/compiled .* locally|local compile failed/, n2)
  await check('edit + recompile is local', /locally: success/.test(second), second)
  await check('edit appears in the PDF', await waitForPdfText(page, 'EDITEDINMAIN'))

  // 3. A change to another file, made in a second tab (like a collaborator), reaches the local build.
  const tab2 = await context.newPage()
  const con2 = watchConsole(tab2, 'tab2')
  await tab2.goto(`${OVERLEAF_URL}/project/${projectId}`)
  await tab2.locator('.file-tree [role=treeitem]:has-text("chapters")').first().click()
  await tab2.locator('.file-tree [role=treeitem]:has-text("second.tex")').first().click()
  await tab2.locator('.cm-content .cm-line', { hasText: 'MARKER-SECOND-ORIGINAL' }).first().waitFor()
  await typeAtEndOfLine(tab2, 'MARKER-SECOND-ORIGINAL', ' COLLABEDIT.')
  await tab2.waitForTimeout(Number(process.env.OLR_E2E_COLLAB_SETTLE_MS ?? 3000)) // let tab2's ops reach the server
  const n3 = con.lines.length
  await recompile(page)
  const third = await con.waitFor(/compiled .* locally|local compile failed/, n3)
  await check('recompile after a collaborator edit is local', /locally: success/.test(third), third)
  await check("collaborator's edit to a non-open file is in the PDF", await waitForPdfText(page, 'COLLABEDIT'))

  // 4. SyncTeX both ways, through the same endpoints Overleaf's UI calls.
  const sync = await page.evaluate(async id => {
    const code = await (await fetch(`/project/${id}/sync/code?file=main.tex&line=7&column=0&clsiserverid=olr-local`)).json()
    const p = code.pdf?.[0]
    // click in the middle of the line, a little above its bottom edge
    const back = p ? await (await fetch(`/project/${id}/sync/pdf?page=${p.page}&h=${p.h + p.width / 2}&v=${p.v - p.height / 2}&clsiserverid=olr-local`)).json() : null
    return { code, back }
  }, projectId)
  await check('SyncTeX code → PDF', sync.code.pdf?.length > 0, JSON.stringify(sync.code.pdf?.[0]))
  await check('SyncTeX PDF → code', sync.back?.code?.[0]?.file === 'main.tex' && Math.abs(sync.back.code[0].line - 7) <= 1, JSON.stringify(sync.back?.code))

  // 5. The download button gets the local PDF.
  const download = await page.locator('a[aria-label="Download PDF"]').first().getAttribute('href')
  await check('download button points at the local PDF', !!download?.startsWith('blob:'), download ?? '')

  // 6. A TeX error shows up in Overleaf's log pane and as a marker in the editor (and still gives a PDF).
  const n6 = con.lines.length
  await typeAtEndOfLine(page, 'This paragraph comes from the main file.', ' \\undefinedcommandhere')
  await recompile(page)
  const errored = await con.waitFor(/compiled .* locally|local compile failed/, n6)
  await check('compile with an error still produces a PDF', /locally: success/.test(errored), errored)
  const errorsButton = page.locator('button:has-text("Errors")').first()
  if (!(await errorsButton.isVisible())) await page.locator('button[aria-label="View logs"]').first().click()
  await check('log pane counts the error', /Errors\s*1/.test((await errorsButton.textContent()) ?? ''), (await errorsButton.textContent()) ?? '')
  // Overleaf adds the editor markers after it has parsed the log, so wait for them.
  const marked = await h.waitFor('error markers in the editor', async () => (await page.locator('.cm-lint-marker-error').count()) > 0 && (await page.locator('.cm-lintRange-error').count()) > 0, h.pdfTextMs).then(() => true, () => false)
  await check('error is marked in the editor', marked)

  // 7. "Clear cached files" then Recompile rebuilds from scratch (more than one pass).
  const n7 = con.lines.length
  await page.locator('button:has-text("Clear cached files")').first().click()
  await page.waitForTimeout(500)
  await recompile(page)
  const fresh = await con.waitFor(/compiled .* locally|local compile failed/, n7)
  await check('recompile after clearing the cache is a full local build', /locally: success, ([2-9]|\d\d) passes/.test(fresh), fresh)

  // 8. Nothing was compiled on the server.
  await check('no compile request reached the server', serverCompiles.length === 0, serverCompiles.join(', '))
  await tab2.close()
} catch (e) {
  await check('test ran to the end', false, String(e?.stack ?? e).slice(0, 2000))
  await h.saveArtifacts(String(e?.stack ?? e))
} finally {
  await close()
  h.done()
}
console.table(results)
if (notFound.length) console.log(`404 responses during the run:\n  ${[...new Set(notFound)].join('\n  ')}`)
process.exit(failures ? 1 : 0)
