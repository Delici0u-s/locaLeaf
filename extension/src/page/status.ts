// Progress chip in the page while a local compile runs (loading the project, starting the engine, TeX passes,
// downloads). Appears after settings.statusDelayMs so quick compiles don't flash it. Placed per
// settings.statusPosition: a screen corner, inline next to Overleaf's download button ("toolbar"), or where the
// user dragged it ("custom", stored as fractions of the window size so it stays inside on resize).
import type { Settings, StatusPosition } from '../shared/settings'

const BASE = 'z-index:2147483647;display:flex;gap:.6rem;align-items:center;border-radius:.45rem;background:#1f3d2b;color:#fff;' +
  'font:13px/1.4 system-ui,sans-serif;overflow-wrap:anywhere;user-select:none;cursor:grab;touch-action:none'
const FLOATING = 'position:fixed;max-width:min(32rem,calc(100vw - 2rem));padding:.55rem .85rem;box-shadow:0 2px 10px rgba(0,0,0,.3)'
const INLINE = 'position:relative;max-width:min(28rem,40vw);padding:.2rem .6rem;margin-left:.5rem;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
const SPINNER = 'flex:none;width:.9em;height:.9em;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:localeaf-spin .8s linear infinite'
const MARGIN = '1rem'

let el: HTMLElement | null = null
let text: HTMLElement | null = null
let showTimer: number | undefined
let current = ''
let startedAt = 0
let tick: number | undefined
let settings: Pick<Settings, 'statusPosition' | 'statusX' | 'statusY'> = { statusPosition: 'bottom-left', statusX: -1, statusY: -1 }
let onMoved: (x: number, y: number) => void = () => {}

/** Placement settings, and where to report a drag (fractions of the window). */
export function configureStatus(s: typeof settings, moved: (x: number, y: number) => void) {
  settings = s
  onMoved = moved
}

function render() {
  if (!text) return
  const s = Math.round((performance.now() - startedAt) / 1000)
  text.textContent = `LocaLeaf — ${current}${s >= 2 ? ` · ${s}s` : ''}`
}

/** Overleaf's download button; the chip goes right after its toolbar item. */
function toolbarAnchor(): Element | null {
  const link = document.querySelector('a[aria-label="Download PDF"], button[aria-label="Download PDF"]')
  if (!link) return null
  // the direct child of the toolbar row that contains the link
  let item: Element = link
  while (item.parentElement && getComputedStyle(item.parentElement).display !== 'flex') item = item.parentElement
  return item.parentElement ? item : null
}

function corner(pos: StatusPosition): string {
  const [v, hz] = (pos.includes('-') ? pos : 'bottom-left').split('-')
  return `${v}:${MARGIN};${hz}:${MARGIN}`
}

function place(chip: HTMLElement) {
  const anchor = settings.statusPosition === 'toolbar' ? toolbarAnchor() : null
  if (anchor) {
    chip.style.cssText = `${BASE};${INLINE}`
    anchor.after(chip)
    return
  }
  document.body.appendChild(chip)
  if (settings.statusPosition === 'custom' && settings.statusX >= 0 && settings.statusY >= 0) {
    chip.style.cssText = `${BASE};${FLOATING};left:0;top:0`
    moveTo(chip, settings.statusX * innerWidth, settings.statusY * innerHeight)
  } else {
    chip.style.cssText = `${BASE};${FLOATING};${corner(settings.statusPosition)}`
  }
}

/** Positions the chip's top-left at (x, y), kept fully inside the window. */
function moveTo(chip: HTMLElement, x: number, y: number) {
  const r = chip.getBoundingClientRect()
  chip.style.left = `${Math.max(0, Math.min(x, innerWidth - r.width))}px`
  chip.style.top = `${Math.max(0, Math.min(y, innerHeight - r.height))}px`
  chip.style.right = chip.style.bottom = 'auto'
}

/** Dragging the chip (in any mode) moves it and saves the spot as the "custom" position. */
function makeDraggable(chip: HTMLElement) {
  chip.addEventListener('pointerdown', down => {
    const r = chip.getBoundingClientRect()
    const dx = down.clientX - r.left
    const dy = down.clientY - r.top
    let moved = false
    down.preventDefault()
    chip.style.cursor = 'grabbing'
    const move = (e: PointerEvent) => {
      if (!moved) {
        moved = true
        // leave the toolbar / corner: float where the pointer is
        if (chip.parentElement !== document.body) document.body.appendChild(chip)
        chip.style.cssText = `${BASE};${FLOATING};left:${r.left}px;top:${r.top}px;cursor:grabbing`
      }
      moveTo(chip, e.clientX - dx, e.clientY - dy)
    }
    // on the window: re-parenting the chip (leaving the toolbar) would drop a pointer capture on it
    const up = () => {
      window.removeEventListener('pointermove', move)
      chip.style.cursor = 'grab'
      if (!moved) return
      const b = chip.getBoundingClientRect()
      settings = { statusPosition: 'custom', statusX: b.left / innerWidth, statusY: b.top / innerHeight }
      onMoved(settings.statusX, settings.statusY)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  })
}

/** Starts a status session; the chip shows up after delayMs unless finishStatus() came first. */
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
    el.title = 'LocaLeaf: drag to move'
    const spinner = document.createElement('span')
    spinner.style.cssText = SPINNER
    text = document.createElement('span')
    el.append(spinner, text)
    render()
    place(el)
    makeDraggable(el)
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
