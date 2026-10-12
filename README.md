# Storeloom

Retail demo app (React + Vite) with ThoughtSpot embedded: dashboards via the Visual Embed SDK, live KPIs via the Search API, and the Shuttle assistant on headless Spotter.

There is no backend and no secrets. Sign-in reuses the visitor's own ThoughtSpot browser session on the configured cluster, so log in to ThoughtSpot in the same browser first.

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
