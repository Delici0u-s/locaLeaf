// Larger end-to-end run: each public project from bench/fixtures.json is uploaded to the local Overleaf,
// its compiler set, opened with the extension, compiled on load, edited and recompiled.
// Usage: node test/e2e/fixtures.mjs [fixture ...]
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, readJson } from '../../scripts/lib.mjs'
import { launch } from '../lib/browser.mjs'
import { OVERLEAF_URL, ensureAdmin, login, setProjectSettings, uploadProject } from './overleaf.mjs'
import { harness, preflight } from '../lib/harness.mjs'

const h = harness('e2e-fixtures')
await preflight(OVERLEAF_URL)
const TIMEOUT = h.stepMs
const wanted = process.argv.slice(2)
const cases = readJson('test/engine/cases.json').cases
const known = Object.fromEntries(cases.filter(c => c.knownFailure).map(c => [c.fixture, c.knownFailure]))
// Projects whose fonts can't be provided locally must be compiled on the server (on purpose).
const expectServer = new Set(cases.filter(c => c.expect?.missingFonts === 'some').map(c => c.fixture))
const fixtures = readJson('bench/fixtures.json').fixtures.filter(f => (wanted.length ? wanted.includes(f.name) : true))

/** Overleaf picks the main document by \documentclass; drop other top-level candidates in a temp copy. */
function uploadCopy(fx) {
  const dir = mkdtempSync(join(tmpdir(), `olr-e2e-${fx.name}-`))
  cpSync(join(ROOT, 'bench/fixtures', fx.name), dir, { recursive: true })
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name !== fx.main && name.endsWith('.tex') && statSync(p).isFile() && /\\documentclass/.test(readFileSync(p, 'utf8'))) rmSync(p)
  }
  return dir
}

const { context, close } = await launch({ extensionDir: join(ROOT, 'dist') })
h.onCleanup(close)
context.setDefaultTimeout(TIMEOUT)
const serverCompiles = []
context.on('request', r => { if (/\/project\/[^/]+\/compile(\?|$)/.test(r.url())) serverCompiles.push(r.url()) })
const rows = []
let failures = 0
let unexpectedServer = 0
try {
  const setup = await context.newPage()
  await ensureAdmin(setup)
  await login(setup)
  for (const fx of fixtures) {
    h.step(`fixture ${fx.name}: uploading`)
    const dir = uploadCopy(fx)
    const id = await uploadProject(setup, dir, `e2e-${fx.name}-${Date.now()}`)
    rmSync(dir, { recursive: true, force: true })
    await setProjectSettings(setup, id, { compiler: fx.compiler })

    const serverStart = serverCompiles.length
    const page = await context.newPage()
    h.track(fx.name, page)
    h.step(`fixture ${fx.name}: opening`)
    const lines = []
    page.on('console', m => { if (m.text().includes('[overleaf-local-render]')) lines.push(m.text()) })
    const waitLog = async from => {
      const t0 = Date.now()
      for (;;) {
        const hit = lines.slice(from).find(l => /compiled .* locally|local compile failed/.test(l))
        if (hit) return hit
        if (Date.now() - t0 > TIMEOUT) return 'timeout'
        await new Promise(r => setTimeout(r, 100))
      }
    }
    const t0 = Date.now()
    await page.goto(`${OVERLEAF_URL}/project/${id}`)
    const first = await waitLog(0)
    const firstMs = Date.now() - t0
    // One-character edit (a comment) on the first line, then Recompile.
    await page.locator('.cm-content .cm-line').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('%')
    await page.waitForTimeout(Number(process.env.OLR_E2E_SETTLE_MS ?? 1500))
    const n = lines.length
    const t1 = Date.now()
    await page.locator('button:has-text("Recompile")').first().click()
    const edit = expectServer.has(fx.name) ? (await page.waitForTimeout(3000), 'server (expected)') : await waitLog(n)
    const editMs = Date.now() - t1
    const ok = expectServer.has(fx.name)
      ? /fonts not available locally/.test(first) // first compile falls back; the edit goes straight to the server
      : /locally: success/.test(first) && /locally: success/.test(edit)
    if (!ok && !known[fx.name]) failures++
    const engineMs = s => s.match(/engine (\d+) ms/)?.[1] ?? '?'
    if (!expectServer.has(fx.name)) unexpectedServer += serverCompiles.length - serverStart
    rows.push({ fixture: fx.name, compiler: fx.compiler, result: ok ? 'ok' : known[fx.name] ? 'KNOWN' : 'FAIL', where: expectServer.has(fx.name) ? 'server' : 'local', 'open→PDF': `${(firstMs / 1000).toFixed(1)}s`, 'edit→PDF': `${(editMs / 1000).toFixed(2)}s`, 'engine edit': `${engineMs(edit)} ms`, passes: edit.match(/(\d+) passes/)?.[1] ?? '?' })
    if (!ok) console.log(`${fx.name}:\n  first: ${first}\n  edit: ${edit}`)
    await page.close()
  }
} catch (e) {
  failures++
  console.log(`ERROR: ${e?.message ?? e}`)
  await h.saveArtifacts(String(e?.stack ?? e))
} finally {
  await close()
  h.done()
}
console.table(rows)
console.log(`compile requests that reached the server: ${serverCompiles.length} (unexpected: ${unexpectedServer})`)
process.exit(failures || unexpectedServer ? 1 : 0)
