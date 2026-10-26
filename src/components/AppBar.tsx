import { useEffect, useRef, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { initials, useAuth } from '../auth'
import { Brand } from './Brand'

// Sections that exist in the design but aren't built yet.
const UNBUILT_SECTIONS = ['Stores', 'Inventory', 'Orders', 'Customers']

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'appnav-item active' : 'appnav-item'

export function AppBar() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menuOpen])

  return (
    <header className="appbar">
      <div className="appbar-left">
        <Brand to="/" />
        <nav className="appnav">
          <NavLink to="/home" className={navClass}>
            Home
          </NavLink>
          {UNBUILT_SECTIONS.map((label) => (
            <span key={label} className="appnav-item" aria-disabled>
              {label}
            </span>
          ))}
          <NavLink to="/insights" className={navClass}>
            Insights
          </NavLink>
          <NavLink to="/lab" className={navClass}>
            Dashboard Lab <span className="appnav-beta">Beta</span>
          </NavLink>
        </nav>
      </div>
      {user && (
        <div className="account" ref={menuRef}>
          <button
            type="button"
            className="avatar"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={user.displayName}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {initials(user.displayName || user.name)}
          </button>
          {menuOpen && (
            <div className="account-menu" role="menu">
              <div className="account-who">
                <strong>{user.displayName}</strong>
                <span>{user.name}</span>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  signOut()
                  navigate('/login')
                }}
              >
                Sign out of Storeloom
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  )
}
