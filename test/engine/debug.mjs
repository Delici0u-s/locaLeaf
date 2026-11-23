// Dev tool: compile one folder with the engine in the browser and print the log lines matching a filter.
// Usage: node test/engine/debug.mjs <dir> <main.tex> <pdflatex|xelatex|lualatex> [regex] [--settings '{"engine":{...}}']
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { ROOT, readJson } from '../../scripts/lib.mjs'
import { serve } from '../lib/server.mjs'
import { launch } from '../lib/browser.mjs'

const args = process.argv.slice(2)
const si = args.indexOf('--settings')
const overrides = si >= 0 ? JSON.parse(args.splice(si, 2)[1]) : {}
const [dirArg, main, compiler, filter = '^!|error|warning'] = args
const dir = resolve(dirArg)
const HERE = join(ROOT, 'test/engine')
const engineCfg = readJson('config/engine.json')
const defaults = readJson('config/settings.defaults.json')
await build({ entryPoints: [join(ROOT, 'extension/src/engine/worker.ts')], bundle: true, format: 'iife', outfile: join(HERE, '.build/engine-worker.js'), logLevel: 'warning' })
const server = await serve({ '/ctan/': { proxy: defaults.ctanMirror, cacheDir: join(ROOT, 'test/.cache/ctan') }, '/config/': join(ROOT, 'config'), '/build/': join(HERE, '.build'), '/vendor/busytex/': join(ROOT, engineCfg.vendorDir), '/project/': dir, '/page/': HERE })
const { context, close } = await launch()
try {
  const page = await context.newPage()
  page.setDefaultTimeout(600_000)
  await page.goto(`${server.origin}/page/page.html`)
  await page.waitForFunction(() => window.engineReady)
  await page.evaluate(o => window.engine.init(o), {
    basePath: '/vendor/busytex', bundles: engineCfg.bundles,
    remoteEndpoint: overrides.remoteEndpoint ?? defaults.remoteEndpoint, fontIndexUrl: '/config/font-index.json', texliveIndexUrl: '/config/texlive-files.json.gz', ctanMirror: `${server.origin}/ctan`, settings: { ...defaults.engine, ...overrides.engine },
  })
  const list = d => readdirSync(d).flatMap(n => statSync(join(d, n)).isDirectory() ? list(join(d, n)).map(p => `${n}/${p}`) : [n])
  await page.evaluate(([f]) => window.engine.sync('debug', f, { reset: true }), [list(dir).map(p => ({ path: p, url: `/project/${p}` }))])
  const r = await page.evaluate(([m, c]) => window.engine.compile('debug', { main: m, compiler: c, draft: false, stopOnFirstError: false }), [main, compiler])
  const re = new RegExp(filter, 'i')
  console.log(`missing fonts: ${r.missingFonts.join(', ') || 'none'}`)
  console.log(`status ${r.status}, ${r.errors} errors, passes ${r.passes.join(' → ')}, ${Math.round(r.ms)} ms`)
  console.log('--- log'); console.log(r.log.split('\n').filter(l => re.test(l)).slice(0, 60).join('\n'))
  console.log('--- engine output'); console.log((await page.evaluate(() => window.engine.prints())).filter(l => re.test(l)).slice(0, 60).join('\n'))
} finally {
  await close()
  server.close()
}
