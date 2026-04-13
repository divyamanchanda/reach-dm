export type DriverBroadcastPayload = {
  id: string
  message: string
  created_at: string
  sender_name: string
  priority: 'urgent' | 'info' | null
}

const LOG_KEY = (userId: string) => `reach3_broadcasts_v1:${userId}`

export function parseBroadcastPayload(raw: unknown): DriverBroadcastPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const message = typeof o.message === 'string' ? o.message.trim() : ''
  if (!message) return null
  const id =
    typeof o.id === 'string' && o.id.trim()
      ? o.id.trim()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const created_at = typeof o.created_at === 'string' ? o.created_at : new Date().toISOString()
  const sender_name =
    typeof o.sender_name === 'string' && o.sender_name.trim() ? o.sender_name.trim() : 'Dispatch Control'
  let priority: 'urgent' | 'info' | null = null
  if (o.priority === 'urgent' || o.priority === 'info') priority = o.priority
  return { id, message, created_at, sender_name, priority }
}

export function loadBroadcastLog(userId: string): DriverBroadcastPayload[] {
  try {
    const raw = localStorage.getItem(LOG_KEY(userId))
    if (!raw) return []
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    const out: DriverBroadcastPayload[] = []
    for (const row of data) {
      const p = parseBroadcastPayload(row)
      if (p) out.push(p)
    }
    return out.slice(0, 5)
  } catch {
    return []
  }
}

export function saveBroadcastLog(userId: string, items: DriverBroadcastPayload[]) {
  try {
    localStorage.setItem(LOG_KEY(userId), JSON.stringify(items.slice(0, 5)))
  } catch {
    /* ignore quota */
  }
}

/** Newest first, max 5, deduped by id. */
export function mergeBroadcastIntoLog(userId: string, item: DriverBroadcastPayload, prev: DriverBroadcastPayload[]) {
  const next = [item, ...prev.filter((x) => x.id !== item.id)].slice(0, 5)
  saveBroadcastLog(userId, next)
  return next
}

export function clearBroadcastLog(userId: string) {
  try {
    localStorage.removeItem(LOG_KEY(userId))
  } catch {
    /* ignore */
  }
}

/** Short alert when driver has an active assignment (e.g. en route). */
export function playDriverBroadcastAlert() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const playBeep = (start: number, freq: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(0.12, start + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.18)
      o.connect(g)
      g.connect(ctx.destination)
      o.start(start)
      o.stop(start + 0.2)
    }
    playBeep(ctx.currentTime, 880)
    playBeep(ctx.currentTime + 0.22, 660)
    ctx.resume().catch(() => {})
    window.setTimeout(() => {
      try {
        ctx.close()
      } catch {
        /* ignore */
      }
    }, 600)
  } catch {
    /* ignore */
  }
}
