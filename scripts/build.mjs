// Builds the extension into dist/ (load it unpacked from there).
// env: OLR_DEV_ORIGINS="http://localhost:8090,..." also grants and injects into those origins statically
//      (for local development and the e2e tests, where no one can click the permission prompt).
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { ROOT, readJson } from './lib.mjs'

const DIST = join(ROOT, 'dist')
const SRC = join(ROOT, 'extension/src')
const engine = readJson('config/engine.json')
const pkg = readJson('package.json')
const devOrigins = (process.env.OLR_DEV_ORIGINS ?? '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)

const vendor = join(ROOT, engine.vendorDir)
if (!existsSync(join(vendor, '.version'))) {
  console.error(`engine assets missing in ${engine.vendorDir}: run "npm run assets" first`)
  process.exit(1)
}

rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

const common = { bundle: true, target: 'chrome120', sourcemap: 'linked', logLevel: 'warning', legalComments: 'none' }
await Promise.all([
  build({ ...common, entryPoints: [join(SRC, 'background/background.ts')], outfile: join(DIST, 'background.js'), format: 'esm' }),
  build({ ...common, entryPoints: [join(SRC, 'content/content.ts')], outfile: join(DIST, 'content.js'), format: 'iife' }),
  build({ ...common, entryPoints: [join(SRC, 'page/main.ts')], outfile: join(DIST, 'page.js'), format: 'iife' }),
  build({ ...common, entryPoints: [join(SRC, 'offscreen/offscreen.ts')], outfile: join(DIST, 'offscreen.js'), format: 'iife' }),
  build({ ...common, entryPoints: [join(SRC, 'engine/worker.ts')], outfile: join(DIST, 'engine-worker.js'), format: 'iife' }),
  build({ ...common, entryPoints: [join(SRC, 'popup/popup.ts')], outfile: join(DIST, 'popup.js'), format: 'iife' }),
])
cpSync(join(ROOT, 'extension/static'), DIST, { recursive: true })
cpSync(join(ROOT, 'config/font-index.json'), join(DIST, 'font-index.json'))
cpSync(join(ROOT, 'config/texlive-files.json.gz'), join(DIST, 'texlive-files.json.gz'))

// Engine assets: only what config/engine.json lists (hard links when possible; they're large).
const assets = join(DIST, 'busytex')
mkdirSync(assets)
const names = [...engine.engineFiles, ...engine.bundles.flatMap(b => [`${b}.js`, `${b}.data`])]
for (const name of names) {
  try { linkSync(join(vendor, name), join(assets, name)) } catch { copyFileSync(join(vendor, name), join(assets, name)) }
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'))
manifest.version = pkg.version ?? manifest.version
if (devOrigins.length) {
  const mirror = new URL(readJson('config/settings.defaults.json').ctanMirror).origin
  manifest.host_permissions = [...(manifest.host_permissions ?? []), ...devOrigins.map(o => `${o}/*`), `${mirror}/*`]
  const matches = devOrigins.map(o => `${o}/project/*`)
  manifest.content_scripts = [
    { matches, js: ['page.js'], run_at: 'document_start', world: 'MAIN' },
    { matches, js: ['content.js'], run_at: 'document_start' },
  ]
  console.log(`dev origins: ${devOrigins.join(', ')}`)
}
writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`built ${DIST}`)
