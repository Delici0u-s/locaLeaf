// Helpers for driving a local Overleaf CE (dev/overleaf-ce) in tests: admin account, login, project upload.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from '../../scripts/lib.mjs'

const ENV_FILE = join(ROOT, 'dev/overleaf-ce/.env')

export const OVERLEAF_URL = process.env.OLR_E2E_URL ?? `http://localhost:${process.env.OLR_DEV_PORT ?? 8090}`

/** Test account for the local dev instance; generated once into dev/overleaf-ce/.env (git-ignored). */
export function credentials() {
  const env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  const get = k => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]
  let email = get('OLR_DEV_ADMIN_EMAIL')
  let password = get('OLR_DEV_ADMIN_PASSWORD')
  if (!email || !password) {
    email = 'admin@olr-dev.invalid'
    password = randomBytes(18).toString('base64url')
    appendFileSync(ENV_FILE, `OLR_DEV_ADMIN_EMAIL=${email}\nOLR_DEV_ADMIN_PASSWORD=${password}\n`)
  }
  return { email, password }
}

export async function ensureAdmin(page) {
  const { email, password } = credentials()
  await page.goto(`${OVERLEAF_URL}/launchpad`)
  if (await page.locator('form[data-ol-register-admin]').count()) {
    await page.fill('#email', email)
    await page.fill('#passwordField', password)
    await Promise.all([page.waitForResponse(r => r.url().includes('/launchpad/register_admin')), page.click('form[data-ol-register-admin] button[type=submit]')])
  }
}

export async function login(page) {
  const { email, password } = credentials()
  await page.goto(`${OVERLEAF_URL}/login`)
  if (!page.url().includes('/login')) return
  await page.fill('input[name=email]', email)
  await page.fill('input[name=password]', password)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

/** Zips a folder (files at the zip root) and uploads it as a new project. Returns the project id. */
export async function uploadProject(page, dir, name) {
  const tmp = mkdtempSync(join(tmpdir(), 'olr-e2e-zip-'))
  const zip = join(tmp, `${name}.zip`)
  execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: dir })
  const b64 = readFileSync(zip).toString('base64')
  rmSync(tmp, { recursive: true, force: true })
  if (!page.url().startsWith(OVERLEAF_URL)) await page.goto(`${OVERLEAF_URL}/project`)
  const res = await page.evaluate(async ({ b64, name }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const form = new FormData()
    form.append('name', name)
    form.append('qqfile', new Blob([bytes], { type: 'application/zip' }), `${name}.zip`)
    const csrf = document.querySelector('meta[name="ol-csrfToken"]').content
    const r = await fetch('/project/new/upload', { method: 'POST', body: form, headers: { 'X-Csrf-Token': csrf } })
    return { status: r.status, body: await r.text() }
  }, { b64, name })
  const body = JSON.parse(res.body)
  if (!body.project_id) throw new Error(`upload failed: ${res.status} ${res.body}`)
  return body.project_id
}

/** Sets a project's compiler (pdflatex/xelatex/lualatex/latex) and main document via Overleaf's API. */
export async function setProjectSettings(page, projectId, settings) {
  return page.evaluate(async ({ projectId, settings }) => {
    const csrf = document.querySelector('meta[name="ol-csrfToken"]').content
    const r = await fetch(`/project/${projectId}/settings`, { method: 'POST', body: JSON.stringify(settings), headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': csrf } })
    return r.status
  }, { projectId, settings })
}
