const API =
  // Normalize in case VITE_API_URL was set to ".../api" (would otherwise create "/api/api/...").
  (import.meta.env.VITE_API_URL || 'https://reach-dm-production.up.railway.app').replace(/\/api\/?$/, '')
const PREFIX = '/api'

/** Same key as App — JWT from login */
export const AUTH_TOKEN_KEY = 'reach_token'

export function apiUrl(path: string) {
  return `${API}${PREFIX}${path.startsWith('/') ? path : `/${path}`}`
}

export type User = {
  id: string
  phone: string
  full_name: string | null
  role: string
  organisation_id: string | null
}

/** Thrown when the session is invalid; App should treat as logged-out (no banner error). */
export class SessionExpiredError extends Error {
  constructor(message = 'Session expired') {
    super(message)
    this.name = 'SessionExpiredError'
  }
}

export function isSessionExpiredError(e: unknown): boolean {
  return e instanceof SessionExpiredError
}

/** App registers logout here so any 401 / invalid token clears storage and UI. */
let authFailureHandler: (() => void) | null = null

export function setAuthFailureHandler(fn: (() => void) | null): void {
  authFailureHandler = fn
}

function normalizeBearerToken(token: string): string {
  return token.trim()
}

function authHeaders(token: string): HeadersInit {
  const t = normalizeBearerToken(token)
  return {
    Authorization: `Bearer ${t}`,
    Accept: 'application/json',
    'Cache-Control': 'no-store',
  }
}

function parseErrorBody(text: string, httpStatus: number): string {
  const trimmed = text.trim()
  if (!trimmed) return httpStatus === 401 ? 'Unauthorized' : `HTTP ${httpStatus}`
  try {
    const data = JSON.parse(trimmed) as { detail?: unknown }
    const d = data.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d) && d[0] && typeof d[0] === 'object' && d[0] !== null) {
      const row = d[0] as { msg?: string }
      if (typeof row.msg === 'string') return row.msg
    }
  } catch {
    /* plain text */
  }
  return trimmed.slice(0, 500)
}

function isUnauthorizedResponse(status: number, bodyText: string): boolean {
  if (status === 401) return true
  const lower = bodyText.toLowerCase()
  if (status === 403 && (lower.includes('token') || lower.includes('not authorized'))) return true
  if (lower.includes('invalid token')) return true
  if (lower.includes('could not validate credentials')) return true
  if (lower.includes('not authenticated')) return true
  try {
    const j = JSON.parse(bodyText) as { detail?: unknown }
    const d = j.detail
    const msg = typeof d === 'string' ? d : ''
    const m = msg.toLowerCase()
    return m.includes('invalid token') || m.includes('could not validate credentials')
  } catch {
    return false
  }
}

async function handleJsonResponse<T>(r: Response): Promise<T> {
  const text = await r.text()
  if (!r.ok) {
    if (isUnauthorizedResponse(r.status, text)) {
      authFailureHandler?.()
      throw new SessionExpiredError()
    }
    throw new Error(parseErrorBody(text, r.status))
  }
  if (!text.trim()) return {} as T
  return JSON.parse(text) as T
}

export async function login(phone: string, password: string) {
  const r = await fetch(apiUrl('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ phone, password }),
  })
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { detail?: string }
    throw new Error(typeof j.detail === 'string' ? j.detail : 'Login failed')
  }
  return r.json() as Promise<{ access_token: string; user: User }>
}

export async function healthPing(): Promise<boolean> {
  try {
    const r = await fetch(`${API}${PREFIX}/health`, { cache: 'no-store' })
    return r.ok
  } catch {
    return false
  }
}

export async function fetchJson<T>(path: string, token: string): Promise<T> {
  const r = await fetch(apiUrl(path), {
    headers: authHeaders(token),
    cache: 'no-store',
  })
  return handleJsonResponse<T>(r)
}

export async function postJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const r = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  })
  return handleJsonResponse<T>(r)
}

export async function deleteJson(path: string, token: string): Promise<void> {
  const r = await fetch(apiUrl(path), {
    method: 'DELETE',
    headers: authHeaders(token),
    cache: 'no-store',
  })
  const text = await r.text()
  if (!r.ok) {
    if (isUnauthorizedResponse(r.status, text)) {
      authFailureHandler?.()
      throw new SessionExpiredError()
    }
    throw new Error(parseErrorBody(text, r.status))
  }
}

export async function patchJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const r = await fetch(apiUrl(path), {
    method: 'PATCH',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  })
  return handleJsonResponse<T>(r)
}

/** Download CSV (or other attachment) from an admin GET. */
export async function downloadBlob(path: string, token: string, filename: string): Promise<void> {
  const r = await fetch(apiUrl(path), {
    headers: authHeaders(token),
    cache: 'no-store',
  })
  if (!r.ok) {
    const text = await r.text()
    if (isUnauthorizedResponse(r.status, text)) {
      authFailureHandler?.()
      throw new SessionExpiredError()
    }
    throw new Error(parseErrorBody(text, r.status))
  }
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export { API }
