// Puts the pinned BusyTeX release into vendor/busytex (once). Reuses an existing copy from
// bench/assets/busytex when it has the same version, otherwise downloads the release tarball.
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, readJson } from './lib.mjs'

const cfg = readJson('config/engine.json')
const vendor = join(ROOT, cfg.vendorDir)
const stamp = join(vendor, '.version')

if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === cfg.busytexVersion) {
  console.log(`engine assets ${cfg.busytexVersion} already in ${cfg.vendorDir}`)
  process.exit(0)
}
rmSync(vendor, { recursive: true, force: true }) // only ever holds downloaded release files
mkdirSync(vendor, { recursive: true })

const benchCopy = join(ROOT, 'bench/node_modules/texlyre-busytex/package.json')
const benchAssets = join(ROOT, 'bench/assets/busytex')
if (existsSync(benchCopy) && existsSync(benchAssets) && readJson('bench/node_modules/texlyre-busytex/package.json').version === cfg.busytexVersion) {
  for (const name of readdirSync(benchAssets)) {
    try { linkSync(join(benchAssets, name), join(vendor, name)) } catch { copyFileSync(join(benchAssets, name), join(vendor, name)) }
  }
  console.log(`linked engine assets from bench/assets/busytex`)
} else {
  const url = cfg.releaseUrl.replace('{version}', cfg.busytexVersion)
  const tarball = join(vendor, 'assets.tar.gz')
  console.log(`downloading ${url}`)
  execFileSync('curl', ['-fL', '--progress-bar', '-o', tarball, url], { stdio: 'inherit' })
  const tmp = join(vendor, 'extract')
  mkdirSync(tmp)
  execFileSync('tar', ['-xzf', tarball, '-C', tmp])
  const inner = join(tmp, 'busytex')
  for (const name of readdirSync(inner)) execFileSync('mv', [join(inner, name), vendor])
  rmSync(tmp, { recursive: true })
  rmSync(tarball)
}
writeFileSync(stamp, cfg.busytexVersion + '\n')
