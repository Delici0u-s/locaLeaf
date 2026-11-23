// Progress chip in the page while a local compile runs (loading the project, starting the engine, TeX passes,
// downloads). Appears after settings.statusDelayMs so quick compiles don't flash it. Placed per
// settings.statusPosition: next to Overleaf's download button ("toolbar"), a screen corner, or where the user
// dragged it ("custom", stored as fractions of the window size so it stays inside on resize).
// The chip always floats over the page (never inserted into Overleaf's React-managed toolbar), and anything
// unexpected about the toolbar makes it fall back to settings.statusFallbackPosition instead of failing.
import type { Settings, StatusPosition } from '../shared/settings'

const BASE = 'z-index:2147483647;display:flex;gap:.6rem;align-items:center;border-radius:.45rem;background:#1f3d2b;color:#fff;' +
  'font:13px/1.4 system-ui,sans-serif;overflow-wrap:anywhere;user-select:none;cursor:grab;touch-action:none'
const FLOATING = 'position:fixed;max-width:min(32rem,calc(100vw - 2rem));padding:.55rem .85rem;box-shadow:0 2px 10px rgba(0,0,0,.3)'
const INLINE = 'position:fixed;padding:.2rem .6rem;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
const GAP_PX = 8 // space between the download button and the chip
const MIN_CHIP_PX = 120 // narrower than this the text isn't readable: use the fallback corner instead
const SPINNER = 'flex:none;width:.9em;height:.9em;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:localeaf-spin .8s linear infinite'
const MARGIN = '1rem'

let el: HTMLElement | null = null
let text: HTMLElement | null = null
let showTimer: number | undefined
let current = ''
let startedAt = 0
let tick: number | undefined
let settings: Pick<Settings, 'statusPosition' | 'statusFallbackPosition' | 'statusX' | 'statusY'> = { statusPosition: 'toolbar', statusFallbackPosition: 'bottom-left', statusX: -1, statusY: -1 }
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

/** Where the chip goes in "toolbar" mode: right of Overleaf's download button, vertically centred on it, as wide
 *  as the toolbar row leaves room for. Null when the button isn't there or has no usable box (UI changed). */
function toolbarSlot(): { left: number; top: number; height: number; maxWidth: number } | null {
  try {
    const link = document.querySelector('a[aria-label="Download PDF"], button[aria-label="Download PDF"]')
    const r = link?.getBoundingClientRect()
    if (!r || r.width === 0 || r.height === 0) return null
    // room to the right: the first box around the button (the PDF pane's toolbar) that leaves enough of it
    const left = r.right + GAP_PX
    let box = link!.parentElement
    while (box && box.getBoundingClientRect().right - left < MIN_CHIP_PX) box = box.parentElement
    if (!box) return null
    const maxWidth = Math.min(box.getBoundingClientRect().right, innerWidth) - left - GAP_PX
    if (maxWidth < MIN_CHIP_PX) return null
    return { left, top: r.top + r.height / 2, height: r.height, maxWidth }
  } catch {
    return null
  }
}

function corner(pos: StatusPosition): string {
  const [v, hz] = (pos.includes('-') ? pos : 'bottom-left').split('-')
  return `${v}:${MARGIN};${hz}:${MARGIN}`
}

/** Puts the chip where the settings say; called again on resize and every second (the toolbar can move). */
function place(chip: HTMLElement) {
  if (!chip.isConnected) document.body.appendChild(chip)
  if (chip.dataset.dragged) return
  const slot = settings.statusPosition === 'toolbar' ? toolbarSlot() : null
  if (slot) {
    chip.style.cssText = `${BASE};${INLINE};left:${slot.left}px;max-width:${slot.maxWidth}px`
    chip.style.top = `${slot.top - chip.getBoundingClientRect().height / 2}px`
    return
  }
  const pos = settings.statusPosition === 'toolbar' ? settings.statusFallbackPosition : settings.statusPosition
  if (pos === 'custom' && settings.statusX >= 0 && settings.statusY >= 0) {
    chip.style.cssText = `${BASE};${FLOATING};left:0;top:0`
    moveTo(chip, settings.statusX * innerWidth, settings.statusY * innerHeight)
  } else {
    chip.style.cssText = `${BASE};${FLOATING};${corner(pos === 'custom' ? settings.statusFallbackPosition : pos)}`
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
        chip.dataset.dragged = '1' // stop the toolbar / corner placement from pulling it back
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
      settings = { ...settings, statusPosition: 'custom', statusX: b.left / innerWidth, statusY: b.top / innerHeight }
      delete chip.dataset.dragged
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
    // the elapsed time keeps moving even while one step takes long; the toolbar can move (panels resized)
    tick = window.setInterval(() => { render(); if (el) place(el) }, 1000)
  }, delayMs)
}

window.addEventListener('resize', () => { if (el) place(el) })

export function updateStatus(message: string) {
  current = message
  render()
}

/** Shows the chip for a moment where it will appear (after the position setting changed). If a compile is
 *  running, its chip just moves there. */
export function previewStatus(ms: number) {
  if (el) {
    place(el)
    return
  }
  beginStatus('the progress indicator appears here', 0)
  window.setTimeout(() => { if (current === 'the progress indicator appears here') finishStatus() }, ms)
}

export function finishStatus() {
  clearTimeout(showTimer)
  clearInterval(tick)
  el?.remove()
  el = null
  text = null
}
