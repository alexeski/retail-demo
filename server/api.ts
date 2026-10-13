import { Readable } from 'node:stream'
import express, { type Request, type Response } from 'express'
import { config } from './config.ts'
import { clearSession, readSession, writeSession } from './session.ts'
import { mintToken, NotConfiguredError, revokeToken, sessionUser, ThoughtSpotError } from './thoughtspot.ts'

/**
 * ThoughtSpot REST calls the browser may make through /api/ts, with the
 * signed-in user's token added here. Anything else is refused.
 */
const PROXY_ALLOWLIST: { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/searchdata$/ },
  { method: 'GET', path: /^\/auth\/session\/user$/ },
  { method: 'POST', path: /^\/ai\/agent\/conversation\/create$/ },
  { method: 'POST', path: /^\/ai\/agent\/conversation\/[\w-]+\/send\/stream$/ },
  { method: 'POST', path: /^\/ai\/agent\/conversation\/[\w-]+\/stop-response$/ },
]

const noStore = (res: Response) => res.set('Cache-Control', 'no-store')

/**
 * Storeloom's API, mounted at /api (by server/index.ts in production and by the
 * Vite dev server in development):
 * - POST /login, POST /logout, GET /session: trusted-auth sign-in;
 * - GET /thoughtspot/token: the token for the SDK's cookieless embeds;
 * - /ts/*: ThoughtSpot REST v2 (Search Data, Spotter) as the signed-in user.
 */
export function createApi() {
  const api = express()
  api.disable('x-powered-by')
  // Behind Coolify's proxy: req.secure reflects the browser's HTTPS.
  api.set('trust proxy', true)
  api.use(express.json({ limit: '256kb' }))

  api.post('/login', async (req: Request, res: Response) => {
    noStore(res)
    const { username: typed, keep, mode } = (req.body ?? {}) as { username?: string; keep?: boolean; mode?: string }
    const username = mode === 'register' ? config().registerUsername : typed?.trim()
    if (!username) {
      return res
        .status(400)
        .json({ error: mode === 'register' ? 'register-not-configured' : 'username-required' })
    }
    try {
      const minted = await mintToken(username)
      const user = await sessionUser(minted.token)
      writeSession(req, res, { ...minted, username: user.name }, keep !== false)
      res.json({ user })
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        console.error('Sign-in unavailable:', err.message)
        return res.status(503).json({ error: 'not-configured' })
      }
      if (err instanceof ThoughtSpotError && err.status < 500) {
        // Unknown user, or one the secret key's org doesn't contain.
        console.warn(`Sign-in refused for "${username}" (${err.status}): ${err.message}`)
        return res.status(401).json({ error: 'unknown-user' })
      }
      console.error('Sign-in failed', err)
      res.status(502).json({ error: 'unavailable' })
    }
  })

  api.post('/logout', async (req: Request, res: Response) => {
    const session = readSession(req)
    clearSession(req, res)
    if (session) await revokeToken(session.token)
    res.status(204).end()
  })

  api.get('/session', async (req: Request, res: Response) => {
    noStore(res)
    const session = readSession(req)
    if (!session) return res.status(401).json({ error: 'signed-out' })
    try {
      res.json({ user: await sessionUser(session.token), expiresAt: session.expiresAt })
    } catch (err) {
      if (err instanceof ThoughtSpotError && (err.status === 401 || err.status === 403)) {
        clearSession(req, res)
        return res.status(401).json({ error: 'signed-out' })
      }
      console.error('Session check failed', err)
      res.status(502).json({ error: 'unavailable' })
    }
  })

  // The Visual Embed SDK's getAuthToken (cookieless trusted auth).
  api.get('/thoughtspot/token', (req: Request, res: Response) => {
    noStore(res)
    const session = readSession(req)
    if (!session) return res.status(401).json({ error: 'signed-out' })
    res.json({ token: session.token, expiresAt: session.expiresAt })
  })

  api.use('/ts', async (req: Request, res: Response) => {
    const session = readSession(req)
    if (!session) return res.status(401).json({ error: 'signed-out' })
    if (!PROXY_ALLOWLIST.some((r) => r.method === req.method && r.path.test(req.path))) {
      return res.status(404).json({ error: 'not-allowed' })
    }

    // Stop the upstream request (e.g. a Spotter stream) if the browser goes away.
    const upstreamAbort = new AbortController()
    res.on('close', () => upstreamAbort.abort())

    try {
      const upstream = await fetch(`${config().host}/api/rest/2.0${req.path}`, {
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: req.get('accept') ?? 'application/json',
          'X-Requested-By': 'ThoughtSpot',
          Authorization: `Bearer ${session.token}`,
        },
        body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
        signal: upstreamAbort.signal,
      })
      res.status(upstream.status)
      const type = upstream.headers.get('content-type')
      if (type) res.set('Content-Type', type)
      if (type?.includes('text/event-stream')) {
        // Let each event through as it arrives.
        res.set({ 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
        res.flushHeaders()
      }
      if (!upstream.body) return res.end()
      Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).pipe(res)
    } catch (err) {
      if (upstreamAbort.signal.aborted) return
      console.error(`ThoughtSpot ${req.method} ${req.path} failed`, err)
      if (!res.headersSent) res.status(502).json({ error: 'unavailable' })
      else res.end()
    }
  })

  return api
}
