// Page → content script requests over window.postMessage.
import { EXT_CHANNEL, PAGE_CHANNEL, type PageRequest } from '../shared/messages'

let nextId = 0
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.channel !== EXT_CHANNEL) return
  const { id, ok, value, error } = event.data
  const w = waiting.get(id)
  if (!w) return
  waiting.delete(id)
  if (ok) w.resolve(value)
  else w.reject(new Error(error))
})

export function ext<T = unknown>(req: PageRequest): Promise<T> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    window.postMessage({ channel: PAGE_CHANNEL, id, req }, window.location.origin)
  })
}

/** Overleaf's <meta name="ol-…"> values (JSON-typed ones are parsed, like Overleaf's getMeta). */
export function getMeta(name: string): any {
  const el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
  if (!el) return undefined
  return el.dataset.type === 'json' ? JSON.parse(el.content) : el.content
}

export function whenDomReady(): Promise<void> {
  return document.readyState === 'loading' ? new Promise(r => document.addEventListener('DOMContentLoaded', () => r(), { once: true })) : Promise.resolve()
}
