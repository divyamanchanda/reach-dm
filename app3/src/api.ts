/** Production API host (no trailing path). Requests use ${API_ORIGIN}/api/... */
const DEFAULT_API_ORIGIN = 'https://reach-dm-production.up.railway.app'

function normalizeApiOrigin(raw: string | undefined): string {
  let s = (raw ?? DEFAULT_API_ORIGIN).trim()
  if (!s) return DEFAULT_API_ORIGIN
  // Relative values like "/api" (Vite proxy style) strip to "" — must not build relative fetch URLs.
  s = s.replace(/\/api\/?$/, '')
  s = s.replace(/\/+$/, '')
  if (!s || s === 'http:' || s === 'https:') return DEFAULT_API_ORIGIN
  return s
}

/** Base origin only (Socket.IO, etc.). Same as pre-normalize VITE without /api suffix. */
export const API = normalizeApiOrigin(import.meta.env.VITE_API_URL as string | undefined)

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  // Always: https://reach-dm-production.up.railway.app/api/...
  return `${API}/api${p}`
}

function authHeaders(token: string): HeadersInit {
  const t = token.trim()
  return {
    Authorization: `Bearer ${t}`,
    Accept: 'application/json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  }
}

function parseErrorBody(text: string, httpStatus: number): string {
  const trimmed = text.trim()
  if (!trimmed) return `HTTP ${httpStatus}`
  try {
    const data = JSON.parse(trimmed) as { detail?: unknown }
    const d = data.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d))
      return d.map((x: { msg?: string }) => x.msg).filter(Boolean).join(', ') || trimmed
  } catch {
    /* plain text */
  }
  return trimmed
}

function parseJsonSafe<T>(text: string): T {
  const t = text.trim()
  if (!t) return {} as T
  try {
    return JSON.parse(t) as T
  } catch {
    return {} as T
  }
}

export type User = {
  id: string
  phone: string
  full_name: string | null
  role: string
  organisation_id: string | null
}

export async function login(phone: string, password: string) {
  const r = await fetch(apiUrl('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ phone, password }),
    cache: 'no-store',
  })
  const text = await r.text()
  if (!r.ok) {
    throw new Error(parseErrorBody(text, r.status))
  }
  return parseJsonSafe<{ access_token: string; user: User }>(text)
}

export async function fetchJson<T>(path: string, token: string): Promise<T> {
  if (!token?.trim()) throw new Error('Not signed in (missing token)')
  const r = await fetch(apiUrl(path), {
    headers: authHeaders(token),
    cache: 'no-store',
  })
  const text = await r.text()
  if (!r.ok) throw new Error(parseErrorBody(text, r.status))
  return parseJsonSafe<T>(text)
}

export async function patchJson<T>(path: string, token: string, body: unknown): Promise<T> {
  if (!token?.trim()) throw new Error('Not signed in (missing token)')
  const r = await fetch(apiUrl(path), {
    method: 'PATCH',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(parseErrorBody(text, r.status))
  return parseJsonSafe<T>(text)
}

export async function postJson<T>(path: string, token: string, body: unknown): Promise<T> {
  if (!token?.trim()) throw new Error('Not signed in (missing token)')
  const r = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(parseErrorBody(text, r.status))
  return parseJsonSafe<T>(text)
}
