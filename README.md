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

`npm run build` type-checks the app and the server and builds the client into `dist/`. `npm start` runs the production server (`server/index.ts`, run directly by Node 22.18+/24 with native type stripping), which serves the API and `dist/`.

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
