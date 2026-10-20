import { Action, AuthType, init, startAutoMCPFrameRenderer } from '@thoughtspot/visual-embed-sdk'

// VITE_* values are inlined at build time (Docker build args in Coolify). `||`
// rather than `??`: an unset Docker ARG arrives as an empty string.
export const THOUGHTSPOT_HOST =
  import.meta.env.VITE_TS_HOST || 'https://thoughtspotpmm.thoughtspot.cloud'

/** "Retail Sales with Muze - copy - TSE" (tabs 01, 03 and 04). */
export const INSIGHTS_LIVEBOARD_ID =
  import.meta.env.VITE_INSIGHTS_LIVEBOARD_ID || '1a387932-6c25-4e3d-a61a-62803d40ed71'

/** Region Performance Liveboard, embedded per region on the Store Performance tab. */
export const REGION_LIVEBOARD_ID =
  import.meta.env.VITE_REGION_LIVEBOARD_ID || '0fc762ea-2a1e-4368-927c-a3caf6ed9d23'

/**
 * "Industry Demo - Retail Sales" model: what the Insights Liveboards, Shuttle and
 * the KPIs use, and the only data source the dashboard builder offers.
 */
export const RETAIL_MODEL_ID = '11e40743-9285-42bd-856d-3f81a755c4f6'

export type PlaceholderTile = { title: string; sub: string; kind: string; span: number; h: string }

export type InsightsTab = {
  label: string
  /** Liveboard tab ID on the main Insights Liveboard. */
  tabId?: string
  /** Region rows with the Region Performance Liveboard (Store Performance tab). */
  regions?: boolean
  /** Three starter questions for Shuttle, grounded in what the tab shows. */
  questions: string[]
  placeholder?: PlaceholderTile[]
}

// Labels and order follow the Storeloom Insights design.
export const INSIGHTS_TABS: InsightsTab[] = [
  {
    label: 'Exec KPIs',
    tabId: '852bb05d-3dfa-4aab-ac39-da07cd47e8a0',
    // Sales by State · Sales by Month · Sales vs Gross Profit by region · the KPI row.
    questions: [
      'What drove the change in sales versus the previous month?',
      'Which states contributed most to sales over the last 12 months?',
      'Which region has the best gross margin, and how far ahead is it?',
    ],
  },
  {
    label: 'Store Performance',
    regions: true,
    // Region KPIs · foot traffic per store · sales per sq ft vs store space.
    questions: [
      'Which stores have the lowest sales per square foot?',
      'Which store type has the highest average ticket size?',
      'Which regions had the biggest month-over-month change in sales?',
    ],
  },
  {
    label: 'Category & Brand',
    tabId: 'e46419b6-9bdc-4061-9410-9d483dab1b48',
    // Monthly sales by category · category mix (department, brand) · margins · ticket and basket.
    questions: [
      'Which categories have the lowest gross margin last month?',
      'Which departments grew fastest over the last 6 months?',
      'What are the top 5 brands by sales, and what are their gross margins?',
    ],
  },
  {
    label: 'Customers & Basket',
    tabId: '41fb73b8-4841-425c-9906-c7db95dd28e3',
    // Ticket size by age group · demographics · acquisition timeline · loyalty · income.
    questions: [
      'Which age group spends the most per transaction?',
      'How has the number of new customers changed year over year?',
      'Do longer-standing customers have higher ticket sizes and purchase frequency?',
    ],
  },
]

/**
 * Vendor-branded actions hidden from every embedded dashboard, so the app reads
 * as one product. The per-chart AI button (Action.AskAi) stays, relabelled
 * "Shuttle" below; AI Highlights stays too (the Insights page triggers it, as
 * "Shuttle Highlights").
 */
export const HIDDEN_BRANDED_ACTIONS = [Action.SpotterOnLiveboard, Action.SpotterViz, Action.SpotIQAnalyze]

// Retail-sales theme for every embedded ThoughtSpot object. The cluster must allow
// cdn.jsdelivr.net (CSP style-src) and fonts.googleapis.com / fonts.gstatic.com
// (style-src / font-src) for it to load.
export const THOUGHTSPOT_CSS_URL =
  'https://cdn.jsdelivr.net/gh/jhegele-ts/industry-demos-assets@main/retail-sales/styles.css'

// Icon overrides (public/thoughtspot/icons.svg): the Shuttle (Spotter) icon becomes
// the Storeloom mark. Served by jsDelivr from this repo, pinned to a commit so a
// change ships with a new URL rather than waiting on the CDN's cache.
export const THOUGHTSPOT_ICONS_URL =
  'https://cdn.jsdelivr.net/gh/alexeski/retail-demo@9015fdbca71496eb050cac4d52420c93327a4574/public/thoughtspot/icons.svg'

// Let the host page show through behind the Liveboard's tiles.
const CSS_VARIABLES = {
  '--ts-var-root-background': 'transparent',
  '--ts-var-liveboard-layout-background': 'transparent',
  '--ts-var-liveboard-header-background': 'transparent',
  '--ts-var-liveboard-cross-filter-layout-background': 'transparent',
  // Chart-tile buttons (custom actions, Shuttle, ⋯) use these as their
  // hover / pressed *background*; the theme's near-black values hid the
  // dark button text. Light sand tones from the same theme instead.
  '--ts-var-liveboard-header-action-button-hover-color': '#E7E1D8',
  '--ts-var-liveboard-header-action-button-active-color': '#D7D1C8',
}

// Selectors may need updating after a ThoughtSpot upgrade.
const CSS_RULES = {
  // Vendor footer ("Powered by …") under embedded content.
  '[class*="embed-module__footerWrapper"]': { display: 'none !important' },
  // The charts' Shuttle chat (a modal). In full-height embeds ThoughtSpot lets
  // its conversation grow instead of scrolling, so once it's taller than the
  // modal the whole modal scrolls, and the question bar (placed at the bottom
  // of the chat) scrolls away with it or covers the latest answer. Make the
  // conversation the scroll area instead: the bar stays fixed at the bottom of
  // the modal, and the padding lets every answer scroll fully above it.
  '.chat-module__convAssistModalContent .chat-module__globalLoader': {
    flex: '1 1 0 !important',
    'min-height': '0 !important',
    'overflow-y': 'auto !important',
  },
  '.chat-module__convAssistModalContent .chat-module__chatItemsWrapperContainer': {
    'padding-bottom': '170px !important',
  },
}

// The Liveboard header has to stay mounted for HostEvent.OpenFilter to work
// (it drives the filter chips), but the host app renders its own title,
// actions and filter bar, so hide ThoughtSpot's.
const HIDE_LIVEBOARD_HEADER = {
  '[data-testid="pinboard-header"]': { display: 'none !important' },
  '[class*="pinboard-header-module__tabAndFilterWrapper"]': { display: 'none !important' },
}

/**
 * Per-embed customizations that keep ThoughtSpot's Liveboard header visible:
 * the dashboard builder needs its edit toolbar, which hosts the SpotterViz
 * (Shuttle) button and the Save / Cancel controls. The SDK merges `customCSS`
 * shallowly, so the shared variables and rules are repeated here.
 */
export const WITH_LIVEBOARD_HEADER = {
  style: {
    customCSS: {
      variables: {
        ...CSS_VARIABLES,
        // Edit toolbar in the Storeloom palette: ink outline, periwinkle hover.
        '--ts-var-liveboard-edit-toolbar-border': '#17150f',
        '--ts-var-liveboard-edit-toolbar-selected-background': '#17150f',
        '--ts-var-liveboard-edit-toolbar-selected-text-color': '#f4efe4',
        '--ts-var-liveboard-edit-toolbar-text': '#17150f',
        '--ts-var-liveboard-edit-toolbar-hover-background': '#b8c6ff',
        '--ts-var-liveboard-edit-toolbar-hover-text-color': '#17150f',
      },
      rules_UNSTABLE: CSS_RULES,
    },
  },
}

/** The signed-in user's trusted-auth token, from Storeloom's server (httpOnly session cookie). */
async function getAuthToken(): Promise<string> {
  const res = await fetch('/api/thoughtspot/token', { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`No ThoughtSpot token (${res.status})`)
  return ((await res.json()) as { token: string }).token
}

let started = false

/**
 * Cookieless trusted authentication: every embed uses the signed-in user's token
 * as a bearer token, so no ThoughtSpot session or third-party cookie is needed.
 * Call once a user is signed in. The app's origin must be in the cluster's CSP
 * visual-embed hosts and CORS allowlist (Develop > Security Settings).
 */
export function initThoughtSpot() {
  if (started) return
  started = true
  init({
    thoughtSpotHost: THOUGHTSPOT_HOST,
    authType: AuthType.TrustedAuthTokenCookieless,
    getAuthToken,
    // Fetch a fresh token before the current one expires.
    autoLogin: true,
    customizations: {
      // Interface text inside the embeds: the AI assistant is Shuttle, dashboards
      // are dashboards.
      // Case-sensitive substring replacement; user-authored titles aren't touched.
      content: {
        strings: {
          Spotter: 'Shuttle',
          'AI Highlights': 'Shuttle Highlights',
          'AI highlights': 'Shuttle highlights',
          Liveboards: 'dashboards',
          Liveboard: 'dashboard',
          ThoughtSpot: 'Storeloom',
        },
        stringIDs: {
          // The chart Shuttle button's tooltip while ThoughtSpot still checks access
          // to the data (it shows even once the button works): say what it does.
          'permission.requestDataAccess': 'Ask Shuttle about this chart: why the numbers moved, and follow-up questions on its data.',
        },
      },
      iconSpriteUrl: THOUGHTSPOT_ICONS_URL,
      style: {
        customCSSUrl: THOUGHTSPOT_CSS_URL,
        customCSS: {
          variables: CSS_VARIABLES,
          rules_UNSTABLE: { ...HIDE_LIVEBOARD_HEADER, ...CSS_RULES },
        },
      },
    },
  })
  // Shuttle's answer charts are iframes marked tsmcp=true: upgrade each one to an
  // authenticated embed as it appears (they can't use the token on their own).
  startAutoMCPFrameRenderer()
}
