// Binary data crosses chrome.runtime messaging as base64 (that channel is JSON-only).

const CHUNK = 0x8000

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as any).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let s = ''
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const native = (Uint8Array as any).fromBase64
  if (typeof native === 'function') return native(b64)
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A file's content on the wire: text stays text, bytes become base64. */
export type WireContent = { text: string } | { b64: string }

export function toWire(content: string | Uint8Array): WireContent {
  return typeof content === 'string' ? { text: content } : { b64: toBase64(content) }
}

export function fromWire(w: WireContent): string | Uint8Array {
  return 'text' in w ? w.text : fromBase64(w.b64)
}

export function wireSize(w: WireContent): number {
  return 'text' in w ? w.text.length : w.b64.length
}
