// Manual exploration helper: opens a project with the extension and saves a screenshot + console log.
import { join } from 'node:path'
import { ROOT } from '../../scripts/lib.mjs'
import { EXTENSION_DIR, launch } from '../lib/browser.mjs'
import { OVERLEAF_URL, ensureAdmin, login, uploadProject } from './overleaf.mjs'

const { context, close } = await launch({ extensionDir: EXTENSION_DIR })
const page = await context.newPage()
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
try {
  await ensureAdmin(page)
  await login(page)
  const id = await uploadProject(page, join(ROOT, 'test/e2e/projects/basic'), `explore-${Date.now()}`)
  await page.goto(`${OVERLEAF_URL}/project/${id}`)
  await page.waitForTimeout(Number(process.env.WAIT ?? 20000))
  await page.screenshot({ path: process.argv[2] ?? 'explore.png' })
  console.log(`project ${id}`)
} finally {
  console.log(logs.filter(l => /local-render|error|Error/.test(l)).slice(0, 40).join('\n'))
  await close()
}
