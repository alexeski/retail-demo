# Storeloom

Retail demo app (React + Vite) with ThoughtSpot embedded: dashboards via the Visual Embed SDK, live KPIs via the Search API, and the Shuttle assistant on headless Spotter.

There is no backend and no secrets. Sign-in reuses the visitor's own ThoughtSpot browser session on the configured cluster, so log in to ThoughtSpot in the same browser first.

## Dashboard Lab (`/lab`)

Signed-in users can build their own dashboards (Liveboards) on the Retail Sales model, the one the rest of the app uses (*Dashboard Lab · Beta* in the top bar). The model is fixed: Search hides its data-source picker, and ShuttleViz builds on that model only.

- **`/lab`**: the two ways to start a dashboard (Search or ShuttleViz), then two lists. *My dashboards*: the ones the user created (and still owns), to open, edit or delete. *Shared with you*: others' dashboards on the Retail Sales model (the model's dependents) that the user can open; ThoughtSpot only returns those shared with them, or every one for an administrator. Each opens read-only, or *Clone & edit* copies it (TML export, then import as new) into a dashboard of the user's.
- **`/lab/dashboards/:id`**: one dashboard, embedded and fully interactive, with Shuttle Highlights, PDF download and Ask Shuttle questions taken from its tiles. On a shared dashboard: no rename or edit, and *Clone & edit* instead.
- **`/lab/studio?mode=search&dashboard=<id>`**: Search, for a new dashboard (no `dashboard`) or one of the user's own. The dashboard fills the workspace; Search (with its column panel) and the pin panel sit in a drawer on its left that collapses to a rail. The first pin creates the dashboard (`HostEvent.Pin` with `newLiveboardName`). A pinned chart stays *linked*: each later edit to the search updates that same chart after a short pause, by swapping the chart's answer for Search's current TML in place. *Edit in Search* in a chart's ⋯ menu copies it into a private draft Answer that Search opens linked to the chart; the draft is deleted when editing ends (drafts a closed tab leaves behind are swept after two hours). ThoughtSpot's own Edit, Edit a copy and Delete are hidden from the charts' menus; *Remove from dashboard* replaces Delete.
- **`/lab/shuttleviz/new`, then `/lab/shuttleviz/<id>`**: ShuttleViz, a conversation (`src/pages/LabBuilder.tsx`) that drives ThoughtSpot's Spotter MCP Server tools (`src/tsMcp.ts`) itself, with no LLM in between. Its Search / ShuttleViz switch moves between the two on the same dashboard.
  - **Describe it**: a new dashboard starts on a brief screen (starters, the Dashboard picker and Name in the bar). `create_dashboard` creates the (empty) dashboard and answers with a plan and the data it chose. Nothing is built until the user approves it (or picks one of the designer's choices). Progress is relayed while `get_dashboard_status` is polled, and the dashboard appears when it's saved.
  - **Explore first**: questions go to Spotter (`create_analysis_session`, `send_session_message`, `get_session_updates`). Its charts show inline and, once kept, on a draft board beside the conversation. *Make it a dashboard* sends the kept ones to `create_dashboard` as `answers`.
  - **Changing a dashboard**: each message is a `modify_dashboard` (layout, styling, new charts, notes, groups, tabs), and the embedded dashboard reloads when it's saved. *Full view* folds the conversation away.
  - **Edit by hand**: the same dashboard in ThoughtSpot's edit mode, with the SpotterViz button hidden so every instruction in words still goes through the conversation. The two take turns: no editing while ShuttleViz works, and no messages to ShuttleViz until the edits are saved or cancelled.
  - **The numbers**: the rows behind each chart of the saved dashboard (`get_data`), offered only when the user has Can download data.
  - Each conversation is kept for the tab (per address), so a reload picks up a plan or a build in progress.

Dashboard titles rename in place (✎). The Shuttle launcher is hidden in Search and ShuttleViz (their own panels would compete with it). Changes are limited to dashboards the signed-in user is the author of, and ThoughtSpot enforces its own permissions on every call; updating, removing a chart, renaming and cloning all round-trip the dashboard's TML. ThoughtSpot needs **Can download data** (TML export) and **Can manage data** (TML import) for in-place tile updates, removing charts and renaming; without them, updates and removals fall back to the embed's own Pin and Remove, and renaming isn't available.

The browser calls ThoughtSpot's REST API v2 directly with the visitor's session cookie (`src/dashboards.ts`), like the embeds. For the MCP server it asks ThoughtSpot for a bearer token from that session (`GET /api/rest/2.0/auth/session/token`) and keeps it in the tab's sessionStorage until it expires or the user signs out: the MCP server stores designer tasks and Spotter sessions under the token, and ThoughtSpot issues a new one on every request, so one token has to last the whole conversation. It sends it to `https://agent.thoughtspot.app/token/mcp` with `x-ts-host`. The MCP server sends no CORS headers, so the browser reaches it through this app's origin: `/ts-mcp` is a plain pass-through (Vite's dev proxy, and `nginx.conf` in the container). The tool contract is pinned with `api-version=2026-10-14`.

## Demo controls (`/config`)

An unlinked page at `/config` (no sign-in needed) with presenter controls, saved in the browser's localStorage and applied live to any open tab:

- **Shuttle metering**: on/off, current plan (Growth 500, Scale 2,500, Enterprise unlimited), questions used and allowed, plus shortcuts (one left, at limit, reset). Defaults to Growth with 494 of 500 used; use *One left* or *At limit* to bring up the upgrade flow. Each question sent to Spotter uses one; replies Shuttle handles itself (picking a store to act on) don't.
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
