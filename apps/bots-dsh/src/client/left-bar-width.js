// -------------------------------------------------------------------------
// The new left bar's column width. The bar is a 320 px panel (the rail's 56 and the list's 264,
// left-bar-css.js) standing 8 px in on its ground, so its column is 336; DSH opens its sidebar
// column at 280: DSH 0.2.2's layout
// (dsh-client-ui-layout) seeds that width on every start, saves none, and offers no way to set
// one but its own drag handle. So the bar moves the handle once, the way a drag does, whenever
// the column stands at DSH's own width: on the first start, and when a fold and reopen puts it
// back there. A width the person drags to is theirs: it is kept here, in this browser, and
// that width is the one restored, never the bar's over it.
//
// Only the wide column moves: the phone's drawer and a folded column stay DSH's. If DSH's handle
// or its width ever change, nothing matches and the column stays as DSH draws it
// (test/left-bar-width.test.js pins both against the harness).

export const DSH_WIDTH = 280
export const BAR_WIDTH = 336
// DSH's own bounds for a dragged column (dsh-client-ui-layout columns.ts SIDEBAR_MIN, SIDEBAR_MAX).
const MIN = 264
const MAX = 420
export const WIDTH_KEY = 'automagik.leftBar.width'

const COLUMN = '[class*="_sidebarCol"]'
const FRAME = '[class*="_frame"]'
const HANDLE = '[class*="_handle"][data-side="sidebar"]'

/** The width a person chose, if one was kept and DSH would take it; else null. */
export function keptWidth(storage) {
  try {
    const value = Number(storage?.getItem(WIDTH_KEY))
    return Number.isFinite(value) && value >= MIN && value <= MAX ? Math.round(value) : null
  } catch {
    return null
  }
}

/**
 * How far to move the handle, in px, or 0. Only an open, wide column standing at DSH's own width
 * moves, and only toward the person's kept width, else the bar's.
 */
export function widthMove({ width, kept, drawer, collapsed, dragging }) {
  if (drawer || collapsed || dragging) return 0
  if (Math.round(width) !== DSH_WIDTH) return 0
  return (kept ?? BAR_WIDTH) - DSH_WIDTH
}

/** Watches the shell's frame and moves its sidebar handle as widthMove says. Returns the disposer. */
export function installBarWidth({ doc = globalThis.document, storage = globalThis.localStorage } = {}) {
  // Where the page cannot drive the handle (no pointer events, no frames, no observers: a test's
  // stand-in document), the column stays DSH's and nothing else is touched.
  const view = doc?.defaultView
  if (!doc?.body || ['PointerEvent', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'].some(name => typeof view?.[name] !== 'function')) return () => {}
  let frame = 0
  let sized = null
  let watched = null
  const parts = () => {
    const shell = doc.querySelector(FRAME)
    return { shell, column: shell?.querySelector(COLUMN), handle: shell?.querySelector(HANDLE) }
  }
  const apply = () => {
    frame = 0
    const { shell, column, handle } = parts()
    if (!shell || !column) return
    watch(shell, column)
    const move = widthMove({
      width: column.getBoundingClientRect().width,
      kept: keptWidth(storage),
      drawer: shell.hasAttribute('data-sidebar-drawer'),
      collapsed: shell.hasAttribute('data-sidebar-collapsed'),
      dragging: shell.hasAttribute('data-dragging') || shell.hasAttribute('data-animating'),
    })
    if (move === 0 || !handle) return
    // DSH's handle (AppFrame.tsx DragHandle): a press, then a release `move` px away, sets the
    // column through the layout's own setSidebar, so the right column and the composer follow.
    const x = handle.getBoundingClientRect().left + 4
    const at = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
    handle.dispatchEvent(new view.PointerEvent('pointerdown', { ...at, buttons: 1, clientX: x }))
    handle.dispatchEvent(new view.PointerEvent('pointerup', { ...at, buttons: 0, clientX: x + move }))
  }
  const later = () => { frame ||= view.requestAnimationFrame(apply) }
  // Until the shell's frame is there, the page is watched for it; then only the frame's state
  // and the column's width are. The width settles after DSH's own fold and open animation.
  const arrival = new view.MutationObserver(later)
  arrival.observe(doc.body, { subtree: true, childList: true })
  const states = new view.MutationObserver(later)
  const watch = (shell, column) => {
    if (watched === column) return
    watched = column
    arrival.disconnect()
    states.disconnect()
    states.observe(shell, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-sidebar-drawer', 'data-dragging', 'data-animating'] })
    // A frame DSH draws again (another surface) is found again.
    arrival.observe(shell.parentNode ?? doc.body, { childList: true })
    sized?.disconnect()
    if (typeof view.ResizeObserver !== 'function') return
    sized = new view.ResizeObserver(later)
    sized.observe(column)
  }
  // A drag the person makes is theirs: keep where it lands.
  const released = (event) => {
    if (!event.isTrusted || !(event.target instanceof view.Element) || !event.target.closest(HANDLE)) return
    view.requestAnimationFrame(() => {
      const { shell, column } = parts()
      if (!shell || !column || shell.hasAttribute('data-sidebar-drawer') || shell.hasAttribute('data-sidebar-collapsed')) return
      try { storage?.setItem(WIDTH_KEY, String(Math.round(column.getBoundingClientRect().width))) } catch {}
    })
  }
  doc.addEventListener('pointerup', released, true)
  later()
  return () => {
    if (frame) view.cancelAnimationFrame(frame)
    arrival.disconnect()
    states.disconnect()
    sized?.disconnect()
    doc.removeEventListener('pointerup', released, true)
  }
}
