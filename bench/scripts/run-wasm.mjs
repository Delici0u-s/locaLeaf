// Times BusyTeX (WASM) compiles of every fixture in a real Chromium-family browser (Brave by default).
// Usage: node scripts/run-wasm.mjs [fixture ...]     env: BENCH_BROWSER=/path/to/browser, BENCH_HEADED=1
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright-core'
import { BENCH_DIR, FIXTURES_DIR, applyEdit, listProjectFiles, printTable, selectFixtures, writeResults } from './lib.mjs'

const config = JSON.parse(readFileSync(join(BENCH_DIR, 'bench.config.json'), 'utf8'))
const fixtures = selectFixtures(process.argv.slice(2))
const KIND = process.env.BENCH_RESULTS ?? 'wasm'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = join(BENCH_DIR, path)
  if (!file.startsWith(BENCH_DIR) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
  })
  createReadStream(file).pipe(res)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const profile = mkdtempSync(join(tmpdir(), 'olr-bench-profile-'))
const context = await chromium.launchPersistentContext(profile, {
  executablePath: findBrowser(),
  headless: !process.env.BENCH_HEADED,
})
const page = await context.newPage()
page.setDefaultTimeout(config.wasm.compileTimeoutSeconds * 1000)
page.on('console', m => { if (m.type() === 'error') console.error('  [page]', m.text()) })

const basePath = `/${config.wasm.assetsPath}`
const init = async () => {
  await page.goto(`${origin}/page/index.html`)
  await page.waitForFunction(() => window.benchReady)
  return (await page.evaluate(a => window.bench.init(a), { basePath, preload: config.wasm.preloadDataPackages })).ms
}

const results = { browser: null, fixtures: [] }
try {
  results.initColdMs = await init()        // first ever start: downloads + caches the TeX Live data
  results.browser = await page.evaluate(() => navigator.userAgent)
  results.initWarmMs = await init()        // later starts: from the browser cache (what users see daily)
  console.log(`init: cold ${s(results.initColdMs)}, warm ${s(results.initWarmMs)}`)

  for (const fixture of fixtures) {
    const root = join(FIXTURES_DIR, fixture.name)
    const paths = listProjectFiles(root)
    const editPath = fixture.edit ?? fixture.main
    const original = readFileSync(join(root, editPath), 'utf8')
    const args = { fixture: fixture.name, paths, main: fixture.main, compiler: fixture.compiler, tools: fixture.tools, rerun: config.wasm.rerun, remoteEndpoint: config.wasm.remoteEndpoint }

    const runs = []
    runs.push({ step: 'first', ...(await page.evaluate(a => window.bench.compile(a), { ...args, overrides: {} })) })
    runs.push({ step: 'unchanged', ...(await page.evaluate(a => window.bench.compile(a), { ...args, overrides: {} })) })
    let source = original
    for (let n = 1; n <= config.editRounds; n++) {
      source = applyEdit(source, n)
      runs.push({ step: `edit${n}`, ...(await page.evaluate(a => window.bench.compile(a), { ...args, overrides: { [editPath]: source } })) })
    }
    // Same edits again through the prototype incremental path (state from its own first compile).
    const inc = { ...args, ...config.wasm.incremental }
    runs.push({ step: 'inc-first', ...(await page.evaluate(a => window.bench.compileIncremental(a), { ...inc, overrides: {} })) })
    runs.push({ step: 'inc-unchanged', ...(await page.evaluate(a => window.bench.compileIncremental(a), { ...inc, overrides: {} })) })
    source = original
    for (let n = 1; n <= config.editRounds; n++) {
      source = applyEdit(source, n)
      runs.push({ step: `inc-edit${n}`, ...(await page.evaluate(a => window.bench.compileIncremental(a), { ...inc, overrides: { [editPath]: source } })) })
    }
    for (const r of runs) {
      console.log(`${fixture.name} ${r.step}: ${r.ok ? `${s(r.ms)} success=${r.success} pdf=${r.pdfBytes}B${r.passes ? ` passes=${r.passes.length}` : ''}` : `ERROR ${r.error}`}`)
    }
    results.fixtures.push({ name: fixture.name, compiler: fixture.compiler, runs })
    writeResults(KIND, results) // saved after every project, so a crash keeps what finished
  }
} finally {
  await context.close()
  server.close()
  rmSync(profile, { recursive: true, force: true })
}

const file = writeResults(KIND, results)
printTable(results.fixtures.map(f => ({
  fixture: f.name,
  compiler: f.compiler,
  ...Object.fromEntries(f.runs.map(r => [r.step, r.ok && r.success ? s(r.ms) : r.ok ? `fail ${s(r.ms)}` : 'error'])),
})))
console.log(`\nresults: ${file}`)

function s(ms) { return `${(ms / 1000).toFixed(2)}s` }

function findBrowser() {
  if (process.env.BENCH_BROWSER) return process.env.BENCH_BROWSER
  for (const name of config.wasm.browserCandidates) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim() } catch {}
  }
  return undefined // playwright's own Chromium
}
