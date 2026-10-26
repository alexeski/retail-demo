import { useEffect, useRef, useState } from 'react'

/**
 * A page title the owner can rename in place: the ✎ button (or a double click)
 * turns it into a field; Enter or leaving the field saves, Escape cancels.
 */
export function EditableTitle({
  name,
  className,
  onRename,
}: {
  name: string
  className: string
  /** Saves the new name; a rejection shows its message and keeps the field open. */
  onRename: (name: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  /** Escape: the blur that follows must not save. */
  const cancelled = useRef(false)
  /** A save in flight: Enter and the blur that follows it save once. */
  const busy = useRef(false)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const start = () => {
    cancelled.current = false
    setDraft(name)
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    if (cancelled.current || busy.current) return
    const next = draft.trim()
    if (!next || next === name) {
      setEditing(false)
      return
    }
    busy.current = true
    setSaving(true)
    try {
      await onRename(next)
      setEditing(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div className="title-edit">
        <h1 className={className} onDoubleClick={start}>
          {name}
        </h1>
        <button type="button" className="title-edit-btn" onClick={start} title="Rename this dashboard" aria-label="Rename this dashboard">
          ✎
        </button>
      </div>
    )
  }

  return (
    <div className="title-edit is-editing">
      <input
        ref={input}
        className={`${className} title-edit-input`}
        value={draft}
        maxLength={100}
        disabled={saving}
        aria-label="Dashboard name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') {
            cancelled.current = true
            setEditing(false)
          }
        }}
      />
      <span className="mono-label title-edit-hint">{saving ? 'Saving…' : error ?? 'Enter to save · Esc to cancel'}</span>
    </div>
  )
}
