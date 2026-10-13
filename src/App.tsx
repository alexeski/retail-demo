import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AuthProvider, RequireAuth } from './auth'
import { AppBar } from './components/AppBar'
import { Backdrop } from './components/Backdrop'
import { ShuttleProvider } from './components/Shuttle'
import { Home } from './pages/Home'
import { Insights } from './pages/Insights'
import { Landing } from './pages/Landing'
import { Login } from './pages/Login'
import { Config } from './pages/Config'
import { useHotkeyListener } from './hotkeys'
import { initThoughtSpot } from './thoughtspot'

/** Starts the embed SDK with the signed-in user's token (once). */
function ThoughtSpotSession({ children }: { children: ReactNode }) {
  initThoughtSpot()
  return <>{children}</>
}

/** Signed-in pages share one layout, so Shuttle keeps its conversation across them. */
function AppShell() {
  return (
    <RequireAuth>
      <ThoughtSpotSession>
      <ShuttleProvider>
        <AppBar />
        <Outlet />
      </ShuttleProvider>
      </ThoughtSpotSession>
    </RequireAuth>
  )
}

export default function App() {
  // Hotkey phrases (set on /config) work on every page.
  useHotkeyListener()
  return (
    <BrowserRouter>
      <AuthProvider>
        <div className="app">
          <Backdrop />
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            {/* Demo controls: unlinked, no sign-in needed. */}
            <Route path="/config" element={<Config />} />
            <Route element={<AppShell />}>
              <Route path="/home" element={<Home />} />
              <Route path="/insights" element={<Insights />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </AuthProvider>
    </BrowserRouter>
  )
}
