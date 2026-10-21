import { displayStore, type DisplayScale } from './demoConfig'

// Scales the whole app, ThoughtSpot embeds included, the way a browser zoom
// would: on a laptop, at 100%, Studio and the dashboards have little room. CSS
// `zoom` on <html>, set from the /config page's Display size (default `auto`).
//
// Under `zoom`, 100vh is still the window's height in unzoomed pixels, so it
// covers only part of the window: full-height styles use
// calc(100vh / var(--app-zoom)), and code that measures the window converts
// with appZoom() (see useFillHeight).

/** Widths below this count as a laptop screen for `auto`. */
const LAPTOP_MAX_WIDTH = 1600

const resolve = (scale: DisplayScale) => (scale === 'auto' ? (window.innerWidth < LAPTOP_MAX_WIDTH ? 0.8 : 1) : scale)

/** The zoom in effect: 1 means none. */
export const appZoom = () => Number(getComputedStyle(document.documentElement).zoom) || 1

function apply() {
  const zoom = resolve(displayStore.get().scale)
  const root = document.documentElement
  root.style.zoom = zoom === 1 ? '' : String(zoom)
  root.style.setProperty('--app-zoom', String(zoom))
}

/** Applies the display size now, and again when it changes (here, in another tab, or the window's width). */
export function startDisplayScale() {
  apply()
  displayStore.subscribe(apply)
  window.addEventListener('resize', () => {
    if (displayStore.get().scale === 'auto') apply()
  })
}
