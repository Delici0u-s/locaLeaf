// A small notice in the page (sized by its text, kept inside the viewport).
const STYLE = 'position:fixed;left:1rem;bottom:1rem;z-index:2147483647;max-width:min(32rem,calc(100vw - 2rem));' +
  'padding:.6rem .9rem;border-radius:.4rem;background:#2b2b2b;color:#fff;font:13px/1.4 system-ui,sans-serif;' +
  'box-shadow:0 2px 8px rgba(0,0,0,.3);overflow-wrap:anywhere'

export function showToast(text: string, ms = 0) {
  const el = document.createElement('div')
  el.setAttribute('role', 'status')
  el.style.cssText = STYLE
  el.textContent = `Overleaf local render — ${text}`
  document.body.appendChild(el)
  if (ms > 0) setTimeout(() => el.remove(), ms)
  else el.addEventListener('click', () => el.remove())
}
