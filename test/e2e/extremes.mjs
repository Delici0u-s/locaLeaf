// End-to-end at the extremes: many files, large images, non-ASCII names, renaming a file mid-session.
// Sizes come from env so they can be pushed further: OLR_X_FILES (default 1000), OLR_X_IMAGES (10), OLR_X_IMAGE_KB (3072).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { deflateSync, crc32 } from 'node:zlib'
import { ROOT } from '../../scripts/lib.mjs'
import { launch } from '../lib/browser.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from './overleaf.mjs'
import { harness, preflight } from '../lib/harness.mjs'

const FILES = Number(process.env.OLR_X_FILES ?? 1000)
const IMAGES = Number(process.env.OLR_X_IMAGES ?? 10)
const IMAGE_KB = Number(process.env.OLR_X_IMAGE_KB ?? 3072)
const UMLAUT_DIR = 'kapitel-ä'
const UMLAUT_FILE = 'einführung.tex'
const RENAMED = 'umbenannt.tex'

/** An RGB PNG of random noise (doesn't compress, so it really is ~kb in size). */
function noisePng(kb) {
  const width = 512
  const height = Math.max(1, Math.ceil((kb * 1024) / (width * 3)))
  const rows = []
  for (let y = 0; y < height; y++) rows.push(Buffer.concat([Buffer.from([0]), randomBytes(width * 3)]))
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])))
    return Buffer.concat([len, Buffer.from(type), data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 0 })), chunk('IEND', Buffer.alloc(0))])
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'olr-extremes-'))
  mkdirSync(join(dir, 'parts')); mkdirSync(join(dir, 'img')); mkdirSync(join(dir, UMLAUT_DIR))
  const inputs = []
  for (let i = 0; i < FILES; i++) {
    const name = `parts/p${String(i).padStart(4, '0')}.tex`
    writeFileSync(join(dir, name), `Paragraph from file ${i}${i === FILES - 1 ? ' LASTFILEMARKER' : ''}.\\par\n`)
    inputs.push(`\\input{${name.replace(/\.tex$/, '')}}`)
  }
  for (let i = 0; i < IMAGES; i++) writeFileSync(join(dir, `img/noise${i}.png`), noisePng(IMAGE_KB))
  writeFileSync(join(dir, UMLAUT_DIR, UMLAUT_FILE), 'Text from a file with an umlaut name. UMLAUTMARKER.\\par\n')
  writeFileSync(join(dir, 'main.tex'), [
    '\\documentclass{article}', '\\usepackage{graphicx}', '\\begin{document}',
    'Start of the extremes document.',
    `\\input{${UMLAUT_DIR}/${UMLAUT_FILE.replace(/\.tex$/, '')}}`,
    ...Array.from({ length: IMAGES }, (_, i) => `\\includegraphics[width=2cm]{img/noise${i}}`),
    ...inputs, '\\end{document}', '',
  ].join('\n'))
  return dir
}

const h = harness('e2e-extremes')
await preflight(OVERLEAF_URL)
const results = []
let failures = 0
let page = null
const check = async (name, ok, detail = '') => {
  results.push({ check: name, result: ok ? 'ok' : 'FAIL', detail })
  h.step(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
  if (ok) return
  failures++
  // What the extension saw: the last local compile's errors.
  const last = page ? await page.evaluate(() => window.__overleafLocalRender?.lastCompile()).catch(() => null) : null
  if (last) h.step(`  last compile: ${last.status}, ${last.errors} errors\n    ${last.log.split('\n').filter(l => l.startsWith('!')).slice(0, 5).join('\n    ')}`)
  await h.saveArtifacts(`check failed: ${name}`)
}

const { context, close } = await launch({ extensionDir: join(ROOT, 'dist') })
h.onCleanup(close)
context.setDefaultTimeout(h.stepMs)
const serverCompiles = []
context.on('request', r => { if (/\/project\/[^/]+\/compile(\?|$)/.test(r.url())) serverCompiles.push(r.url()) })
h.step(`generating project: ${FILES} files, ${IMAGES}×${IMAGE_KB} KB images`)
const dir = makeProject()
try {
  const setup = await context.newPage()
  h.track('setup', setup)
  h.step('logging in')
  await ensureAdmin(setup)
  await login(setup)
  h.step('uploading the project zip')
  const t0 = Date.now()
  const projectId = await uploadProject(setup, dir, `e2e-extremes-${Date.now()}`)
  await check('upload', true, `${((Date.now() - t0) / 1000).toFixed(1)} s, project ${projectId}`)
  await setup.close()

  page = await context.newPage()
  const all = h.track('editor', page)
  const ours = () => all.filter(l => l.includes('[overleaf-local-render]'))
  // Our own log lines are also echoed live, so a hang shows where it stopped.
  page.on('console', m => { if (m.text().includes('[overleaf-local-render]')) h.step(`  page: ${m.text().replace('[overleaf-local-render] ', '').slice(0, 160)}`) })
  const waitLog = from => h.waitFor('a compile result in the page log', () => ours().slice(from).find(l => /compiled .* locally|local compile failed/.test(l)))
  // Only rendered pages have a text layer: jump to the first or last page, then look.
  const pdfHas = (text, where = 'start') => h.waitFor(`"${text}" in the PDF text (${where})`, async () => {
    await page.evaluate(w => {
      const viewer = document.querySelector('.pdfViewer')
      let c = viewer?.parentElement
      while (c && c.scrollHeight <= c.clientHeight) c = c.parentElement
      if (c) c.scrollTop = w === 'end' ? c.scrollHeight : 0
    }, where)
    return page.evaluate(t => [...document.querySelectorAll('.pdfViewer .textLayer')].some(e => e.textContent.includes(t)), text)
  }, h.pdfTextMs, 300).then(() => true, e => { h.step(e.message); return false })

  h.step('opening the project (mirror loads all docs, then compiles)')
  const t1 = Date.now()
  await page.goto(`${OVERLEAF_URL}/project/${projectId}`)
  const first = await waitLog(0)
  await check('open → local compile', /locally: success/.test(first), `${((Date.now() - t1) / 1000).toFixed(1)} s · ${first}`)
  await check('mirror loaded every file', ours().some(l => new RegExp(`mirror ready: ${FILES + 2} docs, ${IMAGES} files`).test(l)), ours().find(l => /mirror ready/.test(l)) ?? '')
  await check('file with an umlaut path is in the PDF', await pdfHas('UMLAUTMARKER'))
  await check(`text from file ${FILES - 1} is in the PDF`, await pdfHas('LASTFILEMARKER', 'end'))

  h.step('editing main.tex and recompiling')
  const n2 = ours().length
  await page.locator('.cm-content .cm-line', { hasText: 'Start of the extremes document.' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' EDITX')
  await page.waitForTimeout(1000)
  const t2 = Date.now()
  await page.locator('button:has-text("Recompile")').first().click()
  const edit = await waitLog(n2)
  await check('edit → local recompile', /locally: success/.test(edit), `${((Date.now() - t2) / 1000).toFixed(2)} s · ${edit}`)

  h.step('renaming the umlaut file in the file tree')
  await page.locator(`.file-tree [role=treeitem]:has-text("${UMLAUT_DIR}")`).first().click()
  await page.locator(`.file-tree [role=treeitem]:has-text("${UMLAUT_FILE}")`).first().click({ button: 'right' })
  await page.locator('[role=menuitem]:has-text("Rename"):visible').last().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(RENAMED)
  await page.keyboard.press('Enter')
  await page.locator(`.file-tree [role=treeitem]:has-text("${RENAMED}")`).first().waitFor()
  h.step('pointing \\input at the new name')
  await page.locator('.file-tree [role=treeitem]:has-text("main.tex")').first().click()
  await page.locator('.cm-content .cm-line', { hasText: UMLAUT_FILE.replace(/\.tex$/, '') }).first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.type(`\\input{${UMLAUT_DIR}/${RENAMED.replace(/\.tex$/, '')}}`)
  await page.waitForTimeout(1000)
  const n3 = ours().length
  await page.locator('button:has-text("Recompile")').first().click()
  const renamed = await waitLog(n3)
  await check('compile after renaming a file is local and succeeds', /locally: success/.test(renamed), renamed)
  await check('renamed file content in the new PDF', /locally: success/.test(renamed) && await pdfHas('UMLAUTMARKER'))
  await check('no compile request reached the server', serverCompiles.length === 0, serverCompiles.join(', '))
} catch (e) {
  await check('test ran to the end', false, String(e?.stack ?? e).slice(0, 600))
} finally {
  h.step('closing the browser')
  await close()
  rmSync(dir, { recursive: true, force: true })
  h.done()
}
console.table(results)
process.exit(failures ? 1 : 0)
