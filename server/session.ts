import type { Request, Response } from 'express'
import type { MintedToken } from './thoughtspot.ts'

// The signed-in user's ThoughtSpot token lives in an httpOnly cookie, so page
// scripts never read it from storage; the SDK gets it on demand from
// /api/thoughtspot/token for the cookieless embeds.

const COOKIE = 'sl_session'

export type Session = MintedToken

/** The current session, or null if missing, unreadable or (nearly) expired. */
export function readSession(req: Request): Session | null {
  const raw = req.headers.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
  if (!raw) return null
  try {
    const s = JSON.parse(Buffer.from(decodeURIComponent(raw), 'base64url').toString('utf8')) as Session
    // A minute of slack so a token never expires mid-request.
    return s.token && s.username && s.expiresAt > Date.now() + 60_000 ? s : null
  } catch {
    return null
  }
}

/** `persistent`: survive a browser restart (until the token expires); otherwise a browser-session cookie. */
export function writeSession(req: Request, res: Response, session: Session, persistent: boolean) {
  res.cookie(COOKIE, Buffer.from(JSON.stringify(session)).toString('base64url'), {
    httpOnly: true,
    // HTTPS as the browser sees it (behind Coolify's proxy, via X-Forwarded-Proto;
    // the app trusts the proxy). Plain-HTTP localhost still works for development.
    secure: req.secure,
    sameSite: 'lax',
    path: '/',
    ...(persistent ? { expires: new Date(session.expiresAt) } : {}),
  })
}

export function clearSession(req: Request, res: Response) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/' })
}
