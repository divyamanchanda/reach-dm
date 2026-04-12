const STORAGE_KEY = 'reach_sos_pending_v1'
/** Keep queued reports until successfully sent (reasonable upper bound). */
export const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export type PendingSosPayload = {
  incident_type: string
  severity: string
  injured_count: number
  notes?: string
  latitude?: number
  longitude?: number
  km_marker?: number
}

export type PendingSos = {
  id: string
  queuedAt: number
  corridorId: string
  body: PendingSosPayload
}

function safeParse(raw: string | null): PendingSos[] {
  if (!raw?.trim()) return []
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    const out: PendingSos[] = []
    for (const row of data) {
      if (!row || typeof row !== 'object') continue
      const o = row as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.queuedAt !== 'number' || typeof o.corridorId !== 'string')
        continue
      if (!o.body || typeof o.body !== 'object') continue
      out.push({
        id: o.id,
        queuedAt: o.queuedAt,
        corridorId: o.corridorId,
        body: o.body as PendingSosPayload,
      })
    }
    return out
  } catch {
    return []
  }
}

export function loadPending(): PendingSos[] {
  return safeParse(localStorage.getItem(STORAGE_KEY))
}

export function savePending(items: PendingSos[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
}

export function enqueuePending(corridorId: string, body: PendingSosPayload): PendingSos {
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  const item: PendingSos = { id, queuedAt: Date.now(), corridorId, body }
  const next = [...loadPending(), item]
  savePending(next)
  return item
}

export function removePending(id: string): void {
  savePending(loadPending().filter((p) => p.id !== id))
}
