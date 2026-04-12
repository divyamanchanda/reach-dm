/** localStorage persistence for driver assignments + pending status sync. */

const PREFIX = 'reach_driver_v1'

export type DriverSyncStep = 'accept' | 'en_route' | 'arrived' | 'clear'

/** Snapshot aligned with API incident detail fields the driver UI uses. */
export type DriverIncidentSnapshot = {
  id: string
  corridor_id: string
  incident_type: string
  severity: string
  km_marker: number | null
  latitude: number | null
  longitude: number | null
  trust_score: number
  status: string
  created_at: string
  notes: string | null
}

export type PendingDriverAction = {
  id: string
  vehicleId: string
  incidentId: string
  step: DriverSyncStep
  queuedAt: number
}

function keyCurrent(vid: string) {
  return `${PREFIX}:current:${vid}`
}
function keyRecent(vid: string) {
  return `${PREFIX}:recent:${vid}`
}
function keyPending(vid: string) {
  return `${PREFIX}:pending:${vid}`
}

function parseSnapshot(raw: string | null): DriverIncidentSnapshot | null {
  if (!raw?.trim()) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o.id !== 'string') return null
    return o as unknown as DriverIncidentSnapshot
  } catch {
    return null
  }
}

export function saveCurrentSnapshot(vehicleId: string, incident: DriverIncidentSnapshot | null): void {
  if (!vehicleId) return
  if (incident == null) {
    localStorage.removeItem(keyCurrent(vehicleId))
    return
  }
  localStorage.setItem(keyCurrent(vehicleId), JSON.stringify(incident))
}

export function loadCurrentSnapshot(vehicleId: string): DriverIncidentSnapshot | null {
  if (!vehicleId) return null
  return parseSnapshot(localStorage.getItem(keyCurrent(vehicleId)))
}

/** Keep last 5 distinct assignments (most recently touched first). */
export function recordRecentAssignment(vehicleId: string, incident: DriverIncidentSnapshot): void {
  if (!vehicleId) return
  const prev = loadRecentAssignments(vehicleId)
  const merged = [incident, ...prev.filter((x) => x.id !== incident.id)].slice(0, 5)
  localStorage.setItem(keyRecent(vehicleId), JSON.stringify(merged))
}

export function loadRecentAssignments(vehicleId: string): DriverIncidentSnapshot[] {
  if (!vehicleId) return []
  try {
    const raw = localStorage.getItem(keyRecent(vehicleId))
    if (!raw?.trim()) return []
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    const out: DriverIncidentSnapshot[] = []
    for (const row of data) {
      if (!row || typeof row !== 'object') continue
      const id = (row as { id?: unknown }).id
      if (typeof id !== 'string') continue
      out.push(row as DriverIncidentSnapshot)
    }
    return out.slice(0, 5)
  } catch {
    return []
  }
}

export function loadPendingActions(vehicleId: string): PendingDriverAction[] {
  if (!vehicleId) return []
  try {
    const raw = localStorage.getItem(keyPending(vehicleId))
    if (!raw?.trim()) return []
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return []
    const out: PendingDriverAction[] = []
    for (const row of data) {
      if (!row || typeof row !== 'object') continue
      const o = row as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.incidentId !== 'string' || typeof o.step !== 'string') continue
      if (typeof o.queuedAt !== 'number') continue
      out.push({
        id: o.id,
        vehicleId: String(o.vehicleId ?? vehicleId),
        incidentId: o.incidentId,
        step: o.step as DriverSyncStep,
        queuedAt: o.queuedAt,
      })
    }
    return out
  } catch {
    return []
  }
}

export function savePendingActions(vehicleId: string, items: PendingDriverAction[]): void {
  if (!vehicleId) return
  if (items.length === 0) {
    localStorage.removeItem(keyPending(vehicleId))
    return
  }
  localStorage.setItem(keyPending(vehicleId), JSON.stringify(items))
}

export function enqueuePendingAction(
  vehicleId: string,
  partial: Omit<PendingDriverAction, 'id' | 'queuedAt'>,
): PendingDriverAction {
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const item: PendingDriverAction = {
    id,
    queuedAt: Date.now(),
    ...partial,
    vehicleId,
  }
  const next = [...loadPendingActions(vehicleId), item]
  savePendingActions(vehicleId, next)
  return item
}

export function removePendingAction(vehicleId: string, actionId: string): void {
  savePendingActions(
    vehicleId,
    loadPendingActions(vehicleId).filter((p) => p.id !== actionId),
  )
}

export function clearPendingActions(vehicleId: string): void {
  savePendingActions(vehicleId, [])
}

/** Map API / JSON incident to a storable snapshot (notes + core fields). */
export function incidentToSnapshot(
  row: Record<string, unknown> & { id: string },
): DriverIncidentSnapshot {
  const km = row.km_marker
  const lat = row.latitude
  const lng = row.longitude
  return {
    id: row.id,
    corridor_id: String(row.corridor_id ?? ''),
    incident_type: String(row.incident_type ?? ''),
    severity: String(row.severity ?? ''),
    km_marker: typeof km === 'number' && Number.isFinite(km) ? km : km != null ? Number(km) : null,
    latitude: typeof lat === 'number' && Number.isFinite(lat) ? lat : lat != null ? Number(lat) : null,
    longitude: typeof lng === 'number' && Number.isFinite(lng) ? lng : lng != null ? Number(lng) : null,
    trust_score: typeof row.trust_score === 'number' ? row.trust_score : Number(row.trust_score) || 0,
    status: String(row.status ?? ''),
    created_at: String(row.created_at ?? ''),
    notes: row.notes == null || row.notes === '' ? null : String(row.notes),
  }
}

export function toDriverSnapshot(inc: {
  id: string
  corridor_id: string
  incident_type: string
  severity: string
  km_marker: number | null
  latitude: number | null
  longitude: number | null
  trust_score: number
  status: string
  created_at: string
  notes?: string | null
}): DriverIncidentSnapshot {
  return {
    id: inc.id,
    corridor_id: inc.corridor_id,
    incident_type: inc.incident_type,
    severity: inc.severity,
    km_marker: inc.km_marker,
    latitude: inc.latitude,
    longitude: inc.longitude,
    trust_score: inc.trust_score,
    status: inc.status,
    created_at: inc.created_at,
    notes: inc.notes ?? null,
  }
}
