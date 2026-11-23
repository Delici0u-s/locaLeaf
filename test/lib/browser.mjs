// Launches the test browser (Brave by default, the browser this is built for) with a throwaway profile.
// env: OLR_TEST_BROWSER=/path/to/chromium-like, OLR_TEST_HEADED=1
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const CANDIDATES = ['brave-browser', 'brave', 'chromium', 'chromium-browser', 'google-chrome']

export function findBrowser() {
  if (process.env.OLR_TEST_BROWSER) return process.env.OLR_TEST_BROWSER
  for (const name of CANDIDATES) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim() } catch {}
  }
  return undefined
}

export async function launch({ extensionDir } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'olr-test-profile-'))
  const args = extensionDir ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] : []
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: findBrowser(),
    headless: !process.env.OLR_TEST_HEADED,
    args,
  })
  const close = async () => { await context.close(); rmSync(profile, { recursive: true, force: true }) }
  return { context, close }
}
