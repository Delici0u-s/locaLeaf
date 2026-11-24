// Runs in the page (via page.evaluate): draws labelled boxes over elements for README screenshots.
// Positions come from the elements' measured boxes; labels are kept inside the viewport.
// items: [{ selector | rect, label, side: 'below' | 'right' | 'inside-bottom', clone?: true }]
// clone: also copy the element into the overlay, so it stays in the picture if the page removes it meanwhile.
// Returns the box (x, y, width, height) that holds every annotated element and label.
export function annotate({ items, color, gap }) {
  document.getElementById('__annotations')?.remove()
  const root = document.createElement('div')
  root.id = '__annotations'
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  document.body.appendChild(root)
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
  const grow = r => {
    bounds.left = Math.min(bounds.left, r.left); bounds.top = Math.min(bounds.top, r.top)
    bounds.right = Math.max(bounds.right, r.right); bounds.bottom = Math.max(bounds.bottom, r.bottom)
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))
  for (const item of items) {
    const el = item.selector ? document.querySelector(item.selector) : null
    const r = el ? el.getBoundingClientRect() : item.rect
    if (!r) throw new Error(`annotate: nothing matches ${item.selector}`)
    if (item.clone && el) {
      const copy = el.cloneNode(true)
      copy.style.position = 'fixed'
      copy.style.left = `${r.left}px`; copy.style.top = `${r.top}px`
      copy.style.width = `${r.width}px`; copy.style.height = `${r.height}px`
      copy.style.margin = '0'; copy.style.transform = 'none'
      root.appendChild(copy)
    }
    const box = document.createElement('div')
    box.style.cssText = `position:fixed;left:${r.left - gap / 2}px;top:${r.top - gap / 2}px;width:${r.width + gap}px;height:${r.height + gap}px;border:3px solid ${color};border-radius:8px;box-sizing:border-box`
    root.appendChild(box)
    grow(box.getBoundingClientRect())
    const tag = document.createElement('div')
    tag.textContent = item.label
    tag.style.cssText = `position:fixed;max-width:28em;background:${color};color:#fff;font:600 15px/1.3 system-ui,sans-serif;padding:6px 10px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.25)`
    root.appendChild(tag)
    const t = tag.getBoundingClientRect()
    const vw = innerWidth, vh = innerHeight
    let left, top
    if (item.side === 'right') { left = r.right + gap; top = r.top + r.height / 2 - t.height / 2 }
    else if (item.side === 'inside-bottom') { left = r.left + r.width / 2 - t.width / 2; top = r.bottom - t.height - gap * 2 }
    else { left = r.left + r.width / 2 - t.width / 2; top = r.bottom + gap }
    tag.style.left = `${clamp(left, gap, vw - t.width - gap)}px`
    tag.style.top = `${clamp(top, gap, vh - t.height - gap)}px`
    grow(tag.getBoundingClientRect())
  }
  return { x: Math.max(0, bounds.left - gap), y: Math.max(0, bounds.top - gap), width: bounds.right - bounds.left + 2 * gap, height: bounds.bottom - bounds.top + 2 * gap }
}
