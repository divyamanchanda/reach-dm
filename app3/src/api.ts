const API =
  import.meta.env.VITE_API_URL || 'https://reach-dm-production.up.railway.app'
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
    cache: 'no-store',
  })
  if (!r.ok) {
    const data = (await r.json()) as { detail?: unknown }
    const detail = data.detail
    const msg =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join(', ')
          : 'Login failed'
    throw new Error(msg || 'Login failed')
  }
  return r.json() as Promise<{ access_token: string; user: User }>
}

export async function fetchJson<T>(path: string, token: string): Promise<T> {
  const r = await fetch(apiUrl(path), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
    cache: 'no-store',
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function patchJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const r = await fetch(apiUrl(path), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export async function postJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const r = await fetch(apiUrl(path), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
    cache: 'no-store',
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export { API }
