// End-to-end for the "anySite" build: no site built in, access to all sites granted up front. Enabling a site
// the way the popup does (storing it) must make LocaLeaf run there without any permission prompt.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from '../../scripts/lib.mjs'
import { launch } from '../lib/browser.mjs'
import { harness, preflight } from '../lib/harness.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from './overleaf.mjs'

const h = harness('e2e-any-site')
await preflight(OVERLEAF_URL)
const DIST = join(ROOT, 'dist-anysite')
h.step('building with anySite and no built-in sites')
execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs')], { env: { ...process.env, LOCALEAF_SITES: '', LOCALEAF_ANY_SITE: '1', OLR_DIST_DIR: 'dist-anysite' }, stdio: 'ignore' })

const results = []
let failures = 0
const check = async (name, ok, detail = '') => {
  results.push({ check: name, result: ok ? 'ok' : 'FAIL', detail })
  h.step(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
  if (!ok) { failures++; await h.saveArtifacts(`check failed: ${name}`) }
}

const { context, close } = await launch({ extensionDir: DIST })
h.onCleanup(close)
context.setDefaultTimeout(h.stepMs)
try {
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  const origin = new URL(OVERLEAF_URL).origin
  await check('access to the site without a prompt', await sw.evaluate(o => chrome.permissions.contains({ origins: [`${o}/*`] }), origin))

  const setup = await context.newPage()
  await ensureAdmin(setup)
  await login(setup)
  const projectId = await uploadProject(setup, join(ROOT, 'test/e2e/projects/basic'), `e2e-any-site-${Date.now()}`)

  const before = await context.newPage()
  const logsBefore = h.track('not-enabled', before)
  await before.goto(`${OVERLEAF_URL}/project/${projectId}`)
  await before.waitForTimeout(3000)
  await check('not running before the site is enabled', !logsBefore.some(l => l.includes('[localeaf]')))
  await before.close()

  h.step('enabling the site like the popup does')
  // this is a production build (warm-up race on by default); the test checks a local compile, so no race
  await sw.evaluate(o => chrome.storage.local.set({ origins: [o], settings: { raceWhileCold: false } }), origin)
  await h.waitFor('content scripts registered', () => sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then(s => s.length > 0)))

  const page = await context.newPage()
  const logs = h.track('enabled', page)
  await page.goto(`${OVERLEAF_URL}/project/${projectId}`)
  const first = await h.waitFor('a compile result', () => logs.find(l => /compiled .* locally|local compile failed/.test(l)))
  await check('compiles locally once enabled', /locally: success/.test(first), first)
} catch (e) {
  await check('test ran to the end', false, String(e?.stack ?? e).slice(0, 800))
} finally {
  await close()
  h.done()
}
console.table(results)
process.exit(failures ? 1 : 0)
