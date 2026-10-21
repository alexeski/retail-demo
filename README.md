# Storeloom

Retail demo app (React + Vite) with ThoughtSpot embedded: dashboards via the Visual Embed SDK, live KPIs via the Search API, and the Shuttle assistant on headless Spotter.

There is no backend and no secrets. Sign-in reuses the visitor's own ThoughtSpot browser session on the configured cluster, so log in to ThoughtSpot in the same browser first.

## Dashboards and Studio

Signed-in users can build their own dashboards (Liveboards) on the Retail Sales model, the one the rest of the app uses. The model is fixed: Search hides its data-source picker, and ShuttleViz builds on dashboards that start from that model.

- **`/dashboards`**: the two ways to start a dashboard, then two lists. *My dashboards*: the ones the user created (and still owns), to open, edit in Studio or delete. *Shared with you*: others' dashboards on the Retail Sales model (the model's dependents) that the user can open; ThoughtSpot only returns those shared with them, or every one for an administrator. Each opens read-only, or *Clone & edit* copies it (TML export, then import as new) into a dashboard of the user's and opens it in Studio.
- **`/dashboards/:id`**: one dashboard, embedded and fully interactive, with Shuttle Highlights, PDF download and Ask Shuttle questions taken from its tiles. On a shared dashboard: no rename or edit, and *Clone & edit* instead (also offered by Studio when it's opened on a dashboard that isn't the user's).
- **`/studio?mode=search|ai&dashboard=<id>`**: the builder, for a new dashboard (no `dashboard`) or one of the user's own.
  - **Search**: the dashboard fills the workspace; Search (with its column panel; the source can't be changed) and the pin panel sit in a drawer on its left that collapses to a rail. The first pin creates the dashboard (`HostEvent.Pin` with `newLiveboardName`). A pinned chart stays *linked*: each later edit to the search (query, chart type) updates that same chart after a short pause. ThoughtSpot always pins a copy, so the link is Storeloom's: Studio swaps the chart's answer for Search's current TML in place, keeping its position and size. If the account can't import TML, Studio pins a fresh copy and removes the previous one instead.
  - **Editing a chart already on the dashboard**: *Edit in Search* in the chart's ⋯ menu (or ✎ in the drawer's list, or *Edit in Studio* on the dashboard page). Search can only open a saved Answer with its chart settings, so Studio copies the chart into a private draft Answer, Search opens it linked to the chart, and the draft is deleted when editing ends (drafts a closed tab leaves behind are swept after two hours). ThoughtSpot's own Edit, Edit a copy and Delete are hidden from the charts' menus; *Remove from dashboard* replaces Delete in Studio.
  - **ShuttleViz**: SpotterViz, branded as ShuttleViz (Shuttle, the stores' assistant, is Spotter), in the dashboard's edit mode, with its own toolbar (Save, Cancel) and chat panel. The SDK has no data-source setting for SpotterViz: it works from the data sources of the charts already on the dashboard. So a new dashboard starts from a brief and a "Sales · last 12 months" starter tile, pinned from a hidden Search on the Retail Sales model; an empty dashboard gets the same tile before the panel opens. Every prompt Studio sends (the brief, the panel's starter prompts) also says to use only the "Industry Demo - Retail Sales" model.

The Shuttle launcher is hidden in Studio (its drawer and SpotterViz would compete with it) and shows everywhere else, including the dashboard page. Dashboard titles rename in place (✎) on the dashboard page and in Studio. The browser calls ThoughtSpot's REST API v2 directly with the visitor's session cookie (`src/dashboards.ts`), like the embeds. Changes are limited to dashboards the signed-in user is the author of (ThoughtSpot's `owner` header field is the object's own GUID), and ThoughtSpot enforces its own permissions on every call; updating, removing a chart, renaming and cloning all round-trip the dashboard's TML. ThoughtSpot needs:

- **SpotterViz** enabled on the cluster (Early Access: ask ThoughtSpot Support) for ShuttleViz mode.
- For in-place tile updates, removing charts and renaming, **Can download data** (TML export) and **Can manage data** (TML import). Without them, updates and removals fall back to the embed's own Pin and Remove, and renaming isn't available.

### Brief (`/studio/brief`): the same, over ThoughtSpot's Spotter MCP Server

A third way to build, as a conversation, that doesn't touch Studio. It runs on the Spotter MCP Server's tools (`src/tsMcp.ts`), which the page calls itself (no LLM in between): the user briefs ShuttleViz, `create_dashboard` answers with a plan and the data it chose, nothing is built until the user approves it (or picks one of the designer's choices), progress is relayed while `get_dashboard_status` is polled, and the finished dashboard appears beside the conversation. From there each message is a `modify_dashboard` (layout, styling, new charts, notes, groups, tabs). Three ways in: *Describe it*; *Explore first*, where questions go to Spotter (`create_analysis_session`, `send_session_message`, `get_session_updates`), its charts show inline and the ones kept become the dashboard (`create_dashboard` with `answers`); and *Rebuild one*, from the description of a dashboard in another tool. *Storeloom style* sends the brand colours as hex codes. *The numbers* tab shows the rows behind each chart (`get_data`, offered only when the user has Can download data). *✎ Brief* on a dashboard card starts a conversation about that dashboard.

The page asks ThoughtSpot for a bearer token from the visitor's session (`GET /api/rest/2.0/auth/session/token`) and keeps it in the tab's sessionStorage until it expires or the user signs out: the MCP server stores designer tasks and Spotter sessions under the token, and ThoughtSpot issues a new one on every request, so one token has to last the whole conversation (that's what lets a reload pick up a build in progress). It sends it to `https://agent.thoughtspot.app/token/mcp` with `x-ts-host`. The MCP server sends no CORS headers, so the browser reaches it through this app's origin: `/ts-mcp` is a plain pass-through (Vite's dev proxy, and `nginx.conf` in the container). The tool contract is pinned with `api-version=2026-10-14`.

## Demo controls (`/config`)

An unlinked page at `/config` (no sign-in needed) with presenter controls, saved in the browser's localStorage and applied live to any open tab:

- **Shuttle metering**: on/off, current plan (Growth 500, Scale 2,500, Enterprise unlimited), questions used and allowed, plus shortcuts (one left, at limit, reset). Defaults to Growth with 400 of 500 used; use *One left* or *At limit* to bring up the upgrade flow. Each question sent to Spotter uses one; replies Shuttle handles itself (picking a store to act on) don't.
- **Account & rep**: the customer company and the account rep shown in the upgrade flow.
- **Hotkeys**: record a combo (with ⌘, Ctrl or ⌥) and a phrase; pressing it anywhere types the phrase into the focused field and copies it.
- **Display size**: scales the whole app, embedded dashboards included, like the browser's zoom (CSS `zoom` on `<html>`, `src/displayScale.ts`). *Auto* (the default) is 80% on screens under 1,600 px wide (laptops) and 100% above; or pick 100%, 90%, 80% or 75%. Full-height styles divide `100vh` by `--app-zoom`, since `vh` ignores the zoom.

At the limit, Shuttle shows an upgrade flow: plan comparison (monthly or annual), booking a plan review with the rep (with a downloadable calendar invite), or a card checkout with proration. Everything is simulated: a "purchase" only changes the local plan settings, and card details stay in the page (pre-filled with the standard 4242 test card, autofill off, never stored or sent).

## Development

```bash
npm install
npm run dev        # http://localhost:5173
```

Configuration is optional. Copy `.env.example` to `.env.local` to point at a different cluster or Liveboards. All `VITE_*` values are build-time and get inlined into the bundle:

| Variable | Default |
| --- | --- |
| `VITE_TS_HOST` | `https://thoughtspotpmm.thoughtspot.cloud` |
| `VITE_INSIGHTS_LIVEBOARD_ID` | `1a387932-6c25-4e3d-a61a-62803d40ed71` |
| `VITE_REGION_LIVEBOARD_ID` | `0fc762ea-2a1e-4368-927c-a3caf6ed9d23` |

## Docker

`Dockerfile` is a multi-stage build. Node 22 Alpine runs `npm run build`, and unprivileged nginx serves `dist/` on port **3000**. Client-side routes fall back to `index.html`, and `/healthz` returns 200 for the health check.

For local testing, `compose.yaml` and these scripts read build args from `.env.local` (copy `.env.example` first):

```bash
npm run docker:up     # build + run in the background on http://localhost:3100
npm run docker:logs   # tail its output
npm run docker:down   # stop and remove it
```

`compose.yaml` is local-only. Coolify builds the `Dockerfile` directly.

## Deploying with Coolify

1. **New Resource → Application**, pick the Git repository and branch, and set **Build Pack: Dockerfile**.
2. **Ports Exposes: `3000`** (the default). Set your domain under **Domains** (e.g. `https://storeloom.example.com`); Coolify provisions TLS.
3. **Environment variables** (optional, since defaults apply): add any `VITE_*` overrides with **"Build Variable?"** ticked. They only take effect at build time, so redeploy after changing one. There are no runtime-only variables.

ThoughtSpot side (**Develop → Customizations → Security Settings**) for the deployed domain:

- Add it to the **CORS whitelisted domains**. The app calls the REST API from the browser with the session cookie.
- Add it to the **CSP visual embed hosts**, so the cluster can be iframed there.
- Serve it over **HTTPS**. The cross-site ThoughtSpot session cookie (`SameSite=None; Secure`) is only sent from secure origins. Browsers that block third-party cookies will make the embeds and live KPIs fail, so allow cookies for the cluster or use Chrome with default settings.
