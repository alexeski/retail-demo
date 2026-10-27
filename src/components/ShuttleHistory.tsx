import { useState } from 'react'
import { rebrand } from '../brand'
import { historySection, questionCount, type SavedChat } from '../shuttleHistory'

const when = (at: number) =>
  historySection(at) === 'Today'
    ? new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const firstQuestion = (chat: SavedChat) => chat.items.find((it) => it.kind === 'user')?.text ?? ''

/** One past conversation: reopens it, or deletes it. */
function HistoryRow({
  chat,
  current,
  disabled,
  onOpen,
  onDelete,
}: {
  chat: SavedChat
  current: boolean
  disabled: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const title = rebrand(chat.title)
  const question = firstQuestion(chat)
  const n = questionCount(chat)
  return (
    <li className={current ? 'hist-row is-current' : 'hist-row'}>
      <button type="button" className="hist-open" onClick={onOpen} disabled={disabled}>
        <span className="hist-title">{title}</span>
        {question && question !== chat.title && <span className="hist-question">{question}</span>}
        <span className="hist-meta mono-label">
          {n} {n === 1 ? 'question' : 'questions'} · {when(chat.updatedAt)}
          {current && <span className="hist-badge">Open</span>}
        </span>
      </button>
      <button type="button" className="hist-delete" onClick={onDelete} aria-label={`Delete “${title}”`} title="Delete">
        ×
      </button>
    </li>
  )
}

/**
 * The drawer's history view: past conversations by day, searchable, each one
 * reopened in place (answers and all) to carry on where it left off.
 */
export function ShuttleHistory({
  chats,
  currentId,
  busy,
  onOpen,
  onDelete,
  onClear,
  onBack,
}: {
  chats: SavedChat[]
  currentId: string | null
  /** Shuttle is answering: reopening waits until it's done. */
  busy: boolean
  onOpen: (chat: SavedChat) => void
  onDelete: (chat: SavedChat) => void
  onClear: () => void
  onBack: () => void
}) {
  const [query, setQuery] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const q = query.trim().toLowerCase()
  const shown = q
    ? chats.filter((c) => [c.title, ...c.items.map((it) => (it.kind === 'user' ? it.text : ''))].some((t) => t.toLowerCase().includes(q)))
    : chats
  const sections = shown.reduce<{ name: string; chats: SavedChat[] }[]>((all, chat) => {
    const name = historySection(chat.updatedAt)
    const last = all[all.length - 1]
    if (last?.name === name) last.chats.push(chat)
    else all.push({ name, chats: [chat] })
    return all
  }, [])

  return (
    <div className="hist">
      <div className="hist-head">
        <button type="button" className="hist-back" onClick={onBack}>
          ← Back to chat
        </button>
        <span className="mono-label">
          {chats.length} saved {chats.length === 1 ? 'conversation' : 'conversations'}
        </span>
      </div>

      {chats.length > 0 && (
        <input
          className="hist-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search past questions…"
          aria-label="Search past conversations"
        />
      )}
      {busy && <p className="hist-hint">Shuttle is answering. Conversations open once it’s done.</p>}

      {chats.length === 0 ? (
        <p className="hist-empty">No conversations yet. Questions you ask Shuttle are saved here, so you can pick them up later.</p>
      ) : shown.length === 0 ? (
        <p className="hist-empty">Nothing matches “{query.trim()}”.</p>
      ) : (
        sections.map((s) => (
          <section key={s.name} className="hist-section">
            <h3 className="mono-label">{s.name}</h3>
            <ul>
              {s.chats.map((chat) => (
                <HistoryRow
                  key={chat.id}
                  chat={chat}
                  current={chat.id === currentId}
                  disabled={busy}
                  onOpen={() => onOpen(chat)}
                  onDelete={() => onDelete(chat)}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {chats.length > 0 && (
        <div className="hist-foot">
          <span>Saved in this browser for your account.</span>
          {confirmClear ? (
            <span className="hist-confirm">
              Delete all {chats.length}?
              <button type="button" className="hist-clear is-danger" onClick={() => {
                  onClear()
                  setConfirmClear(false)
                }}>
                Delete all
              </button>
              <button type="button" className="hist-clear" onClick={() => setConfirmClear(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" className="hist-clear" onClick={() => setConfirmClear(true)}>
              Clear history
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The empty drawer's shortcut back into the latest conversations. */
export function RecentChats({ chats, busy, onOpen, onAll }: { chats: SavedChat[]; busy: boolean; onOpen: (chat: SavedChat) => void; onAll: () => void }) {
  if (!chats.length) return null
  return (
    <div className="hist-recent">
      <div className="hist-recent-head">
        <span className="mono-label">Pick up where you left off</span>
        <button type="button" className="hist-all" onClick={onAll}>
          All history →
        </button>
      </div>
      <ul>
        {chats.slice(0, 3).map((chat) => (
          <li key={chat.id}>
            <button type="button" onClick={() => onOpen(chat)} disabled={busy}>
              <span className="hist-title">{rebrand(chat.title)}</span>
              <span className="hist-meta mono-label">{when(chat.updatedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
