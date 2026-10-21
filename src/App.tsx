import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AuthProvider, RequireAuth } from './auth'
import { AppBar } from './components/AppBar'
import { Backdrop } from './components/Backdrop'
import { ShuttleProvider } from './components/Shuttle'
import { DashboardView } from './pages/DashboardView'
import { Dashboards } from './pages/Dashboards'
import { Home } from './pages/Home'
import { Insights } from './pages/Insights'
import { Landing } from './pages/Landing'
import { Login } from './pages/Login'
import { Config } from './pages/Config'
import { Studio } from './pages/Studio'
import { Brief } from './pages/Brief'
import { useHotkeyListener } from './hotkeys'

/** Signed-in pages share one layout, so Shuttle keeps its conversation across them. */
function AppShell() {
  return (
    <RequireAuth>
      <ShuttleProvider>
        <AppBar />
        <Outlet />
      </ShuttleProvider>
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
              <Route path="/dashboards" element={<Dashboards />} />
              <Route path="/dashboards/:id" element={<DashboardView />} />
              <Route path="/studio" element={<Studio />} />
              <Route path="/studio/brief" element={<Brief />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </AuthProvider>
    </BrowserRouter>
  )
}
