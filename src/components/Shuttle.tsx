import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { applyEvent, createConversation, finishTurn, newTurn, stopResponse, streamMessage, type Turn } from '../spotter'
import { rebrand } from '../brand'
import type { StoreSelection } from '../storeActions'
import { findStoreLeads, leadLabel, leadSelection, storeFromReply, type StoreLead, type StoreLeads } from '../storeLeads'
import { SpotterTurn } from './SpotterTurn'
import { StoreActionPanel } from './StoreActionPanel'
import { StoreLeadsCard } from './StoreLeadsCard'
import './Shuttle.css'

/** Questions the retail sales data can answer. */
export const SHUTTLE_SUGGESTIONS = [
  'Which regions and stores had the worst profit margins in the last 12 months?',
  'Which region had the highest sales last month?',
  'Compare sales and gross profit by region this year',
  'Top 10 stores by sales per square foot',
  'How has foot traffic trended over the last 6 months?',
]

type LeadsState = { status: 'loading' } | ({ status: 'ready' } & StoreLeads)

type ChatItem =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; turn: Turn; leads?: LeadsState }
  /** Shuttle's own reply, written locally (no data question involved). */
  | { id: number; kind: 'note'; text: string; tone?: 'done' }

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
  const itemsRef = useRef(items)
  itemsRef.current = items

  // The Act on a store flow, started from an answer's leads or a chat reply.
  const [action, setAction] = useState<{ store: StoreSelection } | null>(null)
  /** Store name → ticket of the plan launched from Shuttle. */
  const [actioned, setActioned] = useState<Record<string, string>>({})

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
  const setLeads = (id: number, leads: LeadsState | undefined) =>
    setItems((list) => list.map((it) => (it.id === id && it.kind === 'assistant' ? { ...it, leads } : it)))
  const addNote = (text: string, tone?: 'done') => setItems((list) => [...list, { id: nextId.current++, kind: 'note', text, tone }])

  /** Leads offered by the most recent answer that had any. */
  const latestLeads = (): StoreLead[] => {
    for (const it of [...itemsRef.current].reverse()) {
      if (it.kind === 'assistant' && it.leads?.status === 'ready') return it.leads.leads
    }
    return []
  }

  const actOn = (store: StoreSelection) => setAction({ store })

  const ask = useCallback(
    async (raw: string) => {
      const q = raw.trim()
      if (!q || streaming) return
      setIsOpen(true)
      setDrawerText('')
      stickToBottom.current = true

      // "the 2nd one", "act on Portland": answer it here with the action plan.
      const picked = await storeFromReply(q, latestLeads()).catch(() => null)
      if (picked) {
        setItems((list) => [...list, { id: nextId.current++, kind: 'user', text: q }])
        addNote(`Building an action plan for ${leadLabel(picked)} with its latest figures…`)
        actOn(picked)
        return
      }

      const userId = nextId.current++
      const id = nextId.current++
      let turn = newTurn(q)
      setItems((list) => [...list, { id: userId, kind: 'user', text: q }, { id, kind: 'assistant', turn }])
      setStreaming(true)
      const controller = new AbortController()
      abort.current = controller
      try {
        conversation.current ??= await createConversation()
        await streamMessage(
          conversation.current,
          q,
          (e) => {
            turn = applyEvent(turn, e)
            updateTurn(id, () => turn)
          },
          controller.signal,
        )
        turn = finishTurn(turn)
        updateTurn(id, () => turn)
        if (turn.phase === 'done') {
          // Look for stores worth acting on (in the background; the answer is already shown).
          setLeads(id, { status: 'loading' })
          findStoreLeads(turn).then((found) =>
            setLeads(id, found.leads.length ? { status: 'ready', ...found } : undefined),
          )
        }
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
            ) : it.kind === 'note' ? (
              <div key={it.id} className={it.tone === 'done' ? 'msg-note is-done' : 'msg-note'}>
                <span className="shuttle-pill" aria-hidden />
                <p>{it.text}</p>
              </div>
            ) : (
              <div key={it.id} className="msg-turn">
                <SpotterTurn turn={it.turn} onRetry={streaming ? undefined : () => ask(it.turn.question)} />
                {it.leads && (
                  <StoreLeadsCard
                    state={it.leads}
                    actioned={actioned}
                    onAct={(l) => actOn(leadSelection(l))}
                  />
                )}
              </div>
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

      {action && (
        <StoreActionPanel
          key={action.store.name}
          store={action.store}
          region={action.store.region}
          onClose={() => setAction(null)}
          onPick={actOn}
          onLaunched={(ticket) => {
            const store = action.store
            setActioned((all) => ({ ...all, [store.name]: ticket }))
            const others = latestLeads().filter((l) => l.name !== store.name && !actioned[l.name])
            addNote(
              `Action plan ${ticket} launched for ${leadLabel(store)}.` +
                (others.length ? ` Want to act on another store from the list? Reply with its name or position.` : ''),
              'done',
            )
          }}
        />
      )}
    </ShuttleContext.Provider>
  )
}
