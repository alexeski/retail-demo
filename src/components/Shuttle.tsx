import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { applyEvent, createConversation, finishTurn, newTurn, SpotterError, stopResponse, streamMessage, type Turn } from '../spotter'
import { useAuth } from '../auth'
import { rebrand } from '../brand'
import type { StoreSelection } from '../storeActions'
import { findStoreLeads, leadLabel, leadSelection, storeFromReply, type StoreLead } from '../storeLeads'
import { loadConversation, QUESTION_MARK, saveChat, useChatHistory, type ChatItem, type HistoryEntry, type LeadsState } from '../shuttleHistory'
import { RecentChats, ShuttleHistory } from './ShuttleHistory'
import { SpotterTurn } from './SpotterTurn'
import { StoreActionPanel } from './StoreActionPanel'
import { StoreLeadsCard } from './StoreLeadsCard'
import { UpgradeDialog, type UpgradeOutcome } from './UpgradeDialog'
import { consumeQuestion, formatQuestions, limitReached, PLANS, usageStore, useUsage } from '../demoConfig'
import './Shuttle.css'

/** Questions the retail sales data can answer. */
/** Starter questions (Home and the empty drawer), each with the topic Home labels it with. */
export const SHUTTLE_SUGGESTIONS: { q: string; topic: string }[] = [
  { q: 'Which regions and stores had the worst profit margins in the last 12 months?', topic: 'Profit' },
  { q: 'Which region had the highest sales last month?', topic: 'Sales' },
  { q: 'Compare sales and gross profit by region this year', topic: 'Regions' },
  { q: 'Top 10 stores by sales per square foot', topic: 'Space' },
  { q: 'How has foot traffic trended over the last 6 months?', topic: 'Traffic' },
]

/**
 * Context sent to Spotter with a question (not shown in the chat): what the user
 * is looking at, e.g. a dashboard and its active filters. `tag` labels the
 * question in the chat. A question from another `scope` (another view) starts a
 * new Spotter conversation, so the previous view's context doesn't carry over.
 */
export type AskContext = { scope: string; tag: string; preamble: string }

/** How long a reopened chat's Spotter conversation may stay silent before Shuttle starts a new one. */
const REOPENED_SILENCE_MS = 12_000

type ShuttleApi = {
  /** Opens the drawer and asks a question. */
  /** `context`: where the question comes from (e.g. a dashboard and its filters). */
  ask: (question: string, context?: AskContext) => void
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
  // Studio (also Dashboard Lab's) and the Lab's ShuttleViz have no launcher (they
  // have their own assistant panels): close a conversation left open on the way in.
  const inStudio = /^\/(lab\/)?studio|^\/lab\/shuttleviz/.test(useLocation().pathname)
  useEffect(() => {
    if (inStudio) setIsOpen(false)
  }, [inStudio])
  const [drawerText, setDrawerText] = useState('')
  const [items, setItems] = useState<ChatItem[]>([])
  const [streaming, setStreaming] = useState(false)
  const [unread, setUnread] = useState(false)
  const conversation = useRef<string | null>(null)
  /** The view the current conversation is about (AskContext.scope). */
  const conversationScope = useRef<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const nextId = useRef(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const drawerInputRef = useRef<HTMLInputElement>(null)
  const isOpenRef = useRef(isOpen)
  isOpenRef.current = isOpen
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Conversation history (see shuttleHistory.ts): conversations are saved in
  // ThoughtSpot, this browser keeps its copy of each, and past ones reopen in place.
  const userName = useAuth().user?.name ?? 'guest'
  const history = useChatHistory(userName)
  const [view, setView] = useState<'chat' | 'history'>('chat')
  /** Title of the saved conversation being read back from ThoughtSpot. */
  const [opening, setOpening] = useState<string | null>(null)
  /** Id of the open conversation's first item: earlier ones belong to another conversation. */
  const conversationStart = useRef(0)
  /** The open chat was reopened from the history and hasn't been sent to since. */
  const reopened = useRef(false)
  /** The items a reopened chat came back with (not a change worth saving). */
  const restoredItems = useRef<ChatItem[] | null>(null)

  // The Act on a store flow, started from an answer's leads or a chat reply.
  const [action, setAction] = useState<{ store: StoreSelection } | null>(null)
  /** Store name → ticket of the plan launched from Shuttle. */
  const [actioned, setActioned] = useState<Record<string, string>>({})

  // Question metering (set on /config): one question per Spotter request.
  const usage = useUsage()
  const atLimit = limitReached(usage)
  const [upgradeOpen, setUpgradeOpen] = useState(false)

  useEffect(() => {
    // An expanded answer handles Escape itself; only close the drawer otherwise.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.sp-overlay') && setIsOpen(false)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      abort.current?.abort()
    }
  }, [])

  // Keep this browser's copy of the open conversation once each answer is in (not
  // on every streamed event); ThoughtSpot saves its own as it answers.
  useEffect(() => {
    const id = conversation.current
    if (streaming || !id || items === restoredItems.current) return
    const mine = items.filter((it) => it.id >= conversationStart.current)
    if (!mine.some((it) => it.kind === 'user')) return
    saveChat(userName, { id, title: chatTitle(mine), scope: conversationScope.current, items: mine })
  }, [items, streaming, userName])

  // The history list, fresh each time the drawer or the history view opens.
  const refreshHistory = history.refresh
  useEffect(() => {
    if (isOpen) refreshHistory()
  }, [isOpen, view, refreshHistory])

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
  const addNote = (text: string, tone?: 'done' | 'limit') => setItems((list) => [...list, { id: nextId.current++, kind: 'note', text, tone }])

  /** Leads offered by the most recent answer that had any. */
  const latestLeads = (): StoreLead[] => {
    for (const it of [...itemsRef.current].reverse()) {
      if (it.kind === 'assistant' && it.leads?.status === 'ready') return it.leads.leads
    }
    return []
  }

  const actOn = (store: StoreSelection) => setAction({ store })

  const ask = useCallback(
    async (raw: string, context?: AskContext) => {
      const q = raw.trim()
      if (!q || streaming) return
      setIsOpen(true)
      setView('chat')
      setDrawerText('')
      stickToBottom.current = true

      // "the 2nd one", "act on Portland": answer it here with the action plan.
      // Handled locally, so it doesn't use a metered question.
      const picked = await storeFromReply(q, latestLeads()).catch(() => null)
      if (picked) {
        setItems((list) => [...list, { id: nextId.current++, kind: 'user', text: q }])
        addNote(`Building an action plan for ${leadLabel(picked)} with its latest figures…`)
        actOn(picked)
        return
      }

      // Out of questions: keep the question in the box for after an upgrade.
      if (!consumeQuestion()) {
        setDrawerText(q)
        setUpgradeOpen(true)
        return
      }
      const lastQuestion = limitReached(usageStore.get())

      if (context && context.scope !== conversationScope.current) {
        if (conversation.current) {
          conversation.current = null
          addNote(`New conversation about ${context.scope}`)
        }
        conversationScope.current = context.scope
      }

      const userId = nextId.current++
      const id = nextId.current++
      if (!conversation.current) conversationStart.current = userId
      let turn = newTurn(q)
      setItems((list) => [...list, { id: userId, kind: 'user', text: q, tag: context?.tag }, { id, kind: 'assistant', turn }])
      // Spotter keeps the conversation, so follow-ups inherit this context too.
      const message = context ? `${context.preamble}${QUESTION_MARK}${q}` : q
      setStreaming(true)
      const controller = new AbortController()
      abort.current = controller
      // A reopened chat's Spotter conversation may be gone by now: ThoughtSpot then
      // refuses it, or never answers (a live one acknowledges within a second).
      let silent = false
      const send = async (text: string) => {
        conversation.current ??= await createConversation()
        const attempt = new AbortController()
        const stopAttempt = () => attempt.abort()
        controller.signal.addEventListener('abort', stopAttempt)
        const watchdog = reopened.current
          ? setTimeout(() => {
              silent = true
              attempt.abort()
            }, REOPENED_SILENCE_MS)
          : undefined
        try {
          await streamMessage(
            conversation.current,
            text,
            (e) => {
              clearTimeout(watchdog)
              turn = applyEvent(turn, e)
              updateTurn(id, () => turn)
            },
            attempt.signal,
          )
        } finally {
          clearTimeout(watchdog)
          controller.signal.removeEventListener('abort', stopAttempt)
        }
      }
      try {
        try {
          await send(message)
        } catch (err) {
          // Carry on in a new conversation (the earlier answers stay in the chat).
          const expired =
            reopened.current && !controller.signal.aborted && turn.phase === 'starting' &&
            (silent || (err instanceof SpotterError && err.status !== 401 && err.status !== 403))
          if (!expired) throw err
          reopened.current = false
          conversation.current = null
          const note: ChatItem = {
            id: nextId.current++,
            kind: 'note',
            text: 'Shuttle had closed this conversation, so it picks up in a new one with a recap of the questions above.',
          }
          setItems((list) => {
            const at = list.findIndex((it) => it.id === userId)
            return [...list.slice(0, at), note, ...list.slice(at)]
          })
          await send(withRecap(itemsRef.current.filter((it) => it.id !== userId && it.id !== id), message))
        }
        reopened.current = false
        turn = finishTurn(turn)
        updateTurn(id, () => turn)
        if (lastQuestion) {
          const plan = PLANS[usageStore.get().plan]
          addNote(
            `That was the last of your ${formatQuestions(plan.questions)} Shuttle questions on ${plan.name} this month. Upgrade to keep asking, or talk to your account team.`,
            'limit',
          )
        }
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

  const clearChat = () => {
    stop()
    conversation.current = null
    conversationScope.current = null
    conversationStart.current = 0
    reopened.current = false
    setItems([])
  }

  const newChat = () => {
    clearChat()
    setView('chat')
  }

  /**
   * Reopens a saved conversation where it left off: from this browser's copy
   * (with its store leads and notes) unless it went on elsewhere since, otherwise
   * from ThoughtSpot's. Follow-ups carry on in the same Spotter conversation.
   */
  const openChat = async (entry: HistoryEntry) => {
    if (streaming || opening) return
    setView('chat')
    stickToBottom.current = true
    const copy = entry.local && entry.savedAt <= entry.local.updatedAt + 60_000 ? entry.local : null
    let chat = copy?.items
    if (!chat) {
      conversation.current = null
      setItems([])
      setOpening(entry.title)
      try {
        chat = await loadConversation(entry.id, entry.title)
      } catch (err) {
        console.error('Shuttle: saved conversation unavailable', err)
        addNote(`Shuttle couldn’t open “${rebrand(entry.title)}”. Try again in a moment.`)
        return
      } finally {
        setOpening(null)
      }
    }
    restoredItems.current = chat
    nextId.current = Math.max(nextId.current, ...chat.map((it) => it.id + 1))
    conversation.current = entry.id
    conversationScope.current = copy?.scope ?? null
    conversationStart.current = 0
    reopened.current = true
    setItems(chat)
    // ThoughtSpot's copy has no store leads: look again for the latest answer's.
    const last = chat.findLast((it) => it.kind === 'assistant')
    if (!copy && last?.kind === 'assistant' && last.turn.phase === 'done') {
      findStoreLeads(last.turn).then((found) => {
        if (found.leads.length) setLeads(last.id, { status: 'ready', ...found })
      })
    }
  }

  const removeChat = async (entry: HistoryEntry) => {
    await history.remove(entry.id)
    // Its Spotter conversation is gone, so the open chat can't carry on.
    if (entry.id === conversation.current) clearChat()
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

      {/* Launcher, on every signed-in page but Studio, whose Search drawer and
          SpotterViz panel would compete with it. */}
      <button
        type="button"
        className={['shuttle-fab', (isOpen || inStudio) && 'is-hidden', streaming && 'is-busy', unread && 'has-unread'].filter(Boolean).join(' ')}
        onClick={() => setIsOpen(true)}
        aria-label="Open Shuttle, your stores' assistant"
        aria-hidden={inStudio}
        tabIndex={isOpen || inStudio ? -1 : 0}
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
            <button
              type="button"
              className={view === 'history' ? 'btn-outline drawer-new is-active' : 'btn-outline drawer-new'}
              onClick={() => setView((v) => (v === 'history' ? 'chat' : 'history'))}
              aria-pressed={view === 'history'}
            >
              History{history.entries.length > 0 && <span className="drawer-count">{history.entries.length}</span>}
            </button>
            <button type="button" className="btn-outline drawer-new" onClick={newChat}>
              New chat
            </button>
            <button type="button" aria-label="Close" className="drawer-close" onClick={() => setIsOpen(false)}>
              ×
            </button>
          </div>
        </div>

        {view === 'history' && (
          <div className="drawer-messages">
            <ShuttleHistory
              entries={history.entries}
              status={history.status}
              currentId={items.length ? conversation.current : null}
              busy={streaming || !!opening}
              onOpen={openChat}
              onDelete={removeChat}
              onBack={() => setView('chat')}
            />
          </div>
        )}
        <div
          ref={scrollRef}
          hidden={view === 'history'}
          className="drawer-messages"
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          {opening && (
            <div className="msg-note">
              <span className="shuttle-pill" aria-hidden />
              <p>Opening “{rebrand(opening)}”…</p>
            </div>
          )}
          {items.length === 0 && !opening && (
            <div className="drawer-empty">
              <p>Ask anything about sales, stores, products or customers. Shuttle works through your data and shows its reasoning as it goes.</p>
              <div className="msg-follow">
                {SHUTTLE_SUGGESTIONS.map(({ q }) => (
                  <button key={q} type="button" onClick={() => ask(q)}>
                    {q}
                  </button>
                ))}
              </div>
              <RecentChats entries={history.entries} busy={streaming} onOpen={openChat} onAll={() => setView('history')} />
            </div>
          )}
          {items.map((it) =>
            it.kind === 'user' ? (
              <div key={it.id} className="msg-user">
                {it.tag && <span className="msg-tag">{it.tag}</span>}
                {it.text}
              </div>
            ) : it.kind === 'note' ? (
              <div key={it.id} className={it.tone ? `msg-note is-${it.tone}` : 'msg-note'}>
                <span className="shuttle-pill" aria-hidden />
                <div>
                  <p>{it.text}</p>
                  {it.tone === 'limit' && (
                    <button type="button" className="msg-note-action" onClick={() => setUpgradeOpen(true)}>
                      See upgrade options →
                    </button>
                  )}
                </div>
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

        {usage.enabled && <UsageMeter usage={usage} onUpgrade={() => setUpgradeOpen(true)} />}

        <form onSubmit={submit} className="drawer-form">
          <input
            ref={drawerInputRef}
            value={drawerText}
            onChange={(e) => setDrawerText(e.target.value)}
            placeholder={
              streaming
                ? 'Shuttle is working…'
                : atLimit
                  ? `You’ve used all your Shuttle questions on ${PLANS[usage.plan].name}`
                  : 'Ask a follow-up…'
            }
            disabled={streaming}
          />
          {streaming ? (
            <button type="button" className="drawer-stop" onClick={stop}>
              Stop ■
            </button>
          ) : atLimit ? (
            <button type="button" className="drawer-upgrade" onClick={() => setUpgradeOpen(true)}>
              Upgrade →
            </button>
          ) : (
            <button type="submit">Send →</button>
          )}
        </form>
      </aside>

      {upgradeOpen && (
        <UpgradeDialog
          onClose={() => {
            setUpgradeOpen(false)
            setTimeout(() => drawerInputRef.current?.focus(), 50)
          }}
          onDone={(o: UpgradeOutcome) =>
            addNote(
              o.kind === 'upgrade'
                ? `You’re on ${o.plan.name} now: ${o.available === null ? 'unlimited questions' : `${o.available.toLocaleString('en-US')} Shuttle questions`} available. Ask away.`
                : `Plan review booked with ${o.rep} on ${o.when.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at ${o.when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}. The invitation is in your inbox.`,
              'done',
            )
          }
        />
      )}

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

/** A new conversation's first message, recapping the chat's last answers so follow-ups make sense. */
function withRecap(items: ChatItem[], message: string) {
  const answered = items.filter(
    (it): it is Extract<ChatItem, { kind: 'assistant' }> => it.kind === 'assistant' && it.turn.phase === 'done' && !!it.turn.text,
  )
  if (!answered.length) return message
  const recap = answered
    .slice(-3)
    .map((it) => `Q: ${it.turn.question}\nA: ${it.turn.text.slice(0, 600)}`)
    .join('\n\n')
  return `Earlier in this conversation:\n\n${recap}${message.includes(QUESTION_MARK) ? `\n\n${message}` : `${QUESTION_MARK}${message}`}`
}

/** A chat's name in the history: Spotter's title for its first answer, or its first question. */
function chatTitle(items: ChatItem[]) {
  for (const it of items) if (it.kind === 'assistant' && it.turn.title) return it.turn.title
  return items.find((it) => it.kind === 'user')?.text ?? 'Conversation'
}

/** Plan usage, under the conversation (only while metering is on). */
function UsageMeter({ usage, onUpgrade }: { usage: ReturnType<typeof useUsage>; onUpgrade: () => void }) {
  const plan = PLANS[usage.plan]
  const unlimited = plan.questions === null
  const left = Math.max(0, usage.total - usage.used)
  const pct = unlimited ? 0 : Math.min(100, (usage.used / Math.max(1, usage.total)) * 100)
  const tone = left === 0 ? 'is-out' : left <= Math.max(5, usage.total * 0.02) ? 'is-low' : ''
  return (
    <div className={`usage ${tone}`}>
      <div className="usage-row">
        <span className="mono-label">Shuttle questions · {plan.name}</span>
        <span className="usage-count">
          {unlimited ? 'Unlimited' : `${usage.used.toLocaleString('en-US')} of ${usage.total.toLocaleString('en-US')}`}
        </span>
      </div>
      {!unlimited && (
        <div className="usage-bar" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="usage-row">
        <span className="usage-left">
          {unlimited ? 'No monthly limit on your plan' : left === 0 ? 'No questions left this month' : `${left.toLocaleString('en-US')} left this month`}
        </span>
        {plan.id !== 'enterprise' && (
          <button type="button" className="usage-upgrade" onClick={onUpgrade}>
            {left === 0 ? 'Upgrade' : 'Plans'}
          </button>
        )}
      </div>
    </div>
  )
}
