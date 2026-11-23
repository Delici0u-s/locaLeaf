// Engine tests: builds the engine worker, runs test cases in the browser, checks results.
// Usage: node test/engine/run.mjs [case-name-substring ...]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { build } from 'esbuild'
import { ROOT, readJson } from '../../scripts/lib.mjs'
import { serve } from '../lib/server.mjs'
import { launch } from '../lib/browser.mjs'
import { harness } from '../lib/harness.mjs'

const h = harness('engine')
const HERE = join(ROOT, 'test/engine')
const BUILD = join(HERE, '.build')
const filters = process.argv.slice(2)
const engineCfg = readJson('config/engine.json')
const defaults = readJson('config/settings.defaults.json')
const fixtures = Object.fromEntries(readJson('bench/fixtures.json').fixtures.map(f => [f.name, f]))
const cases = readJson('test/engine/cases.json').cases.filter(c => !filters.length || filters.some(f => c.name.includes(f)))

await build({ entryPoints: [join(ROOT, 'extension/src/engine/worker.ts')], bundle: true, format: 'iife', define: { __TEST_HOOKS__: 'true' }, outfile: join(BUILD, 'engine-worker.js'), target: 'chrome120', logLevel: 'warning' })

const server = await serve({ '/ctan/': { proxy: defaults.ctanMirror, cacheDir: join(ROOT, 'test/.cache/ctan') }, '/config/': join(ROOT, 'config'), '/build/': BUILD, '/vendor/busytex/': join(ROOT, engineCfg.vendorDir), '/fixtures/': join(ROOT, 'bench/fixtures'), '/projects/': join(HERE, 'projects'), '/page/': HERE })
const { context, close } = await launch()
h.onCleanup(close)
const page = await context.newPage()
h.track('engine', page)
page.setDefaultTimeout(h.stepMs)
await page.goto(`${server.origin}/page/page.html`)
await page.waitForFunction(() => window.engineReady)

const listFiles = dir => readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? listFiles(join(dir, n)).map(p => `${n}/${p}`) : [n])
const appendEdit = (text, n) => {
  const at = text.lastIndexOf('\\end{document}')
  const line = `\\par Engine test edit ${n}.\n`
  return at < 0 ? `${text}\n${line}` : text.slice(0, at) + line + text.slice(at)
}

const results = []
let failed = 0
try {
  const init = await page.evaluate(o => window.engine.init(o), {
    basePath: '/vendor/busytex', bundles: engineCfg.bundles, remoteEndpoint: defaults.remoteEndpoint, fontIndexUrl: '/config/font-index.json', texliveIndexUrl: '/config/texlive-files.json.gz', ctanMirror: `${server.origin}/ctan`, settings: defaults.engine,
  })
  h.step(`engine ready in ${(init.ms / 1000).toFixed(1)}s`)

  for (const c of cases) {
    h.step(`case ${c.name}`)
    const fx = c.fixture ? fixtures[c.fixture] : null
    const dir = fx ? join(ROOT, 'bench/fixtures', fx.name) : join(HERE, 'projects', c.project)
    const urlBase = fx ? `/fixtures/${fx.name}` : `/projects/${c.project}`
    const files = listFiles(dir).map(p => ({ path: p, url: `${urlBase}/${p.split('/').map(encodeURIComponent).join('/')}` }))
    const opts = { main: fx?.main ?? c.main, compiler: fx?.compiler ?? c.compiler, draft: !!c.draft, stopOnFirstError: !!c.stopOnFirstError }
    const projectId = c.name

    await page.evaluate(([id, f]) => window.engine.sync(id, f, { reset: true }), [projectId, files])
    const first = await page.evaluate(([id, o]) => window.engine.compile(id, o), [projectId, opts])
    const again = await page.evaluate(([id, o]) => window.engine.compile(id, o), [projectId, opts])
    const editPath = fx?.edit ?? fx?.main ?? c.main
    const edited = appendEdit(readFileSync(join(dir, editPath), 'utf8'), 1)
    await page.evaluate(([id, f, ov]) => window.engine.sync(id, f, { overrides: ov }), [projectId, files.filter(f => f.path === editPath), { [editPath]: edited }])
    const edit = await page.evaluate(([id, o]) => window.engine.compile(id, o), [projectId, opts])

    const problems = []
    const e = c.expect
    if (e.status && first.status !== e.status) problems.push(`status ${first.status} ≠ ${e.status}`)
    if (e.errors !== undefined && first.errors !== e.errors) problems.push(`errors ${first.errors} ≠ ${e.errors}`)
    if (e.minErrors !== undefined && first.errors < e.minErrors) problems.push(`errors ${first.errors} < ${e.minErrors}`)
    for (const s of e.logLacks ?? []) if (first.log.toLowerCase().includes(s)) problems.push(`log contains "${s}"`)
    if (!again.cached) problems.push('unchanged recompile was not served from cache')
    if (e.status === 'success' && edit.status !== 'success') problems.push(`edit recompile ${edit.status}`)
    if (first.status === 'success' && !first.synctexBytes) problems.push('no synctex')
    if (e.missingFonts === 'none' && first.missingFonts.length) problems.push(`missing fonts: ${first.missingFonts.join(', ')}`)
    if (e.missingFonts === 'some' && !first.missingFonts.length) problems.push('expected missing fonts to be reported')
    if (e.needsShellEscape !== undefined && first.needsShellEscape !== e.needsShellEscape) problems.push(`needsShellEscape ${first.needsShellEscape}`)
    if (e.needsShellEscape === undefined && first.needsShellEscape) problems.push('unexpectedly reported as needing shell escape')
    if (e.missingPackages === 'none' && first.missingPackages.length) problems.push(`missing packages: ${first.missingPackages.join(', ')}`)
    if (e.missingPackages === 'some' && !first.missingPackages.length) problems.push('expected missing packages to be reported')

    const ok = problems.length === 0
    const known = !ok && c.knownFailure
    if (!ok && !known) failed++
    results.push({
      case: c.name, result: ok ? 'ok' : known ? 'KNOWN' : 'FAIL',
      first: `${(first.ms / 1000).toFixed(2)}s/${first.passes.length}p`, unchanged: `${(again.ms / 1000).toFixed(2)}s`,
      edit: `${(edit.ms / 1000).toFixed(2)}s/${edit.passes.length}p`, status: first.status, errors: first.errors,
    })
    if (!ok) {
      console.log(`\n${known ? 'KNOWN' : 'FAIL'} ${c.name}: ${problems.join('; ')}${known ? ` (${c.knownFailure})` : ''}`)
      const lines = first.log.split('\n'); const i = lines.findIndex(l => l.startsWith('!'))
      if (i >= 0) console.log(lines.slice(i, i + 4).map(l => '    ' + l).join('\n'))
      if (first.message) console.log('    ' + first.message)
      console.log('    passes: ' + first.passes.join(' → '))
    }
  }
} catch (e) {
  failed++
  console.log(`ERROR: ${e?.message ?? e}`)
  await h.saveArtifacts(String(e?.stack ?? e))
} finally {
  await close()
  server.close()
  h.done()
}
console.log()
console.table(results)
process.exit(failed ? 1 : 0)
