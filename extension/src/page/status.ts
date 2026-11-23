// Progress indicator in the page while a local compile runs (loading the project, starting the engine,
// TeX passes, downloads). Appears after settings.statusDelayMs so quick compiles don't flash it.
const STYLE = 'position:fixed;left:1rem;bottom:1rem;z-index:2147483647;max-width:min(32rem,calc(100vw - 2rem));' +
  'display:flex;gap:.6rem;align-items:center;padding:.55rem .85rem;border-radius:.45rem;background:#1f3d2b;color:#fff;' +
  'font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);overflow-wrap:anywhere'
const SPINNER = 'flex:none;width:.9em;height:.9em;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:localeaf-spin .8s linear infinite'

let el: HTMLElement | null = null
let text: HTMLElement | null = null
let showTimer: number | undefined
let current = ''
let startedAt = 0
let tick: number | undefined

function render() {
  if (!text) return
  const s = Math.round((performance.now() - startedAt) / 1000)
  text.textContent = `LocaLeaf — ${current}${s >= 2 ? ` · ${s}s` : ''}`
}

/** Starts a status session; the indicator shows up after delayMs unless finish() came first. */
export function beginStatus(initial: string, delayMs: number) {
  finishStatus()
  current = initial
  startedAt = performance.now()
  showTimer = window.setTimeout(() => {
    if (!document.getElementById('localeaf-spin-style')) {
      const style = document.createElement('style')
      style.id = 'localeaf-spin-style'
      style.textContent = '@keyframes localeaf-spin{to{transform:rotate(360deg)}}'
      document.head.appendChild(style)
    }
    el = document.createElement('div')
    el.setAttribute('role', 'status')
    el.style.cssText = STYLE
    const spinner = document.createElement('span')
    spinner.style.cssText = SPINNER
    text = document.createElement('span')
    el.append(spinner, text)
    document.body.appendChild(el)
    render()
    tick = window.setInterval(render, 1000) // the elapsed time keeps moving even while one step takes long
  }, delayMs)
}

export function updateStatus(message: string) {
  current = message
  render()
}

export function finishStatus() {
  clearTimeout(showTimer)
  clearInterval(tick)
  el?.remove()
  el = null
  text = null
}
