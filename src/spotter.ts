import { rebrand } from './brand'
import { RETAIL_MODEL_ID, THOUGHTSPOT_HOST } from './thoughtspot'
import { tsFetch } from './tsApi'

// Headless Spotter via the Spotter Agent REST API (Spotter 3, ThoughtSpot 26.5.0.cl+).
// Calls go through Storeloom's server (/api/ts), which adds the signed-in user's
// trusted-auth token; the stream is relayed as it arrives.

async function post(path: string, body: unknown, init: RequestInit = {}) {
  const res = await tsFetch(path, {
    method: 'POST',
    headers: init.headers,
    body: JSON.stringify(body),
    signal: init.signal,
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new SpotterError(res.status, detail)
  }
  return res
}

export class SpotterError extends Error {
  status: number

  constructor(status: number, detail: string) {
    super(
      status === 401
        ? 'Your session has expired. Sign in again, then retry.'
        : status === 403
          ? 'Your account doesn’t have access to Shuttle yet.'
          : `Shuttle couldn’t answer (${status}). ${detail}`,
    )
    this.status = status
  }
}

export async function createConversation(): Promise<string> {
  const res = await post('/ai/agent/conversation/create', {
    metadata_context: { type: 'DATA_SOURCE', data_source_context: { data_source_identifier: RETAIL_MODEL_ID } },
    conversation_settings: {},
  })
  const body = (await res.json()) as { conversation_identifier?: string; conversation_id: string }
  return body.conversation_identifier ?? body.conversation_id
}

/** Asks Spotter to stop generating; the conversation stays usable. */
export async function stopResponse(conversationId: string) {
  await post(`/ai/agent/conversation/${conversationId}/stop-response`, {}).catch(() => {})
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

export type AnswerMeta = {
  session_id: string
  gen_no: number
  transaction_id: string
  generation_number: number
  sage_query?: string
  title?: string
  type?: string
}

export type SpotterEvent =
  | { type: 'ack'; node_id?: string }
  | { type: 'conv_title'; title: string }
  | { type: 'notification'; group_id?: string; code?: string; metadata?: { type?: string; tool_title?: string } }
  | { type: 'text-chunk' | 'text'; id?: string; group_id?: string; content?: string; metadata?: { type?: string; format?: string } }
  | { type: 'answer'; id?: string; group_id?: string; title?: string; metadata: AnswerMeta }
  | { type: 'error'; message?: string; error?: unknown }

/**
 * Sends a message and calls `onEvent` for every Server-Sent Event as it arrives.
 * Each SSE message is `data: <json>`, where <json> is one event or an array of them.
 */
export async function streamMessage(
  conversationId: string,
  message: string,
  onEvent: (e: SpotterEvent) => void,
  signal?: AbortSignal,
) {
  const res = await post(
    `/ai/agent/conversation/${conversationId}/send/stream`,
    { messages: [message] },
    { headers: { Accept: 'text/event-stream' }, signal },
  )
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const flush = (raw: string) => {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('')
    if (!data) return
    try {
      const parsed = JSON.parse(data) as SpotterEvent | SpotterEvent[]
      for (const e of Array.isArray(parsed) ? parsed : [parsed]) onEvent(e)
    } catch {
      console.warn('Shuttle: unparsed stream message', data.slice(0, 200))
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let at
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      flush(buffer.slice(0, at))
      buffer = buffer.slice(at + 2)
    }
  }
  flush(buffer)
}

/** URL of the interactive Spotter answer (chart) for an `answer` event. */
export const answerFrameUrl = (a: AnswerMeta) =>
  `${THOUGHTSPOT_HOST}/?tsmcp=true#/embed/conv-assist-answer` +
  `?sessionId=${encodeURIComponent(a.session_id)}&genNo=${a.gen_no}` +
  `&acSessionId=${encodeURIComponent(a.transaction_id)}&acGenNo=${a.generation_number}`

// ---------------------------------------------------------------------------
// Turn model: what the UI renders for one question
// ---------------------------------------------------------------------------

export type Step = {
  id: string
  title: string
  running: boolean
  /** Streamed reasoning (markdown). */
  thinking: string
  /** Raw tool results, shown collapsed. */
  outputs: string[]
  /** Sub-stage codes reported while fetching data (TML_GEN, ANSWER_GEN…). */
  stages: string[]
  answer?: AnswerMeta
}

export type Turn = {
  question: string
  phase: 'starting' | 'working' | 'answering' | 'done' | 'stopped' | 'error'
  steps: Step[]
  answers: AnswerMeta[]
  /** Final narrative (markdown). */
  text: string
  title?: string
  error?: string
  startedAt: number
  endedAt?: number
}

export const newTurn = (question: string): Turn => ({
  question,
  phase: 'starting',
  steps: [],
  answers: [],
  text: '',
  startedAt: Date.now(),
})

const STAGES: Record<string, string> = {
  nls_start: 'Reading the question',
  QH: 'Matching columns',
  TML_GEN: 'Writing the search',
  ANSWER_GEN: 'Building the answer',
  nls_table_data_fetch: 'Fetching the data',
}

export const stageLabel = (code: string) =>
  STAGES[code] ?? code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())

const sameAnswer = (a: AnswerMeta, b: AnswerMeta) => a.session_id === b.session_id && a.gen_no === b.gen_no

/** Folds one streamed event into the turn (immutably). */
export function applyEvent(turn: Turn, e: SpotterEvent): Turn {
  const t: Turn = { ...turn, phase: turn.phase === 'starting' ? 'working' : turn.phase }
  const step = (id: string | undefined, title?: string): Step[] => {
    const key = id ?? 'misc'
    if (t.steps.some((s) => s.id === key)) return t.steps
    return [...t.steps, { id: key, title: title ?? 'Working', running: true, thinking: '', outputs: [], stages: [] }]
  }
  const update = (id: string | undefined, fn: (s: Step) => Step) => {
    const key = id ?? 'misc'
    t.steps = t.steps.map((s) => (s.id === key ? fn(s) : s))
  }
  const finishSteps = (except?: string) => {
    t.steps = t.steps.map((s) => (s.id === except ? s : { ...s, running: false }))
  }

  switch (e.type) {
    case 'conv_title':
      t.title = e.title
      break
    case 'notification':
      if (e.code === 'FINAL_RESPONSE_NOTIFICATION') {
        finishSteps()
        t.phase = 'answering'
      } else if (e.code === 'TOOL_CALL_NOTIFICATION') {
        finishSteps()
        t.steps = step(e.group_id, e.metadata?.tool_title)
      } else if (e.code) {
        t.steps = step(e.group_id)
        update(e.group_id, (s) => (s.stages.includes(e.code!) ? s : { ...s, stages: [...s.stages, e.code!] }))
      }
      break
    case 'text-chunk':
    case 'text':
      if (!e.content) break
      if (e.metadata?.type === 'thinking') {
        t.steps = step(e.group_id)
        update(e.group_id, (s) =>
          e.type === 'text' ? { ...s, outputs: [...s.outputs, e.content!] } : { ...s, thinking: s.thinking + e.content },
        )
      } else {
        t.phase = 'answering'
        t.text = e.type === 'text' && e.content.length > t.text.length ? e.content : t.text + (e.type === 'text-chunk' ? e.content : '')
      }
      break
    case 'answer':
      if (e.metadata?.type === 'thinking') {
        t.steps = step(e.group_id)
        update(e.group_id, (s) => ({ ...s, answer: e.metadata }))
      } else if (!t.answers.some((a) => sameAnswer(a, e.metadata))) {
        t.answers = [...t.answers, e.metadata]
      }
      break
    case 'error':
      t.phase = 'error'
      t.error = e.message ? rebrand(e.message) : 'Shuttle ran into a problem.'
      break
  }
  return t
}

/** Marks the turn finished once the stream closes. */
export const finishTurn = (turn: Turn, phase: Turn['phase'] = 'done', error?: string): Turn => ({
  ...turn,
  phase: turn.phase === 'error' ? 'error' : phase,
  error: turn.error ?? error,
  steps: turn.steps.map((s) => ({ ...s, running: false })),
  endedAt: Date.now(),
})
