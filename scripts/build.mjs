// Builds the extension into dist/ (load it unpacked from there).
// Sites built in: the Overleaf addresses in localeaf.local.json ({"sites": ["https://overleaf.example.com"]},
// git-ignored) or LOCALEAF_SITES="https://a,https://b" are granted and injected statically, so no permission
// prompt is needed (some browsers never show it; the e2e tests can't click it). The CTAN mirror is added too.
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { ROOT, readJson } from './lib.mjs'

// OLR_DIST_DIR: where to build (the tests use dist-test/, so the dist/ you load in the browser stays untouched)
const DIST = join(ROOT, process.env.OLR_DIST_DIR ?? 'dist')
const SRC = join(ROOT, 'extension/src')
const engine = readJson('config/engine.json')
const pkg = readJson('package.json')
const LOCAL_CONFIG = join(ROOT, 'localeaf.local.json')
const localConfig = existsSync(LOCAL_CONFIG) ? JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8')) : {}
const builtInSites = (process.env.LOCALEAF_SITES !== undefined ? process.env.LOCALEAF_SITES.split(',') : localConfig.sites ?? [])
  .map(s => s.trim()).filter(Boolean).map(s => new URL(s).origin)
// "anySite": true grants access to all sites up front, so "Enable on this site" in the popup never needs a
// permission prompt. LocaLeaf still only runs on the sites you enable.
const anySite = process.env.LOCALEAF_ANY_SITE !== undefined ? process.env.LOCALEAF_ANY_SITE === '1' : localConfig.anySite === true

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

// Icons: the manifest lists the PNG sizes; each is rendered from the one SVG (square, centred, transparent).
const LOGO = join(ROOT, 'extension/icons/localeaf.svg')
mkdirSync(join(DIST, 'icons'), { recursive: true })
copyFileSync(LOGO, join(DIST, 'icons/localeaf.svg'))
for (const [size, rel] of Object.entries(manifest.icons ?? {})) {
  try {
    execFileSync('magick', ['-background', 'none', '-density', String(Math.max(72, Number(size) * 8)), LOGO, '-resize', `${size}x${size}`, '-gravity', 'center', '-extent', `${size}x${size}`, join(DIST, rel)])
  } catch (e) {
    console.error(`rendering ${rel} needs ImageMagick ("magick"): ${e.message}`)
    process.exit(1)
  }
}
manifest.version = pkg.version ?? manifest.version
if (builtInSites.length) {
  const mirror = new URL(readJson('config/settings.defaults.json').ctanMirror).origin
  manifest.host_permissions = [...(manifest.host_permissions ?? []), ...builtInSites.map(o => `${o}/*`), `${mirror}/*`]
  const matches = builtInSites.map(o => `${o}/project/*`)
  manifest.content_scripts = [
    { matches, js: ['page.js'], run_at: 'document_start', world: 'MAIN' },
    { matches, js: ['content.js'], run_at: 'document_start' },
  ]
  console.log(`built-in sites: ${builtInSites.join(', ')}`)
}
if (anySite) {
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'https://*/*', 'http://*/*'])]
  console.log('anySite: access to all sites granted up front (LocaLeaf only runs where you enable it)')
}
writeFileSync(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`built ${DIST}`)
