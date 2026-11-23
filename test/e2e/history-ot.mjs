// End-to-end with history-ot documents (Overleaf's newer OT type; the mirror re-fetches them after changes).
// The project is migrated with test/e2e/migrate-history-ot.sh before anyone opens it.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from '../../scripts/lib.mjs'
import { launch } from '../lib/browser.mjs'
import { harness, preflight } from '../lib/harness.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from './overleaf.mjs'

const h = harness('e2e-history-ot')
await preflight(OVERLEAF_URL)
const results = []
let failures = 0
const check = async (name, ok, detail = '') => {
  results.push({ check: name, result: ok ? 'ok' : 'FAIL', detail })
  h.step(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
  if (!ok) { failures++; await h.saveArtifacts(`check failed: ${name}`) }
}

const { context, close } = await launch({ extensionDir: join(ROOT, 'dist') })
h.onCleanup(close)
context.setDefaultTimeout(h.stepMs)
const serverCompiles = []
context.on('request', r => { if (/\/project\/[^/]+\/compile(\?|$)/.test(r.url())) serverCompiles.push(r.url()) })

const compiled = (logs, from) => h.waitFor('a compile result', () => logs.slice(from).find(l => /compiled .* locally|local compile failed/.test(l)))
const pdfHas = (page, text) => h.waitFor(`"${text}" in the PDF`, () => page.evaluate(t => [...document.querySelectorAll('.pdfViewer .textLayer')].some(e => e.textContent.includes(t)), text), h.pdfTextMs).then(() => true, () => false)
const typeAtEnd = async (page, lineText, text) => {
  await page.locator('.cm-content .cm-line', { hasText: lineText }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

try {
  const setup = await context.newPage()
  h.track('setup', setup)
  await ensureAdmin(setup)
  await login(setup)
  const projectId = await uploadProject(setup, join(ROOT, 'test/e2e/projects/basic'), `e2e-history-ot-${Date.now()}`)
  await setup.close()
  h.step('migrating the project to history-ot')
  const migrated = execFileSync(join(ROOT, 'test/e2e/migrate-history-ot.sh'), [projectId], { encoding: 'utf8', timeout: h.stepMs, stdio: ['ignore', 'pipe', 'ignore'] })
  await check('project migrated', /"otMigrationStage":1/.test(migrated), migrated.trim().split('\n').pop())

  const page = await context.newPage()
  const logs = h.track('tab1', page)
  await page.goto(`${OVERLEAF_URL}/project/${projectId}`)
  const first = await compiled(logs, 0)
  await check('compile on load is local', /locally: success/.test(first), first)
  const types = await page.evaluate(() => window.__overleafLocalRender.docTypes())
  await check('docs arrive as history-ot', Object.values(types).length > 0 && Object.values(types).every(t => t === 'history-ot'), JSON.stringify(types))

  const n1 = logs.length
  await typeAtEnd(page, 'This paragraph comes from the main file.', ' OTEDITMAIN.')
  await page.waitForTimeout(1000)
  await page.locator('button:has-text("Recompile")').first().click()
  const second = await compiled(logs, n1)
  await check('edit + recompile is local', /locally: success/.test(second), second)
  await check('edit appears in the PDF', await pdfHas(page, 'OTEDITMAIN'))

  const tab2 = await context.newPage()
  h.track('tab2', tab2)
  await tab2.goto(`${OVERLEAF_URL}/project/${projectId}`)
  await tab2.locator('.file-tree [role=treeitem]:has-text("chapters")').first().click()
  await tab2.locator('.file-tree [role=treeitem]:has-text("second.tex")').first().click()
  await typeAtEnd(tab2, 'MARKER-SECOND-ORIGINAL', ' OTCOLLAB.')
  await tab2.waitForTimeout(3000)
  const n2 = logs.length
  await page.locator('button:has-text("Recompile")').first().click()
  const third = await compiled(logs, n2)
  await check('recompile after a collaborator edit is local', /locally: success/.test(third), third)
  await check("collaborator's edit to a non-open history-ot doc is in the PDF", await pdfHas(page, 'OTCOLLAB'))
  await check('no compile request reached the server', serverCompiles.length === 0, serverCompiles.join(', '))
} catch (e) {
  await check('test ran to the end', false, String(e?.stack ?? e).slice(0, 800))
} finally {
  await close()
  h.done()
}
console.table(results)
process.exit(failures ? 1 : 0)
