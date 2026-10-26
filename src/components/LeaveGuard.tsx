import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import './LeaveGuard.css'

type Leaving = { go: () => void; saving: boolean; failed: boolean }

/**
 * Hand edits to a dashboard live in ThoughtSpot's editor until it saves, so while
 * `active`, leaving asks first: save the edits and go, go without them, or stay.
 *
 * - `leave(go)` runs `go` now, or once the user has decided (wrap in-page exits in it);
 * - in-app links anywhere on the page (the top bar included) are caught as well,
 *   and closing or reloading the tab gets the browser's own warning;
 * - `save` asks the editor to save; call `saved()` from its onSave so the pending
 *   exit goes ahead. `discard` ends editing without saving.
 */
export function useLeaveGuard({ active, save, discard }: { active: boolean; save: () => void; discard: () => void }) {
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState<Leaving | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  // Set while "Save and continue" waits for the editor: where to go next.
  const afterSave = useRef<(() => void) | null>(null)

  const leave = useCallback((go: () => void) => {
    if (activeRef.current) setLeaving({ go, saving: false, failed: false })
    else go()
  }, [])

  const saved = useCallback(() => {
    const next = afterSave.current
    afterSave.current = null
    next?.()
  }, [])

  // Closing or reloading the tab.
  useEffect(() => {
    if (!active) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active])

  // In-app links anywhere on the page.
  useEffect(() => {
    if (!active) return
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!link || link.target === '_blank' || link.origin !== window.location.origin) return
      e.preventDefault()
      e.stopPropagation()
      leave(() => navigate(link.pathname + link.search + link.hash))
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [active, leave, navigate])

  const saveAndLeave = () => {
    if (!leaving) return
    const { go } = leaving
    setLeaving({ ...leaving, saving: true, failed: false })
    afterSave.current = () => {
      setLeaving(null)
      go()
    }
    save()
    // ThoughtSpot says when it has saved (onSave); if it doesn't, say so rather than hang.
    window.setTimeout(() => {
      if (!afterSave.current) return
      afterSave.current = null
      setLeaving((l) => (l ? { ...l, saving: false, failed: true } : l))
    }, 15_000)
  }

  const leaveWithoutSaving = () => {
    if (!leaving) return
    const { go } = leaving
    afterSave.current = null
    discard()
    setLeaving(null)
    go()
  }

  const dialog: ReactNode = leaving && (
    <div className="leave-scrim" onClick={() => !leaving.saving && setLeaving(null)}>
      <div className="leave-dialog" role="alertdialog" aria-modal aria-labelledby="leave-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="leave-title">Save your edits first?</h2>
        <p>You’re editing this dashboard by hand, and your changes aren’t saved yet. Leaving now loses them.</p>
        {leaving.failed && (
          <p className="leave-error" role="alert">
            The dashboard didn’t save. Try again, or use Save in the toolbar above the dashboard.
          </p>
        )}
        <div className="leave-actions">
          <button type="button" className="btn-primary" onClick={saveAndLeave} disabled={leaving.saving} autoFocus>
            {leaving.saving ? 'Saving…' : 'Save and continue'}
          </button>
          <button type="button" className="btn-outline" onClick={leaveWithoutSaving} disabled={leaving.saving}>
            Leave without saving
          </button>
          <button type="button" className="btn-outline" onClick={() => setLeaving(null)} disabled={leaving.saving}>
            Keep editing
          </button>
        </div>
      </div>
    </div>
  )

  return { leave, saved, dialog }
}
