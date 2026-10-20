# Storeloom

Retail demo app (React + Vite) with ThoughtSpot embedded: dashboards via the Visual Embed SDK, live KPIs via the Search Data API, and the Shuttle assistant on headless Spotter (Spotter Agent API).

## Authentication

Sign-in uses ThoughtSpot **trusted authentication**, with the same approach as the HR demo:

1. `/login` sends the username to the server (`server/`), which mints a 24-hour full-access token for that **existing** ThoughtSpot user with the instance's secret key (`auto_create` off). The password field is not checked.
2. The token lives in an httpOnly `sl_session` cookie. The browser only learns who is signed in.
3. Embeds use cookieless trusted auth (`AuthType.TrustedAuthTokenCookieless`): the SDK fetches the token from `/api/thoughtspot/token`. Shuttle's answer charts are upgraded to authenticated embeds by `startAutoMCPFrameRenderer`.
4. ThoughtSpot REST calls (Search Data, Spotter) go through `/api/ts/*`. The server adds the token, allows only the endpoints the app uses, and relays Spotter's stream as it arrives.

No ThoughtSpot browser session or third-party cookie is needed. Anyone who can reach the app and knows a valid ThoughtSpot username can sign in as that user, which is acceptable for a demo but not beyond one.

The Register (store code + PIN) sign-in signs in as `THOUGHTSPOT_REGISTER_USERNAME` when it is set.

## Dashboards and Studio

Signed-in users can build their own dashboards (Liveboards) on the Retail Sales model, the one the rest of the app uses. The model is fixed: Search hides its data-source picker, and Shuttle builds on dashboards that start from that model.

- **`/dashboards`**: the user's own dashboards (created by them and still theirs, newest first), plus the two ways to start one. Each card opens the dashboard, opens it in Studio, or deletes it.
- **`/dashboards/:id`**: one dashboard, embedded and fully interactive, with Shuttle Highlights, PDF download and Ask Shuttle questions taken from its tiles.
- **`/studio?mode=search|ai&dashboard=<id>`**: the builder, for a new dashboard (no `dashboard`) or one of the user's own.
  - **Search**: the dashboard fills the workspace; Search (with its column panel; the source can't be changed) and the pin panel sit in a drawer on its left that collapses to a rail. The first pin creates the dashboard (`HostEvent.Pin` with `newLiveboardName`). A pinned chart stays *linked*: each later edit to the search (query, chart type) updates that same chart after a short pause. ThoughtSpot always pins a copy, so the link is Storeloom's: the server swaps the chart's answer for Search's current TML in place, keeping its position and size (`POST /api/dashboards/:id/tiles/:vizId`). If the account can't import TML, Studio pins a fresh copy and removes the previous one instead.
  - **Editing a chart already on the dashboard**: *Edit in Search* in the chart's ⋯ menu (or ✎ in the drawer's list, or *Edit in Studio* on the dashboard page). Search can only open a saved Answer with its chart settings, so the server copies the chart into a private draft Answer (`POST …/tiles/:vizId/draft`), Search opens it linked to the chart, and the draft is deleted when editing ends (drafts a closed tab leaves behind are swept after two hours). ThoughtSpot's own Edit, Edit a copy and Delete are hidden from the charts' menus; *Remove from dashboard* replaces Delete in Studio.
  - **Shuttle**: SpotterViz, branded as Shuttle, in the dashboard's edit mode, with its own toolbar (Save, Cancel) and chat panel. The SDK has no data-source setting for SpotterViz: it works from the data sources of the charts already on the dashboard. So a new dashboard starts from a brief and a "Sales · last 12 months" starter tile, pinned from a hidden Search on the Retail Sales model; an empty dashboard gets the same tile before the panel opens. Every prompt Studio sends (the brief, the panel's starter prompts) also says to use only the "Industry Demo - Retail Sales" model.

The Shuttle launcher is hidden in Studio (its drawer and SpotterViz would compete with it) and shows everywhere else, including the dashboard page. Dashboard titles rename in place (✎) on the dashboard page and in Studio. Server side (`server/dashboards.ts`), every route checks that the signed-in user is the dashboard's author (ThoughtSpot's `owner` header field is the object's own GUID); updating, removing a chart and renaming all round-trip the dashboard's TML. ThoughtSpot needs:

- **SpotterViz** enabled on the cluster (Early Access: ask ThoughtSpot Support) for Shuttle mode.
- For in-place tile updates, removing charts and renaming, **Can download data** (TML export) and **Can manage data** (TML import). Without them, updates and removals fall back to the embed's own Pin and Remove, and renaming isn't available.

## Demo controls (`/config`)

An unlinked page at `/config` (no sign-in needed) with presenter controls, saved in the browser's localStorage and applied live to any open tab:

- **Shuttle metering**: on/off, current plan (Growth 500, Scale 2,500, Enterprise unlimited), questions used and allowed, plus shortcuts (one left, at limit, reset). Defaults to Growth with 400 of 500 used; use *One left* or *At limit* to bring up the upgrade flow. Each question sent to Spotter uses one; replies Shuttle handles itself (picking a store to act on) don't.
- **Account & rep**: the customer company and the account rep shown in the upgrade flow.
- **Hotkeys**: record a combo (with ⌘, Ctrl or ⌥) and a phrase; pressing it anywhere types the phrase into the focused field and copies it.

At the limit, Shuttle shows an upgrade flow: plan comparison (monthly or annual), booking a plan review with the rep (with a downloadable calendar invite), or a card checkout with proration. Everything is simulated: a "purchase" only changes the local plan settings, and card details stay in the page (pre-filled with the standard 4242 test card, autofill off, never stored or sent).

## Development

```bash
cp .env.example .env.local   # then fill in THOUGHTSPOT_SECRET_KEY
npm install
npm run dev                  # http://localhost:5173, app and API in one process
```

| Variable | Kind | Notes |
| --- | --- | --- |
| `THOUGHTSPOT_SECRET_KEY` | server, **secret** | Trusted-auth key (Develop → Customizations → Security Settings). Required. |
| `THOUGHTSPOT_ORG_ID` | server | `0` is the Primary org. Unset: the secret key's org. |
| `THOUGHTSPOT_REGISTER_USERNAME` | server | Optional. User for the Register sign-in. |
| `THOUGHTSPOT_HOST` | server | Optional. Defaults to `VITE_TS_HOST`. |
| `VITE_TS_HOST` | build | Default `https://thoughtspotpmm.thoughtspot.cloud` |
| `VITE_INSIGHTS_LIVEBOARD_ID` | build | Default `1a387932-6c25-4e3d-a61a-62803d40ed71` |
| `VITE_REGION_LIVEBOARD_ID` | build | Default `0fc762ea-2a1e-4368-927c-a3caf6ed9d23` |

`VITE_*` values are inlined into the client bundle at build time. The server values are read at runtime.

`npm run build` type-checks the app and the server and builds the client into `dist/`. `npm start` runs the production server (`server/index.ts`, run directly by Node 22.18+/24 with native type stripping) on http://localhost:3000, serving the API and `dist/`. It loads `.env.local` when present; variables already set in the environment win. The Docker image runs the server directly and never reads an env file.

## Docker

`Dockerfile` is a multi-stage build on Node 24 Alpine. The builder runs `npm run build`; the runtime installs production dependencies only and runs `node server/index.ts` as the `node` user on port **3000**. `/healthz` returns 200 for the health check.

For local testing, `compose.yaml` and these scripts read everything from `.env.local`: build args for the `VITE_*` values and runtime variables for the server:

```bash
npm run docker:up     # build + run in the background on http://localhost:3100
npm run docker:logs   # tail its output
npm run docker:down   # stop and remove it
```

`compose.yaml` is local-only. Coolify builds the `Dockerfile` directly.

## Deploying with Coolify

1. **New Resource → Application**, pick the Git repository and branch, and set **Build Pack: Dockerfile**.
2. **Ports Exposes: `3000`** (the default). Set your domain under **Domains** (e.g. `https://storeloom.example.com`); Coolify provisions TLS.
3. **Environment variables**, split across two Coolify settings:
   - **Runtime only** (leave **"Build Variable?"** unticked): `THOUGHTSPOT_SECRET_KEY`, `THOUGHTSPOT_ORG_ID`, and optionally `THOUGHTSPOT_REGISTER_USERNAME`. These are never passed into the Docker build. If the key is missing, the server logs a warning at startup and sign-in returns "not set up". Check the application logs, not the build logs.
   - **Build-time** (tick **"Build Variable?"**, optional): any `VITE_*` overrides. Redeploy after changing one.

ThoughtSpot side (**Develop → Customizations → Security Settings**):

- **Trusted authentication** enabled (that is where the secret key comes from).
- The deployed domain in the **CSP visual embed hosts**, so the cluster can be iframed there, and in the **CORS whitelisted domains**, for the SDK's own calls.
- Serve the app over **HTTPS**: the session cookie is marked `Secure` whenever the request arrives over HTTPS (Coolify's proxy forwards that).
