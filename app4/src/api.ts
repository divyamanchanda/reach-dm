const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const PREFIX = '/api'

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

export async function login(phone: string, password: string) {
  const r = await fetch(apiUrl('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    headers: {
      Authorization: `Bearer ${token}`,
      'Cache-Control': 'no-store',
    },
    cache: 'no-store',
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

export async function postJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const r = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json() as Promise<T>
}

export async function deleteJson(path: string, token: string): Promise<void> {
  const r = await fetch(apiUrl(path), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Cache-Control': 'no-store',
    },
    cache: 'no-store',
  })
  if (!r.ok) throw new Error(await r.text())
}

export { API }
