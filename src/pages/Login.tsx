import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { SignInFailed, useAuth, type SignInError } from '../auth'
import { Brand } from '../components/Brand'
import './Login.css'

type Mode = 'office' | 'register'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']

const SIGN_IN_ERRORS: Record<SignInError, string> = {
  'unknown-user': 'We couldn’t find that username in your analytics workspace.',
  'username-required': 'Enter your username.',
  'not-configured': 'Sign-in isn’t set up on this server yet (trusted authentication key missing).',
  'register-not-configured': 'Register sign-in isn’t set up on this server yet.',
  'cluster-idle': 'Your analytics workspace is waking up after a period of inactivity. This takes a few minutes, try again shortly.',
  unavailable: 'Could not reach the sign-in service. Check your connection and try again.',
}

/**
 * Demo sign-in through ThoughtSpot trusted authentication: the server mints a
 * token for the username (an existing ThoughtSpot user). The password is not
 * checked or sent. Register mode signs in as the server's configured register user.
 */
export function Login() {
  const { user, signIn } = useAuth()
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/home'

  const [mode, setMode] = useState<Mode>('office')
  const [username, setUsername] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [keep, setKeep] = useState(true)
  const [store, setStore] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<{ text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const office = mode === 'office'

  if (user) return <Navigate to={from} replace />

  const press = (k: string) => {
    setError(null)
    setPin((p) => (k === '⌫' ? p.slice(0, -1) : k === 'C' ? '' : p.length < 4 ? p + k : p))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!office && (!store.trim() || pin.length < 4)) {
      setError({ text: 'Enter a store code and 4-digit PIN.' })
      return
    }
    if (office && !username.trim()) {
      setError({ text: SIGN_IN_ERRORS['username-required'] })
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signIn({ username: office ? username : undefined, keep, mode })
      navigate(from, { replace: true })
    } catch (err) {
      setError({ text: SIGN_IN_ERRORS[err instanceof SignInFailed ? err.code : 'unavailable'] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <header className="site-header">
        <Brand to="/" large />
        <Link to="/" className="mono-link">
          ← Back to site
        </Link>
      </header>

      <main className="login-main">
        <div className="login-intro">
          <span className="eyebrow">
            <span className="tag">Sign in</span>
            <span>Back office &amp; registers</span>
          </span>
          <h1 className="display login-h1">
            Open the <span className="highlight">doors.</span>
          </h1>
          <p className="login-lede">Sign in to manage every location, or clock a register in with your store code and PIN.</p>
        </div>

        <div className="login-card-wrap">
          <form onSubmit={submit} className="login-card" noValidate>
            <div className="login-modes">
              <button type="button" className={office ? 'is-active' : ''} onClick={() => (setMode('office'), setError(null))}>
                Back office
              </button>
              <button type="button" className={!office ? 'is-active' : ''} onClick={() => (setMode('register'), setError(null))}>
                Register
              </button>
            </div>

            <div className="login-body">
              {office ? (
                <>
                  <label className="field">
                    Username
                    <input
                      type="text"
                      required
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="you@company.com"
                    />
                  </label>
                  <label className="field">
                    Password
                    <span className="field-pw">
                      <input type={showPw ? 'text' : 'password'} autoComplete="off" placeholder="••••••••" />
                      <button type="button" onClick={() => setShowPw((v) => !v)}>
                        {showPw ? 'Hide' : 'Show'}
                      </button>
                    </span>
                  </label>
                  <label className="keep">
                    <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                    <span className="keep-box" aria-hidden />
                    <span>Keep me signed in on this device</span>
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    Store code
                    <input className="store-code" value={store} onChange={(e) => setStore(e.target.value)} placeholder="#014" />
                  </label>
                  <div className="field">
                    <span>Associate PIN</span>
                    <div className="pin-dots" aria-label={`${pin.length} of 4 digits entered`}>
                      {[0, 1, 2, 3].map((i) => (
                        <span key={i} className={i < pin.length ? 'is-filled' : ''} />
                      ))}
                    </div>
                    <div className="pin-pad">
                      {KEYS.map((k) => (
                        <button key={k} type="button" onClick={() => press(k)} aria-label={k === '⌫' ? 'Delete' : k === 'C' ? 'Clear' : k}>
                          {k}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <button type="submit" className="login-submit" disabled={busy}>
                <span>{busy ? 'Signing in…' : office ? 'Sign in' : 'Open register'}</span>
                <span>→</span>
              </button>

              {error && (
                <div className="login-error" role="alert">
                  {error.text}
                </div>
              )}
            </div>

            <div className="login-foot">
              <span>194 / 194 stores online</span>
              <Link to="/#demo">New to Storeloom?</Link>
            </div>

            <div className="login-badge">{office ? 'Secure sign-in' : 'Till mode'}</div>
          </form>
        </div>
      </main>

      <footer className="site-footer">
        <span>© 2026 Storeloom · Demo brand</span>
        <div>
          <span>Status</span>
          <span>Privacy</span>
          <span>Help</span>
        </div>
      </footer>
    </div>
  )
}
