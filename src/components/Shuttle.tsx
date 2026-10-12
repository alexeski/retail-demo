import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { applyEvent, createConversation, finishTurn, newTurn, stopResponse, streamMessage, type Turn } from '../spotter'
import { rebrand } from '../brand'
import { SpotterTurn } from './SpotterTurn'
import './Shuttle.css'

/** Questions the retail sales data can answer. */
export const SHUTTLE_SUGGESTIONS = [
  'Which region had the highest sales last month?',
  'Compare sales and gross profit by region this year',
  'Top 10 stores by sales per square foot',
  'How has foot traffic trended over the last 6 months?',
]

type ChatItem = { id: number; kind: 'user'; text: string } | { id: number; kind: 'assistant'; turn: Turn }

type ShuttleApi = {
  /** Opens the drawer and asks a question. */
  ask: (question: string) => void
  open: () => void
  streaming: boolean
}

const ShuttleContext = createContext<ShuttleApi | null>(null)

export function useShuttle() {
  const ctx = useContext(ShuttleContext)
  if (!ctx) throw new Error('useShuttle must be used inside <ShuttleProvider>')
  return ctx
}

/**
 * Shuttle, the stores' assistant: chat state, the side drawer and a floating
 * launcher. Mounted once around the signed-in pages so a conversation carries
 * on across them.
 */
export function ShuttleProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [drawerText, setDrawerText] = useState('')
  const [items, setItems] = useState<ChatItem[]>([])
  const [streaming, setStreaming] = useState(false)
  const [unread, setUnread] = useState(false)
  const conversation = useRef<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const nextId = useRef(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const drawerInputRef = useRef<HTMLInputElement>(null)
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen

  useEffect(() => {
    // An expanded answer handles Escape itself; only close the drawer otherwise.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.sp-overlay') && setIsOpen(false)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      abort.current?.abort()
    }
  }, [])

  // Follow the stream, unless the viewer has scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [items])

  useEffect(() => {
    if (!isOpen) return
    setUnread(false)
    const t = setTimeout(() => drawerInputRef.current?.focus(), 300)
    return () => clearTimeout(t)
  }, [isOpen])

  const updateTurn = (id: number, fn: (t: Turn) => Turn) =>
    setItems((list) => list.map((it) => (it.id === id && it.kind === 'assistant' ? { ...it, turn: fn(it.turn) } : it)))

  const ask = useCallback(
    async (raw: string) => {
      const q = raw.trim()
      if (!q || streaming) return
      setIsOpen(true)
      setDrawerText('')
      stickToBottom.current = true
      const userId = nextId.current++
      const id = nextId.current++
      setItems((list) => [...list, { id: userId, kind: 'user', text: q }, { id, kind: 'assistant', turn: newTurn(q) }])
      setStreaming(true)
      const controller = new AbortController()
      abort.current = controller
      try {
        conversation.current ??= await createConversation()
        await streamMessage(conversation.current, q, (e) => updateTurn(id, (t) => applyEvent(t, e)), controller.signal)
        updateTurn(id, (t) => finishTurn(t))
      } catch (err) {
        if (controller.signal.aborted) updateTurn(id, (t) => finishTurn(t, 'stopped'))
        else {
          console.error('Shuttle request failed', err)
          updateTurn(id, (t) => finishTurn(t, 'error', err instanceof Error ? err.message : 'Something went wrong.'))
        }
      } finally {
        if (abort.current === controller) abort.current = null
        setStreaming(false)
        if (!isOpenRef.current) setUnread(true)
      }
    },
    [streaming],
  )

  const stop = () => {
    abort.current?.abort()
    if (conversation.current) stopResponse(conversation.current)
  }

  const newChat = () => {
    stop()
    conversation.current = null
    setItems([])
  }

  const latestTitle = [...items]
    .reverse()
    .find((it): it is Extract<ChatItem, { kind: 'assistant' }> => it.kind === 'assistant' && !!it.turn.title)?.turn.title

  const submit = (e: FormEvent) => {
    e.preventDefault()
    ask(drawerText)
  }

  return (
    <ShuttleContext.Provider value={{ ask, open: () => setIsOpen(true), streaming }}>
      {children}

      {/* Launcher, available on every signed-in page. */}
      <button
        type="button"
        className={['shuttle-fab', isOpen && 'is-hidden', streaming && 'is-busy', unread && 'has-unread'].filter(Boolean).join(' ')}
        onClick={() => setIsOpen(true)}
        aria-label="Open Shuttle, your stores' assistant"
        tabIndex={isOpen ? -1 : 0}
      >
        <span className="shuttle-fab-mark" aria-hidden>
          <span />
          <span />
        </span>
        <span className="shuttle-fab-label">{streaming ? 'Shuttle is working…' : 'Ask Shuttle'}</span>
      </button>

      <div className={isOpen ? 'scrim is-open' : 'scrim'} onClick={() => setIsOpen(false)} />
      <aside role="dialog" aria-label="Shuttle conversation" aria-hidden={!isOpen} className={isOpen ? 'drawer is-open' : 'drawer'}>
        <div className="drawer-head">
          <div className="drawer-title">
            <span className="shuttle-pill is-large" />
            <span className="drawer-name">Shuttle</span>
            <span className="drawer-scope mono-label">{latestTitle ? rebrand(latestTitle) : 'Stores assistant'}</span>
          </div>
          <div className="drawer-actions">
            <button type="button" className="btn-outline drawer-new" onClick={newChat}>
              New chat
            </button>
            <button type="button" aria-label="Close" className="drawer-close" onClick={() => setIsOpen(false)}>
              ×
            </button>
          </div>
        </div>

        <div
          ref={scrollRef}
          className="drawer-messages"
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          {items.length === 0 && (
            <div className="drawer-empty">
              <p>Ask anything about sales, stores, products or customers. Shuttle works through your data and shows its reasoning as it goes.</p>
              <div className="msg-follow">
                {SHUTTLE_SUGGESTIONS.map((t) => (
                  <button key={t} type="button" onClick={() => ask(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
          {items.map((it) =>
            it.kind === 'user' ? (
              <div key={it.id} className="msg-user">
                {it.text}
              </div>
            ) : (
              <SpotterTurn key={it.id} turn={it.turn} onRetry={streaming ? undefined : () => ask(it.turn.question)} />
            ),
          )}
        </div>

        <form onSubmit={submit} className="drawer-form">
          <input
            ref={drawerInputRef}
            value={drawerText}
            onChange={(e) => setDrawerText(e.target.value)}
            placeholder={streaming ? 'Shuttle is working…' : 'Ask a follow-up…'}
            disabled={streaming}
          />
          {streaming ? (
            <button type="button" className="drawer-stop" onClick={stop}>
              Stop ■
            </button>
          ) : (
            <button type="submit">Send →</button>
          )}
        </form>
      </aside>
    </ShuttleContext.Provider>
  )
}
