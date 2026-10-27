import { persistedStore, useStore } from './demoConfig'
import { finishTurn, type Turn } from './spotter'
import type { StoreLeads } from './storeLeads'

// Shuttle's conversation history: every chat in the drawer is saved as it goes,
// per signed-in user, in this browser's localStorage. Unlike the demo state reset
// at sign-in (actionTracker), it stays across sessions, so a chat can be reopened
// later and carried on in the same Spotter conversation.

export type LeadsState = { status: 'loading' } | ({ status: 'ready' } & StoreLeads)

export type ChatItem =
  | { id: number; kind: 'user'; text: string; tag?: string }
  | { id: number; kind: 'assistant'; turn: Turn; leads?: LeadsState }
  /** Shuttle's own reply, written locally (no data question involved). */
  | { id: number; kind: 'note'; text: string; tone?: 'done' | 'limit' }

export type SavedChat = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** The Spotter conversation, so follow-ups keep its context. */
  conversationId: string | null
  /** AskContext.scope of the conversation (the view it's about). */
  scope: string | null
  items: ChatItem[]
}

type History = { chats: SavedChat[] }

/** Most recent chats kept per user; older ones drop off. */
const MAX_CHATS = 30
/** The drawer shows the first 4,000 characters of a step's tool results. */
const MAX_OUTPUT = 4000

const stores = new Map<string, ReturnType<typeof persistedStore<History>>>()

/** The user's history (one store per user, created once). */
export function historyStore(user: string) {
  let store = stores.get(user)
  if (!store) stores.set(user, (store = persistedStore<History>(`storeloom.shuttle.history.${user}`, { chats: [] })))
  return store
}

export const useHistory = (user: string) => useStore(historyStore(user)).chats

export const newChatId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

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

/** Saves (or updates) a chat, most recent first. */
export function saveChat(user: string, chat: Omit<SavedChat, 'createdAt' | 'updatedAt'>) {
  historyStore(user).set(({ chats }) => {
    const existing = chats.find((c) => c.id === chat.id)
    const now = Date.now()
    const saved: SavedChat = { ...chat, items: forStorage(chat.items), createdAt: existing?.createdAt ?? now, updatedAt: now }
    return { chats: [saved, ...chats.filter((c) => c.id !== chat.id)].slice(0, MAX_CHATS) }
  })
}

export function deleteChat(user: string, id: string) {
  historyStore(user).set(({ chats }) => ({ chats: chats.filter((c) => c.id !== id) }))
}

export const clearHistory = (user: string) => historyStore(user).reset()

/** Questions asked in a chat. */
export const questionCount = (chat: SavedChat) => chat.items.filter((it) => it.kind === 'user').length

/** "Today", "Yesterday", "Earlier this week" or "Earlier": history list sections. */
export function historySection(at: number, now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (at >= day) return 'Today'
  if (at >= day - 86_400_000) return 'Yesterday'
  if (at >= day - 6 * 86_400_000) return 'Earlier this week'
  return 'Earlier'
}
