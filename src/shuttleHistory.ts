import { useCallback, useMemo, useState } from 'react'
import { persistedStore, useStore } from './demoConfig'
import { DATA_SOURCE_ID, finishTurn, newTurn, request, type AnswerMeta, type Step, type Turn } from './spotter'
import type { StoreLeads } from './storeLeads'

// Shuttle's conversation history. Conversations are saved in ThoughtSpot
// (created with enable_save_chat), so the list follows the user to any device and
// reopens from ThoughtSpot's copy. This browser also keeps each chat as Storeloom
// showed it, keyed by conversation: what ThoughtSpot doesn't store (store leads,
// Shuttle's own notes, where a question was asked), and a quicker reopen.

export type LeadsState = { status: 'loading' } | ({ status: 'ready' } & StoreLeads)

export type ChatItem =
  | { id: number; kind: 'user'; text: string; tag?: string }
  | { id: number; kind: 'assistant'; turn: Turn; leads?: LeadsState }
  /** Shuttle's own reply, written locally (no data question involved). */
  | { id: number; kind: 'note'; text: string; tone?: 'done' | 'limit' }

// ---------------------------------------------------------------------------
// ThoughtSpot's saved conversations (Spotter Agent API, 26.7.0.cl+)
// ---------------------------------------------------------------------------

type RemoteChat = { id: string; title: string; updatedAt: number }

type ConversationList = {
  conversations?: { conversation_identifier: string; conversation_title?: string | null; updated_at?: string | null; data_source_identifiers?: string[] | null }[]
}

/** The user's saved conversations about the retail data, most recent first. */
async function listConversations(): Promise<RemoteChat[]> {
  const body = (await (await request('GET', '/ai/agent/conversations?limit=50')).json()) as ConversationList
  return (body.conversations ?? [])
    .filter((c) => c.data_source_identifiers?.includes(DATA_SOURCE_ID))
    .map((c) => ({
      id: c.conversation_identifier,
      title: c.conversation_title || 'Conversation',
      updatedAt: c.updated_at ? Date.parse(c.updated_at) : 0,
    }))
}

const deleteConversation = (id: string) => request('DELETE', `/ai/agent/conversations/${encodeURIComponent(id)}/delete`)

type ResponseItem = {
  type: string
  is_thinking?: boolean | null
  step_title?: string | null
  content?: string | null
  answer_id?: string | null
  tool_call_id?: string | null
  tool_name?: string | null
  timestamp_in_millis?: number | null
}
type SavedMessage = {
  timestamp_in_millis: number
  user_prompt?: { message?: { content?: string } | null } | null
  response_items: ResponseItem[]
}
type SavedAnswer = {
  title?: string
  session_identifier: string
  generation_number: number
  tokens?: string[]
  ac_state: { transaction_identifier: string; generation_number: number }
}

/** The chart behind a saved answer, in the shape the drawer's answer frames use. */
async function loadAnswer(conversationId: string, answerId: string): Promise<AnswerMeta | null> {
  try {
    const path = `/ai/agent/conversations/${encodeURIComponent(conversationId)}/answers/${encodeURIComponent(answerId)}/details`
    const { answer } = (await (await request('GET', path)).json()) as { answer: SavedAnswer }
    return {
      session_id: answer.session_identifier,
      gen_no: answer.generation_number,
      transaction_id: answer.ac_state.transaction_identifier,
      generation_number: answer.ac_state.generation_number,
      sage_query: answer.tokens?.join(' '),
      title: answer.title,
    }
  } catch (err) {
    console.warn('Shuttle: saved answer unavailable', answerId, err)
    return null
  }
}

/** Separates the context Storeloom sends with a question from the question itself. */
export const QUESTION_MARK = '\n\nQuestion: '

/** The question as asked, without the context sent before it. */
const questionOf = (content: string) => {
  const at = content.lastIndexOf(QUESTION_MARK)
  return at < 0 ? content : content.slice(at + QUESTION_MARK.length)
}

/** One saved turn as a Storeloom turn: its steps, charts and final reply. */
async function toTurn(conversationId: string, m: SavedMessage, title?: string): Promise<Turn | null> {
  const question = questionOf(m.user_prompt?.message?.content ?? '')
  if (!question) return null
  const metas = new Map<string, AnswerMeta | null>()
  await Promise.all(
    m.response_items
      .filter((r) => r.type === 'answer' && r.answer_id)
      .map(async (r) => metas.set(r.answer_id!, await loadAnswer(conversationId, r.answer_id!))),
  )

  const turn: Turn = { ...newTurn(question), startedAt: m.timestamp_in_millis, title }
  const steps: Step[] = []
  const step = (r: ResponseItem) => {
    const id = r.tool_call_id ?? r.step_title ?? 'misc'
    let s = steps.find((x) => x.id === id)
    if (!s) steps.push((s = { id, title: r.step_title ?? r.tool_name ?? 'Working', running: false, thinking: '', outputs: [], stages: [] }))
    return s
  }
  const text: string[] = []
  for (const r of m.response_items) {
    const answer = r.answer_id ? metas.get(r.answer_id) : null
    if (r.type === 'tool_call') step(r)
    else if (r.type === 'tool_result' && r.content) step(r).outputs.push(r.content)
    else if (r.type === 'text' && r.content) {
      if (r.is_thinking) step(r).thinking += r.content
      else text.push(r.content)
    } else if (r.type === 'answer' && answer) {
      if (r.is_thinking) step(r).answer = answer
      else turn.answers.push(answer)
    }
  }
  const last = m.response_items.at(-1)?.timestamp_in_millis
  return {
    ...turn,
    steps,
    text: text.join('\n\n'),
    phase: m.response_items.length ? 'done' : 'stopped',
    endedAt: last ?? m.timestamp_in_millis,
  }
}

/** A saved conversation as chat items (ids from 1), read back from ThoughtSpot. */
export async function loadConversation(id: string, title: string): Promise<ChatItem[]> {
  const path = `/ai/agent/conversations/${encodeURIComponent(id)}/messages`
  const { messages } = (await (await request('GET', path)).json()) as { messages: SavedMessage[] }
  const turns = await Promise.all(messages.map((m, i) => toTurn(id, m, i === 0 ? title : undefined)))
  let n = 1
  return turns.flatMap((turn): ChatItem[] =>
    turn ? [{ id: n++, kind: 'user', text: turn.question }, { id: n++, kind: 'assistant', turn }] : [],
  )
}

// ---------------------------------------------------------------------------
// This browser's copy of each chat
// ---------------------------------------------------------------------------

export type LocalChat = {
  /** The Spotter conversation. */
  id: string
  title: string
  updatedAt: number
  /** AskContext.scope of the conversation (the view it's about). */
  scope: string | null
  items: ChatItem[]
}

/** Chats kept in this browser per user; older ones still reopen from ThoughtSpot. */
const MAX_LOCAL = 30
/** The drawer shows the first 4,000 characters of a step's tool results. */
const MAX_OUTPUT = 4000

const stores = new Map<string, ReturnType<typeof persistedStore<{ chats: LocalChat[] }>>>()

function localStore(user: string) {
  let store = stores.get(user)
  if (!store) {
    store = persistedStore<{ chats: LocalChat[] }>(`storeloom.shuttle.chats.${user}`, { chats: [] })
    stores.set(user, store)
    try {
      // The earlier, browser-only history (its conversations weren't saved in ThoughtSpot).
      localStorage.removeItem(`storeloom.shuttle.history.${user}`)
    } catch {
      // ignore
    }
  }
  return store
}

/** What's worth keeping of a chat: finished turns, trimmed tool results, found leads. */
function forStorage(items: ChatItem[]): ChatItem[] {
  return items.map((it) => {
    if (it.kind !== 'assistant') return it
    const turn = ['done', 'stopped', 'error'].includes(it.turn.phase) ? it.turn : finishTurn(it.turn, 'stopped')
    return {
      ...it,
      turn: { ...turn, steps: turn.steps.map((s) => ({ ...s, outputs: s.outputs.map((o) => o.slice(0, MAX_OUTPUT)) })) },
      leads: it.leads?.status === 'ready' ? it.leads : undefined,
    }
  })
}

/** Keeps this browser's copy of a chat (most recent first). */
export function saveChat(user: string, chat: Omit<LocalChat, 'updatedAt'>) {
  localStore(user).set(({ chats }) => ({
    chats: [{ ...chat, items: forStorage(chat.items), updatedAt: Date.now() }, ...chats.filter((c) => c.id !== chat.id)].slice(0, MAX_LOCAL),
  }))
}

// ---------------------------------------------------------------------------
// The history list: ThoughtSpot's conversations, with this browser's copies
// ---------------------------------------------------------------------------

export type HistoryEntry = {
  id: string
  title: string
  updatedAt: number
  /** Last change ThoughtSpot knows of (0 if it isn't listed there yet). */
  savedAt: number
  local?: LocalChat
}

/** 'local': ThoughtSpot's history is unavailable, so only this browser's chats are listed. */
export type HistoryStatus = 'idle' | 'loading' | 'ready' | 'local'

export function useChatHistory(user: string) {
  const local = useStore(localStore(user)).chats
  const [remote, setRemote] = useState<{ status: HistoryStatus; chats: RemoteChat[]; at: number }>({ status: 'idle', chats: [], at: 0 })

  const refresh = useCallback(async () => {
    setRemote((r) => (r.status === 'ready' ? r : { ...r, status: 'loading' }))
    try {
      const chats = await listConversations()
      setRemote({ status: 'ready', chats, at: Date.now() })
    } catch (err) {
      console.warn('Shuttle: ThoughtSpot chat history unavailable', err)
      setRemote((r) => ({ ...r, status: 'local' }))
    }
  }, [])

  const entries = useMemo((): HistoryEntry[] => {
    const fromLocal = (c: LocalChat): HistoryEntry => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, savedAt: 0, local: c })
    if (remote.status !== 'ready') return local.map(fromLocal)
    const listed = remote.chats.map((c): HistoryEntry => {
      const copy = local.find((l) => l.id === c.id)
      return { id: c.id, title: c.title, updatedAt: Math.max(c.updatedAt, copy?.updatedAt ?? 0), savedAt: c.updatedAt, local: copy }
    })
    // Chats from since the list was fetched; older ones missing from ThoughtSpot were deleted there.
    const newer = local.filter((l) => l.updatedAt > remote.at && !remote.chats.some((c) => c.id === l.id)).map(fromLocal)
    return [...newer, ...listed].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [local, remote])

  /** Deletes a conversation from ThoughtSpot (for good) and from this browser. */
  const remove = useCallback(
    async (id: string) => {
      await deleteConversation(id).catch((err) => {
        // Already gone there, or only ever saved here: still drop it from the list.
        if (!(err?.status === 404)) throw err
      })
      localStore(user).set(({ chats }) => ({ chats: chats.filter((c) => c.id !== id) }))
      setRemote((r) => ({ ...r, chats: r.chats.filter((c) => c.id !== id) }))
    },
    [user],
  )

  return { entries, status: remote.status, refresh, remove }
}

/** Questions asked in a chat, when this browser has its copy. */
export const questionCount = (chat: LocalChat) => chat.items.filter((it) => it.kind === 'user').length

/** "Today", "Yesterday", "Earlier this week" or "Earlier": history list sections. */
export function historySection(at: number, now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (at >= day) return 'Today'
  if (at >= day - 86_400_000) return 'Yesterday'
  if (at >= day - 6 * 86_400_000) return 'Earlier this week'
  return 'Earlier'
}
