const API =
  // Normalize in case VITE_API_URL was set to ".../api" (would otherwise create "/api/api/...").
  (import.meta.env.VITE_API_URL || 'https://reach-dm-production.up.railway.app').replace(/\/api\/?$/, '')
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

export async function patchJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const r = await fetch(apiUrl(path), {
    method: 'PATCH',
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

/** Download CSV (or other attachment) from an admin GET. */
export async function downloadBlob(path: string, token: string, filename: string): Promise<void> {
  const r = await fetch(apiUrl(path), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Cache-Control': 'no-store',
    },
    cache: 'no-store',
  })
  if (!r.ok) throw new Error(await r.text())
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export { API }
