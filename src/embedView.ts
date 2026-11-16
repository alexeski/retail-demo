// Dialogs inside an embedded dashboard: a chart's Shuttle chat, Schedule, Share,
// Shuttle Highlights, Download PDF, the filter modals.
//
// The dashboards are full-height iframes, many screens tall. ThoughtSpot sizes
// and centres a dialog to the part of the iframe in view when it opens (it asks
// the host page for the iframe's visible region), so with the page scrolled
// mostly away from the dashboard (its title and filters still on screen) a
// dialog is squeezed into the strip of iframe left, and is cut off.
//
// The fix is to show a full screen of the dashboard before the dialog opens:
// scroll the iframe's top just under the sticky filter bar. Jump rather than
// smooth-scroll: a scroll still in progress gets measured too.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The embedded dashboard on the page: Insights' (or an open region's) and a user dashboard's. */
const EMBED_IFRAME = '.insights-embed iframe, .dash-embed iframe'

/** How much of the dashboard may be short of a full screen before it's worth scrolling (px). */
const SLACK = 24

/**
 * Scrolls the embedded dashboard into view if less than a full screen of it is
 * showing; leaves the page alone if it already fills the window (a user who has
 * scrolled partway down a long dashboard keeps their place). Returns whether it scrolled.
 */
export function fitEmbedToScreen(): boolean {
  const iframe = document.querySelector(EMBED_IFRAME)
  if (!iframe) return false
  // Insights' filter bar sticks to the top of the window over the dashboard.
  const barHeight = document.querySelector('.filterbar')?.getBoundingClientRect().height ?? 0
  const rect = iframe.getBoundingClientRect()
  const visible = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, barHeight)
  const wanted = Math.min(rect.height, window.innerHeight - barHeight)
  if (visible >= wanted - SLACK) return false
  window.scrollTo({ top: rect.top + window.scrollY - barHeight, behavior: 'instant' })
  return true
}

/** For a dialog the page opens (a host button's HostEvent): fit the dashboard, and let the scroll settle first. */
export async function prepareForDialog() {
  if (fitEmbedToScreen()) await sleep(150)
}

/**
 * For the embed's `onDialogOpen`, which covers dialogs opened from inside it (a
 * chart's Shuttle button, the ⋯ menu). A stable function: the SDK re-creates the
 * embed when a listener's identity changes.
 */
export const onEmbedDialogOpen = () => {
  fitEmbedToScreen()
}
