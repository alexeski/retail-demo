import { THOUGHTSPOT_HOST } from './thoughtspot'

// A minimal client for ThoughtSpot's Spotter MCP Server (agent.thoughtspot.app),
// called straight from the browser: JSON-RPC over MCP's streamable HTTP
// transport, no SDK. The server's tools are designed for an AI assistant, but
// their contract is plain JSON, so the page drives them itself.
//
// The server sends no CORS headers, so requests go through this app's origin:
// /ts-mcp is proxied to /token/mcp (vite.config.ts in dev, nginx.conf in the
// container). Each request carries the user's own bearer token, issued by
// ThoughtSpot from their session, plus the cluster to act on (x-ts-host).

/** Pinned so a server release can't change the tools under the page (2026-10-14: the dashboard designer). */
const API_VERSION = '2026-10-14'
const ENDPOINT = `/ts-mcp?api-version=${API_VERSION}`
const PROTOCOL_VERSION = '2025-06-18'

export class McpError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Bearer token: a fresh one from the current ThoughtSpot session
// ---------------------------------------------------------------------------

let token: { value: string; expires: number } | null = null

async function bearer(): Promise<string> {
  // Valid for 24 h; renewed with five minutes to spare.
  if (token && token.expires - Date.now() > 5 * 60_000) return token.value
  const res = await fetch(`${THOUGHTSPOT_HOST}/api/rest/2.0/auth/session/token`, {
    credentials: 'include',
    headers: { Accept: 'application/json', 'X-Requested-By': 'ThoughtSpot' },
  })
  if (!res.ok) {
    throw new McpError(
      res.status === 401 ? 'Your ThoughtSpot session has expired. Sign in again, then retry.' : `ThoughtSpot didn’t issue a token (${res.status}).`,
      res.status,
    )
  }
  const body = (await res.json()) as { token: string; expiration_time_in_millis: number }
  token = { value: body.token, expires: body.expiration_time_in_millis }
  return token.value
}

// ---------------------------------------------------------------------------
// JSON-RPC over streamable HTTP
// ---------------------------------------------------------------------------

type RpcResponse = { id?: number; result?: unknown; error?: { code: number; message: string } }

let session: Promise<{ id: string | null; tools: ToolInfo[] }> | null = null
let nextId = 1

export type ToolInfo = { name: string; description?: string }

/** A JSON-RPC reply, from either a JSON body or a server-sent event stream. */
async function readReply(res: Response, id: number): Promise<RpcResponse | null> {
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('application/json')) return (await res.json()) as RpcResponse
  if (!type.includes('text/event-stream') || !res.body) return null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    let at
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const data = buffer
        .slice(0, at)
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
      buffer = buffer.slice(at + 2)
      if (!data) continue
      const msg = JSON.parse(data) as RpcResponse
      // Progress notifications and the like share the stream; wait for our reply.
      if (msg.id === id) {
        void reader.cancel()
        return msg
      }
    }
    if (done) return null
  }
}

async function post(body: object, sessionId: string | null) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${await bearer()}`,
    'x-ts-host': THOUGHTSPOT_HOST,
    'mcp-protocol-version': PROTOCOL_VERSION,
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  return fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function rpc(method: string, params: object, sessionId: string | null) {
  const id = nextId++
  const res = await post({ jsonrpc: '2.0', id, method, params }, sessionId)
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new McpError(
      res.status === 401 ? 'ThoughtSpot didn’t accept your token. Sign in again, then retry.' : `The ThoughtSpot MCP Server answered ${res.status}. ${detail}`,
      res.status,
    )
  }
  const reply = await readReply(res, id)
  if (!reply) throw new McpError('The ThoughtSpot MCP Server sent no reply.')
  if (reply.error) throw new McpError(reply.error.message)
  return { result: reply.result, sessionId: res.headers.get('mcp-session-id') }
}

function connect() {
  session ??= (async () => {
    const init = await rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'storeloom', version: '1.0.0' } }, null)
    const id = init.sessionId
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, id)
    const listed = await rpc('tools/list', {}, id)
    return { id, tools: (listed.result as { tools: ToolInfo[] }).tools }
  })().catch((err) => {
    session = null
    throw err
  })
  return session
}

/** The tools this user gets: some depend on their privileges (get_data needs Can download data). */
export async function listTools(): Promise<ToolInfo[]> {
  return (await connect()).tools
}

type CallResult = { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }

/** Calls a tool and returns its structured result. Reconnects once if the server dropped the session. */
export async function callTool<T>(name: string, args: Record<string, unknown>, retried = false): Promise<T> {
  const { id } = await connect()
  let result: CallResult
  try {
    result = (await rpc('tools/call', { name, arguments: args }, id)).result as CallResult
  } catch (err) {
    if (!retried && err instanceof McpError && err.status === 404) {
      session = null
      return callTool(name, args, true)
    }
    throw err
  }
  const text = result.content?.find((c) => c.type === 'text')?.text ?? ''
  if (result.isError) throw new McpError(text || `${name} failed.`)
  if (result.structuredContent) return result.structuredContent as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new McpError(`${name} returned something unexpected.`)
  }
}

// ---------------------------------------------------------------------------
// SpotterViz: the dashboard designer
// ---------------------------------------------------------------------------

export type DesignResult = {
  status: 'completed' | 'in_progress' | 'needs_input' | 'failed'
  task_id?: string
  dashboard_id?: string
  dashboard_url?: string
  changes_applied?: boolean
  message?: string
  choices?: string[]
}

export const createDashboard = (args: {
  title?: string
  instructions?: string
  task_id?: string
  data_source_id?: string
  answers?: { answer_id: string; title: string }[]
}) => callTool<DesignResult>('create_dashboard', args)

export const modifyDashboard = (args: { dashboard_id: string; instructions: string; task_id?: string }) =>
  callTool<DesignResult>('modify_dashboard', args)

/** Waits a short while server-side before answering, so it's called in a loop. */
export const dashboardStatus = (taskId: string) => callTool<DesignResult>('get_dashboard_status', { task_id: taskId })

/** The dashboard a result points at: its ID, or the GUID at the end of its URL. */
export const dashboardIdOf = (r: DesignResult) => r.dashboard_id ?? r.dashboard_url?.match(/pinboard\/([0-9a-f-]{36})/i)?.[1]

// ---------------------------------------------------------------------------
// Spotter: the analytics agent
// ---------------------------------------------------------------------------

export type SessionUpdate = {
  type: 'text' | 'text_chunk' | 'answer' | 'step_notification'
  is_thinking?: boolean
  text?: string
  answer_id?: string
  answer_title?: string
  answer_query?: string
  iframe_url?: string
}

export const createAnalysisSession = (dataSourceId: string) =>
  callTool<{ analytical_session_id: string }>('create_analysis_session', { data_source_id: dataSourceId }).then((r) => r.analytical_session_id)

export const sendSessionMessage = (sessionId: string, message: string) =>
  callTool<unknown>('send_session_message', { analytical_session_id: sessionId, message })

export const sessionUpdates = (sessionId: string) =>
  callTool<{ session_updates: SessionUpdate[]; is_done: boolean }>('get_session_updates', { analytical_session_id: sessionId })

// ---------------------------------------------------------------------------
// get_data: the rows behind a saved dashboard
// ---------------------------------------------------------------------------

export type VizData = {
  viz_id?: string
  viz_name?: string
  columns: string[]
  data_rows: (string | number | boolean | null)[][]
  total_row_count?: number
  sampling_ratio?: number
}

export const dashboardData = (dashboardId: string, maxRows = 25) =>
  callTool<{ data: VizData[] }>('get_data', { object_id: dashboardId, object_type: 'LIVEBOARD', max_rows: maxRows }).then((r) => r.data)
