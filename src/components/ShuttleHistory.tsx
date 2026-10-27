import { useState } from 'react'
import { rebrand } from '../brand'
import { historySection, questionCount, type HistoryEntry, type HistoryStatus } from '../shuttleHistory'

const when = (at: number) =>
  historySection(at) === 'Today'
    ? new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const firstQuestion = (entry: HistoryEntry) => entry.local?.items.find((it) => it.kind === 'user')?.text ?? ''

/** One past conversation: reopens it, or deletes it (after a confirmation: it's for good). */
function HistoryRow({
  entry,
  current,
  disabled,
  onOpen,
  onDelete,
}: {
  entry: HistoryEntry
  current: boolean
  disabled: boolean
  onOpen: () => void
  onDelete: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [failed, setFailed] = useState(false)
  const title = rebrand(entry.title)
  const question = firstQuestion(entry)
  const n = entry.local ? questionCount(entry.local) : null

  const remove = async () => {
    setDeleting(true)
    setFailed(false)
    try {
      await onDelete()
    } catch {
      setFailed(true)
      setDeleting(false)
    }
  }

  if (confirming) {
    return (
      <li className="hist-row is-confirming">
        <span className="hist-confirm-text">
          {failed ? 'It wasn’t deleted. Try again?' : <>Delete “{title}”? This can’t be undone.</>}
        </span>
        <span className="hist-confirm">
          <button type="button" className="hist-clear is-danger" onClick={remove} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
          <button type="button" className="hist-clear" onClick={() => setConfirming(false)} disabled={deleting}>
            Keep
          </button>
        </span>
      </li>
    )
  }

  return (
    <li className={current ? 'hist-row is-current' : 'hist-row'}>
      <button type="button" className="hist-open" onClick={onOpen} disabled={disabled}>
        <span className="hist-title">{title}</span>
        {question && question !== entry.title && <span className="hist-question">{question}</span>}
        <span className="hist-meta mono-label">
          {n !== null && `${n} ${n === 1 ? 'question' : 'questions'} · `}
          {when(entry.updatedAt)}
          {current && <span className="hist-badge">Open</span>}
        </span>
      </button>
      <button type="button" className="hist-delete" onClick={() => setConfirming(true)} aria-label={`Delete “${title}”`} title="Delete">
        ×
      </button>
    </li>
  )
}

/**
 * The drawer's history view: the user's conversations saved in ThoughtSpot, by
 * day and searchable, each reopened in place to carry on where it left off.
 */
export function ShuttleHistory({
  entries,
  status,
  currentId,
  busy,
  onOpen,
  onDelete,
  onBack,
}: {
  entries: HistoryEntry[]
  status: HistoryStatus
  currentId: string | null
  /** Shuttle is answering: reopening waits until it's done. */
  busy: boolean
  onOpen: (entry: HistoryEntry) => void
  onDelete: (entry: HistoryEntry) => Promise<void>
  onBack: () => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q
    ? entries.filter((e) =>
        [e.title, ...(e.local?.items ?? []).map((it) => (it.kind === 'user' ? it.text : ''))].some((t) => t.toLowerCase().includes(q)),
      )
    : entries
  const sections = shown.reduce<{ name: string; entries: HistoryEntry[] }[]>((all, entry) => {
    const name = historySection(entry.updatedAt)
    const last = all[all.length - 1]
    if (last?.name === name) last.entries.push(entry)
    else all.push({ name, entries: [entry] })
    return all
  }, [])
  const loading = status === 'idle' || status === 'loading'

  return (
    <div className="hist">
      <div className="hist-head">
        <button type="button" className="hist-back" onClick={onBack}>
          ← Back to chat
        </button>
        <span className="mono-label">
          {loading && !entries.length
            ? 'Loading…'
            : `${entries.length} saved ${entries.length === 1 ? 'conversation' : 'conversations'}`}
        </span>
      </div>

      {entries.length > 0 && (
        <input
          className="hist-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search past questions…"
          aria-label="Search past conversations"
        />
      )}
      {status === 'local' && (
        <p className="hist-hint">Your saved conversations aren’t available right now, so this lists the chats saved in this browser.</p>
      )}
      {busy && <p className="hist-hint">Shuttle is answering. Conversations open once it’s done.</p>}

      {loading && !entries.length ? (
        <p className="hist-empty">Loading your conversations…</p>
      ) : entries.length === 0 ? (
        <p className="hist-empty">No conversations yet. Questions you ask Shuttle are saved with your account, so you can pick them up later on any device.</p>
      ) : shown.length === 0 ? (
        <p className="hist-empty">Nothing matches “{query.trim()}”.</p>
      ) : (
        sections.map((s) => (
          <section key={s.name} className="hist-section">
            <h3 className="mono-label">{s.name}</h3>
            <ul>
              {s.entries.map((entry) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  current={entry.id === currentId}
                  disabled={busy}
                  onOpen={() => onOpen(entry)}
                  onDelete={() => onDelete(entry)}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {entries.length > 0 && status !== 'local' && (
        <p className="hist-foot">Saved with your account, so they follow you to any device.</p>
      )}
    </div>
  )
}

/** The empty drawer's shortcut back into the latest conversations. */
export function RecentChats({
  entries,
  busy,
  onOpen,
  onAll,
}: {
  entries: HistoryEntry[]
  busy: boolean
  onOpen: (entry: HistoryEntry) => void
  onAll: () => void
}) {
  if (!entries.length) return null
  return (
    <div className="hist-recent">
      <div className="hist-recent-head">
        <span className="mono-label">Pick up where you left off</span>
        <button type="button" className="hist-all" onClick={onAll}>
          All history →
        </button>
      </div>
      <ul>
        {entries.slice(0, 3).map((entry) => (
          <li key={entry.id}>
            <button type="button" onClick={() => onOpen(entry)} disabled={busy}>
              <span className="hist-title">{rebrand(entry.title)}</span>
              <span className="hist-meta mono-label">{when(entry.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
