// Background service worker: offscreen engine lifecycle, per-origin script registration, badge.
import { STORAGE_KEYS, getStored, mergeSettings } from '../shared/settings'
import type { BackgroundRequest } from '../shared/messages'
import engineConfig from '../../../config/engine.json'

const OFFSCREEN_URL = 'offscreen.html'
const SCRIPT_IDS = { page: 'olr-page', content: 'olr-content' }

let offscreenReady: Promise<void> | null = null
let resolveOffscreenReady: (() => void) | null = null

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })
  return contexts.length > 0
}

async function ensureEngine(): Promise<void> {
  if (offscreenReady && (await hasOffscreen())) return offscreenReady
  offscreenReady = new Promise(r => (resolveOffscreenReady = r))
  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Runs the TeX engine (WebAssembly) that compiles Overleaf projects locally.',
    })
  }
  return offscreenReady
}

async function engineConfigForOffscreen() {
  const settings = mergeSettings(await getStored('settings'))
  return {
    idleMinutes: settings.engineIdleMinutes,
    ctanMirror: settings.ctanMirror,
    basePath: chrome.runtime.getURL('busytex').replace(/\/$/, ''),
    bundles: engineConfig.bundles,
    remoteEndpoint: settings.remoteEndpoint,
    engine: settings.engine,
  }
}

// ---- page scripts on the Overleaf origins the user enabled ----

export function matchesFor(origins: string[]): string[] {
  return origins.map(o => `${o.replace(/\/$/, '')}/project/*`)
}

async function registerScripts() {
  const origins = await getStored('origins')
  const existing = (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id)
  const stale = Object.values(SCRIPT_IDS).filter(id => existing.includes(id))
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale })
  if (!origins.length) return
  const matches = matchesFor(origins)
  await chrome.scripting.registerContentScripts([
    { id: SCRIPT_IDS.page, matches, js: ['page.js'], runAt: 'document_start', world: 'MAIN', allFrames: false },
    { id: SCRIPT_IDS.content, matches, js: ['content.js'], runAt: 'document_start', allFrames: false },
  ])
}

chrome.runtime.onInstalled.addListener(registerScripts)
chrome.runtime.onStartup.addListener(registerScripts)
chrome.storage.onChanged.addListener(changes => {
  if (STORAGE_KEYS.origins in changes) registerScripts()
})

// ---- messages ----

const BADGE: Record<string, { text: string; color: string }> = {
  local: { text: 'L', color: '#138a36' },
  fallback: { text: 'S', color: '#b35c00' },
  idle: { text: '', color: '#000000' },
}

chrome.runtime.onMessage.addListener((msg: BackgroundRequest, sender, sendResponse) => {
  switch (msg.type) {
    case 'ensureEngine':
      ensureEngine().then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String(e) }))
      return true
    case 'closeEngine':
      offscreenReady = null
      chrome.offscreen.closeDocument().catch(() => undefined)
      sendResponse({ ok: true })
      return false
    case 'offscreenReady':
      resolveOffscreenReady?.()
      sendResponse({ ok: true })
      return false
    case 'getEngineConfig':
      engineConfigForOffscreen().then(sendResponse)
      return true
    case 'status': {
      const tabId = sender.tab?.id
      const b = BADGE[msg.state]
      if (tabId !== undefined && b) {
        chrome.action.setBadgeText({ tabId, text: b.text })
        chrome.action.setBadgeBackgroundColor({ tabId, color: b.color })
        chrome.action.setTitle({ tabId, title: `Overleaf local render: ${msg.detail ?? msg.state}` })
      }
      sendResponse({ ok: true })
      return false
    }
  }
})
