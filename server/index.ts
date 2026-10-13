import path from 'node:path'
import express from 'express'
import { createApi } from './api.ts'
import { config } from './config.ts'

// Production server: Storeloom's API plus the built single-page app (dist/).
// Runs as TypeScript directly (Node's type stripping, Node 22.18+/24).

const DIST = path.resolve(import.meta.dirname, '../dist')
const PORT = Number(process.env.PORT) || 3000

const app = express()
app.disable('x-powered-by')
// Behind Coolify's proxy (Traefik).
app.set('trust proxy', true)

app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok\n')
})

app.use('/api', createApi())

// Vite's hashed bundles never change in place: cache them for good.
app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y' }), (_req, res) => {
  res.status(404).end()
})
app.use(express.static(DIST, { index: false }))

// Client-side routes (/home, /insights, …) all serve the app shell, never cached
// so a redeploy takes effect on the next load.
app.get('/{*path}', (_req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(DIST, 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  const { host, secretKey, orgId } = config()
  console.log(`Storeloom listening on :${PORT} · ThoughtSpot ${host} · org ${orgId ?? '(secret key default)'}`)
  if (!secretKey) console.warn('THOUGHTSPOT_SECRET_KEY is not set: sign-in will fail until it is.')
})
