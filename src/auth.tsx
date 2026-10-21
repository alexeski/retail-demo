import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { actionTracker } from './actionTracker'
import { forgetMcpSession } from './tsMcp'
import { THOUGHTSPOT_HOST } from './thoughtspot'

export type StoreloomUser = { name: string; displayName: string; email?: string }

type TsSessionUser = { name: string; display_name: string; email?: string | null }

/**
 * The cluster is idle (auto-paused after inactivity): it answers with its
 * "Idle Screen" page while it resumes, which takes a few minutes.
 */
export class ClusterIdleError extends Error {}

/** The user signed in to the ThoughtSpot cluster in this browser, or null if there is no session. */
export async function fetchThoughtSpotUser(): Promise<StoreloomUser | null> {
  const res = await fetch(`${THOUGHTSPOT_HOST}/api/rest/2.0/auth/session/user`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) throw new Error(`Session check failed (${res.status})`)
  if (!res.headers.get('content-type')?.includes('json')) {
    const text = await res.text()
    if (/idle screen|back up momentarily/i.test(text)) throw new ClusterIdleError('ThoughtSpot cluster is idle and resuming')
    throw new Error('Unexpected response from the session check')
  }
  const u: TsSessionUser = await res.json()
  return { name: u.name, displayName: u.display_name, email: u.email ?? undefined }
}

const STORAGE_KEY = 'storeloom.user'

function readStoredUser(): StoreloomUser | null {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(STORAGE_KEY)
      if (raw) return JSON.parse(raw)
    } catch {
      // Storage can be unavailable (private mode, blocked site data).
    }
  }
  return null
}

function writeStoredUser(user: StoreloomUser | null, keep = false) {
  for (const store of [sessionStorage, localStorage]) {
    try {
      store.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
  }
  if (!user) return
  try {
    ;(keep ? localStorage : sessionStorage).setItem(STORAGE_KEY, JSON.stringify(user))
  } catch {
    // ignore
  }
}

type AuthContextValue = {
  user: StoreloomUser | null
  signIn: (user: StoreloomUser, keep: boolean) => void
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StoreloomUser | null>(readStoredUser)

  const signIn = useCallback((u: StoreloomUser, keep: boolean) => {
    writeStoredUser(u, keep)
    // Tracked actions last one signed-in session: each sign-in starts a fresh demo.
    actionTracker.reset()
    setUser(u)
  }, [])

  const signOut = useCallback(() => {
    writeStoredUser(null)
    forgetMcpSession()
    actionTracker.reset()
    setUser(null)
  }, [])

  // A remembered Storeloom sign-in is only valid while the same ThoughtSpot session is.
  useEffect(() => {
    if (!user) return
    let cancelled = false
    fetchThoughtSpotUser()
      .then((ts) => {
        if (!cancelled && (!ts || ts.name !== user.name)) signOut()
      })
      .catch(() => {
        // Network trouble: keep the user signed in rather than bouncing them.
      })
    return () => {
      cancelled = true
    }
    // Only re-check when the signed-in identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.name, signOut])

  return <AuthContext.Provider value={{ user, signIn, signOut }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const location = useLocation()
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
