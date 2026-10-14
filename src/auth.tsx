import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { SIGNED_OUT_EVENT } from './tsApi'

// Sign-in is ThoughtSpot trusted authentication, done by Storeloom's server
// (server/api.ts): it mints a token for an existing ThoughtSpot user and keeps it
// in an httpOnly cookie. The browser only ever learns who is signed in.

export type StoreloomUser = { name: string; displayName: string; email?: string }

export type SignInError =
  | 'unknown-user'
  | 'not-configured'
  | 'register-not-configured'
  | 'username-required'
  | 'cluster-idle'
  | 'unavailable'

export class SignInFailed extends Error {
  code: SignInError

  constructor(code: SignInError) {
    super(code)
    this.code = code
  }
}

async function postJson(path: string, body?: unknown) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

type AuthContextValue = {
  user: StoreloomUser | null
  /** False until the first session check has answered. */
  ready: boolean
  /** `mode: 'register'` signs in as the server's configured register user. */
  signIn: (params: { username?: string; keep: boolean; mode?: 'office' | 'register' }) => Promise<StoreloomUser>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StoreloomUser | null>(null)
  const [ready, setReady] = useState(false)

  // Resume an existing session (the cookie survives reloads).
  useEffect(() => {
    let cancelled = false
    fetch('/api/session', { headers: { Accept: 'application/json' } })
      .then(async (res) => (res.ok ? ((await res.json()) as { user: StoreloomUser }).user : null))
      .catch(() => null)
      .then((u) => {
        if (cancelled) return
        setUser(u)
        setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The server reports an expired or revoked token on any ThoughtSpot call.
  useEffect(() => {
    const onSignedOut = () => setUser(null)
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut)
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut)
  }, [])

  const signIn = useCallback<AuthContextValue['signIn']>(async ({ username, keep, mode = 'office' }) => {
    let res: Response
    try {
      res = await postJson('/api/login', { username, keep, mode })
    } catch {
      throw new SignInFailed('unavailable')
    }
    const body = (await res.json().catch(() => ({}))) as { user?: StoreloomUser; error?: SignInError }
    if (!res.ok || !body.user) throw new SignInFailed(body.error ?? 'unavailable')
    setUser(body.user)
    return body.user
  }, [])

  const signOut = useCallback(async () => {
    await postJson('/api/logout').catch(() => {})
    setUser(null)
  }, [])

  return <AuthContext.Provider value={{ user, ready, signIn, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth()
  const location = useLocation()
  if (!ready) return null
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <>{children}</>
}

export const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')

// Display names can be login-style ("first.last"), so split on separators too.
export const firstName = (user: StoreloomUser) => {
  const first = (user.displayName || user.name).split(/[\s@._-]+/).find(Boolean) ?? user.name
  return first[0]!.toUpperCase() + first.slice(1)
}
