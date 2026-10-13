// ThoughtSpot REST v2 through Storeloom's server (/api/ts), which adds the
// signed-in user's trusted-auth token. Same origin: no CORS, no third-party cookies.

/** Fired when the server reports the session is gone; AuthProvider signs out. */
export const SIGNED_OUT_EVENT = 'storeloom:signed-out'

/** fetch() for `/api/rest/2.0<path>`, e.g. tsFetch('/searchdata', { method: 'POST', body }). */
export async function tsFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`/api/ts${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers as Record<string, string>) },
  })
  if (res.status === 401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
  return res
}
