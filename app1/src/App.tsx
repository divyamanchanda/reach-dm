import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { io, Socket } from 'socket.io-client'
import './App.css'
import { API, apiUrl, fetchJson, login, patchJson, postJson, type User } from './api'

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

/** True when the incident is older than 2 hours (client clock vs created_at). */
function isIncidentExpiredByAge(createdAt: string): boolean {
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return false
  return Date.now() - t > TWO_HOURS_MS
}

type Corridor = {
  id: string
  name: string
  code: string | null
  km_start: number | null
  km_end: number | null
  is_active: boolean
}

type Incident = {
  id: string
  corridor_id: string
  incident_type: string
  severity: string
  km_marker: number | null
  latitude: number | null
  longitude: number | null
  trust_score: number
  trust_recommendation: string | null
  trust_factors?: unknown[] | null
  status: string
  reporter_type: string
  injured_count: number
  public_report_id: string | null
  created_at: string
  updated_at: string
  eligible_for_reassign?: boolean
  notes?: string | null
}

type Stats = {
  active_incidents: number
  pending_dispatch: number
  available_vehicles: number
  avg_response_time_minutes: number | null
}

type CorridorVehicle = {
  id: string
  label: string
  vehicle_type: string
  status: string
  is_available: boolean
  latitude: number | null
  longitude: number | null
}

type NearbyVehicle = {
  vehicle_id: string
  label: string
  status: string
  distance_meters: number
  eta_minutes: number | null
  eta_source: 'route' | 'fallback'
}

type AssignedVehicle = {
  vehicle_id: string
  label: string
}

/** Full row from GET /incidents/:id (list endpoint omits notes). */
type IncidentDetail = {
  id: string
  corridor_id: string
  incident_type: string
  severity: string
  km_marker: number | null
  latitude: number | null
  longitude: number | null
  trust_score: number
  trust_recommendation: string | null
  trust_factors: unknown[]
  status: string
  reporter_type: string
  injured_count: number
  notes: string | null
  photo_url: string | null
  public_report_id: string | null
  created_at: string
  updated_at: string
  timeline: { id: string; event_type: string; payload: Record<string, unknown> | null; created_at: string }[]
}

const severityColor: Record<string, string> = {
  critical: '#b91c1c',
  major: '#d97706',
  minor: '#15803d',
}

function relativeReportedTime(createdAt: string): string {
  const diffMs = Date.now() - new Date(createdAt).getTime()
  const diffMins = Math.max(0, Math.floor(diffMs / 60000))
  if (diffMins < 1) return 'just now'
  if (diffMins === 1) return '1 min ago'
  if (diffMins < 60) return `${diffMins} mins ago`
  const hours = Math.floor(diffMins / 60)
  if (hours === 1) return '1 hr ago'
  if (hours < 24) return `${hours} hrs ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/** True only if `created_at` is a valid time within the last 5 minutes (not in the future). */
function isNewIncident(createdAt: string): boolean {
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return false
  const ageMs = Date.now() - t
  if (ageMs < 0) return false
  return ageMs <= 5 * 60 * 1000
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2 }

function severityRank(sev: string): number {
  return SEVERITY_ORDER[sev.toLowerCase()] ?? 9
}

/** Expired / closed — keep at end of the list. */
function isExpiredOrClosedStatus(status: string): boolean {
  return status === 'expired' || status === 'closed' || status === 'archived'
}

/** Active first; then expired/closed. Within each bucket: severity, then newest first. */
function sortIncidentsByPriority(items: Incident[]): Incident[] {
  return [...items].sort((a, b) => {
    const ab = isExpiredOrClosedStatus(a.status) ? 1 : 0
    const bb = isExpiredOrClosedStatus(b.status) ? 1 : 0
    if (ab !== bb) return ab - bb
    const rs = severityRank(a.severity) - severityRank(b.severity)
    if (rs !== 0) return rs
    return +new Date(b.created_at) - +new Date(a.created_at)
  })
}

const AVG_CORRIDOR_KMH = 80

/** NH48 Bengaluru → Chennai corridor length used for KM interpolation and vehicle ETA projection. */
const NH48_TOTAL_KM = 312

function kmFromLatLng(lat: number, lng: number): number {
  const bengaluru = { lat: 12.9716, lng: 77.5946 }
  const chennai = { lat: 13.0827, lng: 80.2707 }
  const dx = chennai.lng - bengaluru.lng
  const dy = chennai.lat - bengaluru.lat
  const px = lng - bengaluru.lng
  const py = lat - bengaluru.lat
  const denom = dx * dx + dy * dy
  const t = denom > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / denom)) : 0
  return t * NH48_TOTAL_KM
}

function etaMinutesFromKmGap(kmA: number, kmB: number): number {
  return Math.max(1, Math.round((Math.abs(kmA - kmB) / AVG_CORRIDOR_KMH) * 60))
}

function formatShortTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

function nearestAmbulanceOneLine(v: NearbyVehicle): string {
  const km = v.distance_meters / 1000
  const kmStr = km < 10 ? km.toFixed(1) : km.toFixed(0)
  const eta = v.eta_minutes != null ? `~${Math.round(v.eta_minutes)} min away` : 'ETA —'
  return `${v.label} · ${kmStr} km · ${eta}`
}

type TimelineStep = { key: string; label: string; at: Date | null; done: boolean }

function buildIncidentTimelineSteps(detail: IncidentDetail): TimelineStep[] {
  const reported = new Date(detail.created_at)
  let dispatchedAt: Date | null = null
  let acceptedAt: Date | null = null
  let arrivedAt: Date | null = null
  let clearedAt: Date | null = null

  const events = [...detail.timeline].sort(
    (a, b) => +new Date(a.created_at) - +new Date(b.created_at),
  )
  for (const ev of events) {
    if (ev.event_type === 'dispatch') dispatchedAt = new Date(ev.created_at)
    if (ev.event_type === 'status_change' && ev.payload && typeof ev.payload === 'object') {
      const st = (ev.payload as { status?: string }).status
      if (st === 'accepted' || st === 'en_route') acceptedAt = new Date(ev.created_at)
      if (st === 'arrived') arrivedAt = new Date(ev.created_at)
      if (st === 'closed') clearedAt = new Date(ev.created_at)
    }
  }
  if (detail.status === 'closed' && !clearedAt) clearedAt = new Date(detail.updated_at)

  return [
    { key: 'reported', label: 'Reported', at: reported, done: true },
    { key: 'dispatched', label: 'Dispatched', at: dispatchedAt, done: dispatchedAt != null },
    { key: 'accepted', label: 'Driver accepted', at: acceptedAt, done: acceptedAt != null },
    { key: 'arrived', label: 'Arrived', at: arrivedAt, done: arrivedAt != null },
    { key: 'cleared', label: 'Cleared', at: clearedAt, done: clearedAt != null },
  ]
}

function playNewIncidentBeep(): void {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    const o = ctx.createOscillator()
    o.connect(ctx.destination)
    o.start()
    o.stop(ctx.currentTime + 0.3)
    o.onended = () => ctx.close()
  } catch {
    /* ignore */
  }
}

const SHIFT_NOTES_KEY = 'reach_dispatch_shift_notes_v1'
const SHIFT_HANDOVER_KEY = 'reach_dispatch_shift_handover_v1'

function isPendingDispatchStatus(status: string): boolean {
  return ['open', 'verifying', 'confirmed_real'].includes(status)
}

function dispatchUrgencyClass(createdAt: string, status: string): '' | 'inc-card--urgent-warn' | 'inc-card--urgent-crit' {
  if (!isPendingDispatchStatus(status)) return ''
  const ageMin = (Date.now() - new Date(createdAt).getTime()) / 60000
  if (ageMin > 10) return 'inc-card--urgent-crit'
  if (ageMin > 5) return 'inc-card--urgent-warn'
  return ''
}

function incidentCardEta(
  i: Incident,
  assigned: AssignedVehicle | undefined,
  vehicles: CorridorVehicle[],
): string | null {
  if (i.status !== 'dispatched' || !assigned) return null
  if (i.km_marker == null || !Number.isFinite(i.km_marker)) return null
  const v = vehicles.find((x) => x.id === assigned.vehicle_id)
  if (v?.latitude == null || v?.longitude == null) return null
  if (!Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) return null
  const vk = kmFromLatLng(v.latitude, v.longitude)
  const mins = etaMinutesFromKmGap(vk, i.km_marker)
  return `ETA: ${mins} mins`
}

function statusLabel(status: string): string {
  if (status === 'confirmed_real') return 'Verified ✓'
  if (status === 'recalled') return 'Hoax — Recalled'
  if (status === 'expired') return 'Expired'
  return status
}

function reporterCountFromTrustFactors(factors: unknown): number {
  if (!Array.isArray(factors)) return 1
  for (const raw of factors) {
    if (raw && typeof raw === 'object' && 'factor' in raw) {
      const f = raw as { factor?: string; count?: number }
      if (f.factor === 'multiple_reports' && typeof f.count === 'number') return Math.max(1, f.count)
    }
  }
  return 1
}

function hasAiVerifiedFactor(factors: unknown): boolean {
  if (!Array.isArray(factors)) return false
  return factors.some((raw) => {
    if (!raw || typeof raw !== 'object' || !('factor' in raw)) return false
    return (raw as { factor?: string }).factor === 'ai_verified'
  })
}

function hasIncidentGps(lat: number | null, lng: number | null): boolean {
  return lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)
}

type DispatchTrustTier = 'verified' | 'likely' | 'unverified'

function deriveDispatchTrustDisplay(input: {
  status: string
  trust_factors: unknown
  latitude: number | null
  longitude: number | null
}): {
  tier: DispatchTrustTier
  emoji: string
  label: string
  reporterCount: number
  className: string
} {
  const reporters = reporterCountFromTrustFactors(input.trust_factors)
  const ai = hasAiVerifiedFactor(input.trust_factors)
  const gps = hasIncidentGps(input.latitude, input.longitude)
  const operatorConfirmed = input.status === 'confirmed_real'

  if (operatorConfirmed || reporters >= 3) {
    return {
      tier: 'verified',
      emoji: '🟢',
      label: 'Verified',
      reporterCount: reporters,
      className: 'dispatch-trust-badge--verified',
    }
  }
  if (ai || gps || reporters >= 2) {
    return {
      tier: 'likely',
      emoji: '🟡',
      label: 'Likely Real',
      reporterCount: reporters,
      className: 'dispatch-trust-badge--likely',
    }
  }
  return {
    tier: 'unverified',
    emoji: '🔴',
    label: 'Unverified',
    reporterCount: reporters,
    className: 'dispatch-trust-badge--unverified',
  }
}

function DispatchTrustBadge({
  incident,
  detail,
}: {
  incident: Incident
  detail?: IncidentDetail | null
}) {
  const src = detail?.id === incident.id ? detail : incident
  const factors = detail?.id === incident.id ? (detail.trust_factors ?? []) : (incident.trust_factors ?? [])
  const lat = src.latitude ?? incident.latitude
  const lng = src.longitude ?? incident.longitude
  const d = deriveDispatchTrustDisplay({
    status: src.status,
    trust_factors: factors,
    latitude: lat,
    longitude: lng,
  })
  const reportsText = `${d.reporterCount} ${d.reporterCount === 1 ? 'report' : 'reports'}`
  return (
    <span className={`dispatch-trust-badge ${d.className}`}>
      {d.emoji} {d.label} · {reportsText}
    </span>
  )
}

const DISPATCH_NO_AMBULANCE = '__reach_no_ambulance__'

const DISPATCH_BTN_HINT =
  'Sends the nearest ranked ambulance when possible; otherwise any ambulance on this corridor marked available. Hover a red error message for details.'

function parseFastApiDetail(raw: string): string {
  const t = raw.trim()
  try {
    const j = JSON.parse(t) as { detail?: unknown }
    if (typeof j.detail === 'string') return j.detail
    if (Array.isArray(j.detail) && j.detail[0] && typeof j.detail[0] === 'object' && j.detail[0] !== null) {
      const row = j.detail[0] as { msg?: string }
      if (typeof row.msg === 'string') return row.msg
    }
  } catch {
    /* not JSON */
  }
  return t.slice(0, 500)
}

function humanizeDispatchFailure(e: unknown): { line: string; hint: string } {
  if (e instanceof Error && e.message === DISPATCH_NO_AMBULANCE) {
    return {
      line: 'No ambulances available on this corridor.',
      hint: 'There is no available ambulance in the ranked list and none free on this corridor. Add a unit or mark one available, then try again.',
    }
  }
  const raw = e instanceof Error ? e.message : String(e)
  const detail = parseFastApiDetail(raw)
  const lower = detail.toLowerCase()

  if (lower.includes('not dispatchable')) {
    return {
      line: 'Cannot dispatch — incident is closed or cancelled.',
      hint: 'The server rejected dispatch because this incident is not open for assignment. Refresh the list.',
    }
  }
  if (lower.includes('vehicle not available')) {
    return {
      line: 'Cannot dispatch — that ambulance is no longer available.',
      hint: 'Another operator may have assigned it, or status changed. Refresh and dispatch again.',
    }
  }
  if (lower.includes('not an ambulance')) {
    return {
      line: 'Cannot dispatch — selected unit is not an ambulance.',
      hint: 'Pick a different vehicle or refresh corridor data if this looks wrong.',
    }
  }
  if (lower.includes('not found')) {
    return {
      line: 'Dispatch failed — incident or vehicle not found.',
      hint: 'Data may be stale. Refresh the incident list and try again.',
    }
  }
  const line = detail.length > 140 ? `${detail.slice(0, 137)}…` : detail || 'Dispatch failed.'
  return {
    line,
    hint: detail || 'Unexpected server response. Check the network or try again.',
  }
}

function estimatePointFromKm(km: number): { lat: number; lng: number } {
  const bengaluru = { lat: 12.9716, lng: 77.5946 }
  const chennai = { lat: 13.0827, lng: 80.2707 }
  const t = Math.min(1, Math.max(0, km / NH48_TOTAL_KM))
  return {
    lat: bengaluru.lat + (chennai.lat - bengaluru.lat) * t,
    lng: bengaluru.lng + (chennai.lng - bengaluru.lng) * t,
  }
}

function RecenterMap({ latitude, longitude }: { latitude: number; longitude: number }) {
  const map = useMap()
  useEffect(() => {
    map.setView([latitude, longitude], Math.max(map.getZoom(), 13))
    // Ensures Leaflet recalculates tile container size after React/Vercel layout changes.
    map.invalidateSize()
  }, [latitude, longitude, map])
  return null
}

function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('reach_token'))
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem('reach_user')
    return raw ? JSON.parse(raw) : null
  })
  const [phone, setPhone] = useState('+919876543210')
  const [password, setPassword] = useState('reach2026')
  const [error, setError] = useState<string | null>(null)
  const [errorHint, setErrorHint] = useState<string | null>(null)

  const [corridors, setCorridors] = useState<Corridor[]>([])
  const [corridorId, setCorridorId] = useState<string | null>(null)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [nearby, setNearby] = useState<NearbyVehicle[]>([])
  const [socket, setSocket] = useState<Socket | null>(null)
  const [incidentDetail, setIncidentDetail] = useState<IncidentDetail | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [dispatchingByIncidentId, setDispatchingByIncidentId] = useState<Record<string, boolean>>({})
  const [vehicleLabelById, setVehicleLabelById] = useState<Record<string, string>>({})
  const vehicleLabelByIdRef = useRef<Record<string, string>>({})
  const [assignedVehicleByIncidentId, setAssignedVehicleByIncidentId] = useState<
    Record<string, AssignedVehicle>
  >({})
  const [corridorVehicles, setCorridorVehicles] = useState<CorridorVehicle[]>([])
  const [expandedTimelineId, setExpandedTimelineId] = useState<string | null>(null)
  const [timelineById, setTimelineById] = useState<Record<string, IncidentDetail>>({})
  const [etaTick, setEtaTick] = useState(0)
  const [shiftNotes, setShiftNotes] = useState(() => localStorage.getItem(SHIFT_NOTES_KEY) ?? '')
  const [shiftNotesEditedAt, setShiftNotesEditedAt] = useState<string | null>(() =>
    localStorage.getItem('reach_shift_notes_edit_v1'),
  )
  const [shiftHandoverLine, setShiftHandoverLine] = useState<string | null>(() => {
    const raw = localStorage.getItem(SHIFT_HANDOVER_KEY)
    if (!raw) return null
    try {
      const j = JSON.parse(raw) as { at?: string; by?: string }
      if (j.at && j.by) return `Handed over by ${j.by} at ${new Date(j.at).toLocaleString()}`
    } catch {
      /* ignore */
    }
    return null
  })
  const [operatorNoteDraft, setOperatorNoteDraft] = useState<Record<string, string>>({})
  const [savingNotesForId, setSavingNotesForId] = useState<string | null>(null)
  /** Re-render periodically: NEW badges, and client-side 2h expiry vs created_at. */
  const [_newBadgeTick, setNewBadgeTick] = useState(0)
  /** Bumps every 30s so undispatched urgency (5/10 min) re-evaluates from `created_at`. */
  const [ageTick, setAgeTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      setNewBadgeTick((n) => n + 1)
      setAgeTick((n) => n + 1)
    }, 30_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setEtaTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const sortedIncidents = useMemo(() => sortIncidentsByPriority(incidents), [incidents])

  const selected = useMemo(
    () => incidents.find((i) => i.id === selectedId) ?? null,
    [incidents, selectedId],
  )

  const refreshLists = useCallback(
    async (cid: string, t: string) => {
      const [inc, st] = await Promise.all([
        fetchJson<Incident[]>(`/corridors/${cid}/incidents`, t),
        fetchJson<Stats>(`/corridors/${cid}/stats`, t),
      ])
      setIncidents(inc)
      setStats(st)
      fetchJson<CorridorVehicle[]>(`/corridors/${cid}/vehicles`, t)
        .then((vehicles) => {
          setCorridorVehicles(vehicles)
          const map: Record<string, string> = {}
          for (const vehicle of vehicles) map[vehicle.id] = vehicle.label
          setVehicleLabelById(map)
          vehicleLabelByIdRef.current = map
        })
        .catch(() => {})
    },
    [],
  )

  useEffect(() => {
    if (!token) return
    fetchJson<Corridor[]>('/corridors', token)
      .then((c) => {
        setCorridors(c)
        setCorridorId((prev) => prev ?? (c[0]?.id ?? null))
      })
      .catch((e) => {
        setErrorHint(null)
        setError(String(e))
      })
  }, [token])

  useEffect(() => {
    if (!token || !corridorId) return
    refreshLists(corridorId, token).catch((e) => {
      setErrorHint(null)
      setError(String(e))
    })
  }, [token, corridorId, refreshLists])

  useEffect(() => {
    if (!token || !corridorId) return
    const id = window.setInterval(() => {
      refreshLists(corridorId, token).catch(() => {})
    }, 30_000)
    return () => window.clearInterval(id)
  }, [token, corridorId, refreshLists])

  useEffect(() => {
    if (!token || !corridorId) return
    const s = io(API, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
    })
    s.on('connect', () => {
      s.emit('subscribe_corridor', { corridor_id: corridorId })
    })
    const bump = () => refreshLists(corridorId, token).catch(() => {})
    const onNewIncident = () => {
      playNewIncidentBeep()
      bump()
    }
    const onDispatched = (payload: { incident_id?: string; vehicle_id?: string }) => {
      if (payload?.incident_id && payload?.vehicle_id) {
        setAssignedVehicleByIncidentId((prev) => ({
          ...prev,
          [payload.incident_id!]: {
            vehicle_id: payload.vehicle_id!,
            label: vehicleLabelByIdRef.current[payload.vehicle_id!] ?? `Vehicle ${payload.vehicle_id!.slice(0, 8)}`,
          },
        }))
        setIncidents((prev) =>
          prev.map((incident) =>
            incident.id === payload.incident_id ? { ...incident, status: 'dispatched' } : incident,
          ),
        )
      }
      bump()
    }
    s.on('incident:new', onNewIncident)
    s.on('incident:updated', bump)
    s.on('incident:dispatched', onDispatched)
    s.on('incident:recalled', bump)
    s.on('corridor:stats', bump)
    setSocket(s)
    return () => {
      s.off('incident:new', onNewIncident)
      s.off('incident:dispatched', onDispatched)
      s.emit('unsubscribe_corridor', { corridor_id: corridorId })
      s.disconnect()
      setSocket(null)
    }
  }, [token, corridorId, refreshLists])

  useEffect(() => {
    if (!token || !selectedId) {
      setIncidentDetail(null)
      return
    }
    fetchJson<IncidentDetail>(`/incidents/${selectedId}`, token)
      .then(setIncidentDetail)
      .catch(() => setIncidentDetail(null))
  }, [token, selectedId])

  useEffect(() => {
    if (!token || !expandedTimelineId) return
    if (expandedTimelineId === selectedId && incidentDetail?.id === expandedTimelineId) {
      setTimelineById((prev) => ({ ...prev, [expandedTimelineId]: incidentDetail }))
      return
    }
    let cancelled = false
    fetchJson<IncidentDetail>(`/incidents/${expandedTimelineId}`, token)
      .then((d) => {
        if (!cancelled) setTimelineById((prev) => ({ ...prev, [expandedTimelineId]: d }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [token, expandedTimelineId, selectedId, incidentDetail])

  useEffect(() => {
    if (!token || !selectedId) {
      setNearby([])
      return
    }
    const status =
      incidentDetail?.id === selectedId ? incidentDetail.status : incidents.find((i) => i.id === selectedId)?.status
    if (status && isExpiredOrClosedStatus(status)) {
      setNearby([])
      return
    }
    fetchJson<NearbyVehicle[]>(`/incidents/${selectedId}/nearby-vehicles`, token)
      .then(setNearby)
      .catch(() => setNearby([]))
  }, [token, selectedId, incidents, incidentDetail?.id, incidentDetail?.status])

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setErrorHint(null)
    try {
      const res = await login(phone, password)
      localStorage.setItem('reach_token', res.access_token)
      localStorage.setItem('reach_user', JSON.stringify(res.user))
      setToken(res.access_token)
      setUser(res.user)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed')
      setErrorHint(null)
    }
  }

  const logout = () => {
    localStorage.removeItem('reach_token')
    localStorage.removeItem('reach_user')
    setToken(null)
    setUser(null)
    socket?.disconnect()
  }

  const dispatchIncident = async (incident: Incident) => {
    if (
      !token ||
      isIncidentExpiredByAge(incident.created_at) ||
      ['dispatched', 'recalled', 'confirmed_real', 'expired'].includes(incident.status) ||
      incident.eligible_for_reassign ||
      dispatchingByIncidentId[incident.id]
    )
      return
    setError(null)
    setErrorHint(null)
    setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: true }))
    try {
      const nearbyVehicles = await fetchJson<NearbyVehicle[]>(`/incidents/${incident.id}/nearby-vehicles`, token)
      let selectedVehicle =
        nearbyVehicles.find((vehicle) => vehicle.status === 'available') ?? nearbyVehicles[0]

      // Low-trust / no-GPS incidents can have no nearby ranking; fallback to any available corridor ambulance.
      if (!selectedVehicle && corridorId) {
        const corridorVehicles = await fetchJson<CorridorVehicle[]>(`/corridors/${corridorId}/vehicles`, token)
        const fallback = corridorVehicles.find(
          (vehicle) =>
            vehicle.vehicle_type === 'ambulance' && vehicle.is_available && vehicle.status === 'available',
        )
        if (fallback) {
          selectedVehicle = {
            vehicle_id: fallback.id,
            label: fallback.label,
            status: fallback.status,
            distance_meters: 0,
            eta_minutes: null,
            eta_source: 'fallback',
          }
        }
      }

      if (!selectedVehicle) {
        throw new Error(DISPATCH_NO_AMBULANCE)
      }

      await postJson(`/incidents/${incident.id}/dispatch`, token, {
        vehicle_id: selectedVehicle.vehicle_id,
      })

      setAssignedVehicleByIncidentId((prev) => ({
        ...prev,
        [incident.id]: {
          vehicle_id: selectedVehicle.vehicle_id,
          label: selectedVehicle.label,
        },
      }))
      setIncidents((prev) =>
        prev.map((row) => (row.id === incident.id ? { ...row, status: 'dispatched' } : row)),
      )
      if (corridorId) await refreshLists(corridorId, token)
      if (selectedId === incident.id) {
        fetchJson<IncidentDetail>(`/incidents/${incident.id}`, token)
          .then(setIncidentDetail)
          .catch(() => {})
      }
    } catch (e: unknown) {
      const { line, hint } = humanizeDispatchFailure(e)
      setError(line)
      setErrorHint(hint)
    } finally {
      setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: false }))
    }
  }

  const reassignIncident = async (incident: Incident) => {
    if (!token || isIncidentExpiredByAge(incident.created_at) || !incident.eligible_for_reassign || dispatchingByIncidentId[incident.id])
      return
    setError(null)
    setErrorHint(null)
    setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: true }))
    try {
      await patchJson(`/incidents/${incident.id}/reassign`, token, {})
      setIncidents((prev) =>
        prev.map((row) => (row.id === incident.id ? { ...row, status: 'dispatched' } : row)),
      )
      if (corridorId) await refreshLists(corridorId, token)
      if (selectedId === incident.id) {
        fetchJson<IncidentDetail>(`/incidents/${incident.id}`, token)
          .then(setIncidentDetail)
          .catch(() => {})
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Reassign failed')
      setErrorHint(null)
    } finally {
      setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: false }))
    }
  }

  const confirmRealIncident = async (incident: Incident) => {
    if (!token || isIncidentExpiredByAge(incident.created_at) || dispatchingByIncidentId[incident.id]) return
    setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: true }))
    setError(null)
    setErrorHint(null)
    setIncidents((prev) =>
      prev.map((row) => (row.id === incident.id ? { ...row, status: 'confirmed_real' } : row)),
    )
    setIncidentDetail((d) =>
      d && d.id === incident.id ? { ...d, status: 'confirmed_real' } : d,
    )
    try {
      await patchJson(`/incidents/${incident.id}/status`, token, { status: 'confirmed_real' })
      if (corridorId) await refreshLists(corridorId, token)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed confirming incident')
      if (corridorId && token) await refreshLists(corridorId, token).catch(() => {})
    } finally {
      setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: false }))
    }
  }

  const recallIncident = async (incident: Incident) => {
    if (!token || isIncidentExpiredByAge(incident.created_at) || dispatchingByIncidentId[incident.id]) return
    setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: true }))
    setError(null)
    setErrorHint(null)
    try {
      await postJson(`/incidents/${incident.id}/recall`, token, {})
      if (corridorId) await refreshLists(corridorId, token)
      if (selectedId === incident.id) {
        fetchJson<IncidentDetail>(`/incidents/${incident.id}`, token)
          .then(setIncidentDetail)
          .catch(() => {})
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed recalling incident')
    } finally {
      setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: false }))
    }
  }

  const saveOperatorIncidentNotes = async (incidentId: string, notes: string) => {
    if (!token) return
    setSavingNotesForId(incidentId)
    setError(null)
    try {
      const detail = await patchJson<IncidentDetail>(`/incidents/${incidentId}`, token, { notes })
      setIncidents((prev) => prev.map((row) => (row.id === incidentId ? { ...row, notes: detail.notes } : row)))
      if (selectedId === incidentId) setIncidentDetail(detail)
      setTimelineById((prev) => ({ ...prev, [incidentId]: detail }))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save notes')
    } finally {
      setSavingNotesForId(null)
    }
  }

  if (!token || !user) {
    return (
      <div className="page">
        <header className="topbar">
          <h1>REACH — Dispatch Console</h1>
        </header>
        <main className="login-panel">
          <form onSubmit={doLogin} className="card">
            <h2>Sign in</h2>
            <label>
              Phone
              <input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="username" />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            {error && <p className="err">{error}</p>}
            <button type="submit">Continue</button>
            <p className="hint">Demo: +919876543210 / reach2026 (after seed)</p>
          </form>
        </main>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>REACH — Dispatch Console</h1>
          <span className="sub">{user.full_name ?? user.phone}</span>
        </div>
        <div className="stats" hidden={!stats}>
          {stats && (
            <>
              <span>Active: {stats.active_incidents}</span>
              <span>Pending: {stats.pending_dispatch}</span>
              <span>Vehicles: {stats.available_vehicles}</span>
              <span>
                Avg response:{' '}
                {stats.avg_response_time_minutes != null
                  ? `${stats.avg_response_time_minutes.toFixed(1)} min`
                  : '—'}
              </span>
            </>
          )}
        </div>
        <div className="top-actions">
          <label>
            Corridor
            <select
              value={corridorId ?? ''}
              onChange={(e) => {
                setCorridorId(e.target.value)
                setSelectedId(null)
              }}
            >
              {corridors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="list">
          <h3>Live incidents</h3>
          {sortedIncidents.map((i) => {
            void etaTick
            void ageTick
            return (
            <div
              key={i.id}
              role="button"
              tabIndex={0}
              className={`inc-card ${selectedId === i.id ? 'active' : ''} ${dispatchUrgencyClass(i.created_at, i.status)}`}
              onClick={() => {
                setSelectedId(i.id)
                setExpandedTimelineId((e) => (e === i.id ? null : i.id))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedId(i.id)
                  setExpandedTimelineId((ex) => (ex === i.id ? null : i.id))
                }
              }}
              style={{ borderLeftColor: severityColor[i.severity] ?? '#64748b' }}
            >
              <div className="row">
                <strong>{i.incident_type}</strong>
                <div className="chip-row">
                  {i.severity.toLowerCase() === 'critical' && (
                    <span className="priority-badge">PRIORITY</span>
                  )}
                  {isNewIncident(i.created_at) && <span className="new-pill">NEW</span>}
                  <span className="pill" style={{ background: severityColor[i.severity] }}>
                    {i.severity}
                  </span>
                </div>
              </div>
              <div className="meta inc-card-trust-line">
                <DispatchTrustBadge incident={i} detail={selectedId === i.id ? incidentDetail : null} />
              </div>
              <div className="meta">KM {i.km_marker ?? '—'}</div>
              <div className="meta">
                Report {(i.public_report_id ?? i.id).slice(0, 8)} · {relativeReportedTime(i.created_at)}
              </div>
              <div className="meta">{statusLabel(i.status)}</div>
              {(() => {
                const etaLine = incidentCardEta(i, assignedVehicleByIncidentId[i.id], corridorVehicles)
                return etaLine ? <div className="meta inc-eta">{etaLine}</div> : null
              })()}
              {assignedVehicleByIncidentId[i.id] && (
                <div className="meta">
                  Assigned: {vehicleLabelById[assignedVehicleByIncidentId[i.id].vehicle_id] ?? assignedVehicleByIncidentId[i.id].label}
                </div>
              )}
              <div className="inc-card-notes" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <label className="inc-notes-label">Operator notes</label>
                <textarea
                  className="inc-notes-input"
                  rows={2}
                  placeholder="e.g. Caller says truck is blocking both lanes"
                  value={operatorNoteDraft[i.id] ?? i.notes ?? ''}
                  onChange={(e) => setOperatorNoteDraft((prev) => ({ ...prev, [i.id]: e.target.value }))}
                />
                <div className="inc-notes-actions">
                  <button
                    type="button"
                    className="inc-notes-save"
                    disabled={savingNotesForId === i.id}
                    onClick={() => void saveOperatorIncidentNotes(i.id, operatorNoteDraft[i.id] ?? i.notes ?? '')}
                  >
                    {savingNotesForId === i.id ? 'Saving…' : 'Save notes'}
                  </button>
                </div>
              </div>
              <div className="row inc-card-footer-links">
                <button
                  type="button"
                  className="link-button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedId(i.id)
                    setIsDetailOpen(true)
                  }}
                >
                  Full details
                </button>
              </div>
              {expandedTimelineId === i.id ? (
                timelineById[i.id] ? (
                  <div className="incident-card-timeline" onClick={(e) => e.stopPropagation()}>
                    <div className="incident-card-timeline-title">Incident timeline</div>
                    <ol className="incident-card-timeline-steps">
                      {buildIncidentTimelineSteps(timelineById[i.id]).map((step) => (
                        <li key={step.key} className="incident-card-timeline-step">
                          <span
                            className={`timeline-dot ${step.done ? 'timeline-dot--done' : 'timeline-dot--pending'}`}
                            aria-hidden
                          />
                          <span className="timeline-step-text">
                            {step.label}
                            {step.at ? (
                              <>
                                {' '}
                                at {formatShortTime(step.at)}
                              </>
                            ) : (
                              <span className="timeline-step-pending"> — pending</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : (
                  <div className="incident-card-timeline incident-card-timeline--loading" onClick={(e) => e.stopPropagation()}>
                    Loading timeline…
                  </div>
                )
              ) : null}
              {isIncidentExpiredByAge(i.created_at) || i.status === 'expired' ? (
                <span className="expired-badge" title="Older than 2 hours since created — no actions available">
                  Expired
                </span>
              ) : i.status === 'recalled' ? (
                <p className="recall-msg">Ambulance recalled — hoax confirmed</p>
              ) : i.status === 'confirmed_real' ? (
                <p className="confirm-msg">Incident verified as real ✓</p>
              ) : i.status === 'dispatched' ? (
                <div className="card-dispatch-actions card-dispatch-stack">
                  <div className="card-dispatch-actions">
                    <button
                      type="button"
                      className="dispatch-btn confirm-btn"
                      disabled={!!dispatchingByIncidentId[i.id]}
                      onClick={(e) => {
                        e.stopPropagation()
                        void confirmRealIncident(i)
                      }}
                    >
                      Confirmed Real ✓
                    </button>
                    <button
                      type="button"
                      className="dispatch-btn recall-btn"
                      disabled={!!dispatchingByIncidentId[i.id]}
                      onClick={(e) => {
                        e.stopPropagation()
                        void recallIncident(i)
                      }}
                    >
                      Hoax — Recall ✗
                    </button>
                  </div>
                  {i.eligible_for_reassign ? (
                    <button
                      type="button"
                      className="dispatch-btn reassign-btn"
                      disabled={!!dispatchingByIncidentId[i.id]}
                      onClick={(e) => {
                        e.stopPropagation()
                        void reassignIncident(i)
                      }}
                    >
                      {dispatchingByIncidentId[i.id] ? 'Reassigning...' : 'Reassign'}
                    </button>
                  ) : null}
                </div>
              ) : i.eligible_for_reassign ? (
                <button
                  type="button"
                  className="dispatch-btn reassign-btn card-dispatch-btn"
                  disabled={!!dispatchingByIncidentId[i.id]}
                  onClick={(e) => {
                    e.stopPropagation()
                    void reassignIncident(i)
                  }}
                >
                  {dispatchingByIncidentId[i.id] ? 'Reassigning...' : 'Reassign'}
                </button>
              ) : (
                <button
                  type="button"
                  className="dispatch-btn card-dispatch-btn"
                  title={DISPATCH_BTN_HINT}
                  disabled={!!dispatchingByIncidentId[i.id]}
                  onClick={(e) => {
                    e.stopPropagation()
                    void dispatchIncident(i)
                  }}
                >
                  {dispatchingByIncidentId[i.id] ? 'Dispatching...' : 'Dispatch'}
                </button>
              )}
            </div>
            )
          })}
        </aside>

        <aside className="detail">
          {!selected && <p className="detail-empty-prompt">Select an incident.</p>}
          {selected && (
            <div className="detail-panel-inner">
              <button
                type="button"
                className="detail-panel-close"
                aria-label="Close and clear selection"
                title="Close"
                onClick={() => {
                  setSelectedId(null)
                  setExpandedTimelineId(null)
                  setIsDetailOpen(false)
                }}
              >
                ×
              </button>

              <header className="detail-hero">
                <div className="detail-hero-km">
                  <span className="detail-hero-km-label">KM</span>
                  <span className="detail-hero-km-num">{selected.km_marker ?? '—'}</span>
                </div>
                <h2 className="detail-hero-type">{selected.incident_type}</h2>
                <div className="detail-hero-badges">
                  <DispatchTrustBadge incident={selected} detail={incidentDetail?.id === selected.id ? incidentDetail : null} />
                  <span className="pill detail-severity-pill" style={{ background: severityColor[selected.severity] ?? '#64748b' }}>
                    {selected.severity}
                  </span>
                  <span className="detail-status-pill">{statusLabel(selected.status)}</span>
                </div>
              </header>

              <div className="detail-map-block">
                <h3 className="detail-section-title">Location</h3>
                <div className="map-placeholder detail-map-placeholder">
                  {(() => {
                    const lat = incidentDetail?.latitude ?? selected.latitude
                    const lng = incidentDetail?.longitude ?? selected.longitude
                    const km = selected.km_marker
                    const hasGps =
                      lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)
                    const kmNum = km != null && Number.isFinite(km) ? Number(km) : null
                    const fromKm =
                      !hasGps && kmNum != null ? estimatePointFromKm(kmNum) : null
                    const isEstimated = Boolean(fromKm)
                    const finalLat = hasGps ? lat! : fromKm?.lat ?? null
                    const finalLng = hasGps ? lng! : fromKm?.lng ?? null

                    if (finalLat == null || finalLng == null) {
                      return <p className="detail-map-fallback">No map position — add GPS or a KM marker along NH48.</p>
                    }

                    const markerColor = isEstimated ? '#f59e0b' : '#ef4444'
                    const tooltipText = isEstimated
                      ? `~KM ${kmNum} (estimated)`
                      : `GPS${kmNum != null ? ` · KM ${kmNum}` : ''}`

                    return (
                      <>
                        <p className="detail-map-source">
                          {isEstimated
                            ? `Approximate position on NH48 from KM marker (no GPS). Axis: Bengaluru–Chennai, ${NH48_TOTAL_KM} km.`
                            : 'Showing reported GPS coordinates on the map.'}
                        </p>
                        <MapContainer
                          className="leaflet-map detail-leaflet-map"
                          center={[finalLat, finalLng]}
                          zoom={13}
                          scrollWheelZoom
                        >
                          <TileLayer
                            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                          />
                          <CircleMarker
                            center={[finalLat, finalLng]}
                            radius={10}
                            pathOptions={{
                              color: markerColor,
                              fillColor: markerColor,
                              fillOpacity: 0.75,
                            }}
                          >
                            <Tooltip
                              permanent
                              direction="top"
                              offset={[0, -6]}
                              opacity={1}
                              className="dispatch-map-tooltip"
                            >
                              {tooltipText}
                            </Tooltip>
                            <Popup>
                              {isEstimated ? (
                                <>
                                  ~KM {kmNum} (estimated)
                                  <br />
                                  <span className="map-popup-sub">NH48 Bengaluru → Chennai</span>
                                </>
                              ) : (
                                <>
                                  {selected.incident_type}
                                  <br />
                                  <span className="map-popup-sub">GPS location</span>
                                </>
                              )}
                            </Popup>
                          </CircleMarker>
                          <RecenterMap latitude={finalLat} longitude={finalLng} />
                        </MapContainer>
                        <a
                          className="link detail-osm-link"
                          href={`https://www.openstreetmap.org/?mlat=${finalLat}&mlon=${finalLng}#map=14/${finalLat}/${finalLng}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in OpenStreetMap
                        </a>
                      </>
                    )
                  })()}
                </div>
              </div>

              <div className="detail-meta-two-col">
                <div className="detail-meta-col">
                  <div className="detail-meta-label">Reported by</div>
                  <div className="detail-meta-value detail-meta-reporter">{selected.reporter_type}</div>
                  <div className="detail-meta-time">{new Date(selected.created_at).toLocaleString()}</div>
                  <div className="detail-meta-relative">{relativeReportedTime(selected.created_at)}</div>
                </div>
                <div className="detail-meta-col">
                  <div className="detail-meta-label">Injured</div>
                  <div className="detail-meta-injured">{incidentDetail?.injured_count ?? selected.injured_count}</div>
                  <div className="detail-meta-label detail-meta-notes-label">Notes</div>
                  <div className="detail-meta-notes">
                    {incidentDetail?.notes?.trim() ? incidentDetail.notes : '—'}
                  </div>
                </div>
              </div>

              {incidentDetail && incidentDetail.id === selected.id && (
                <div className="detail-timeline-compact">
                  <h3 className="detail-section-title">Timeline</h3>
                  <ul className="detail-timeline-steps">
                    {buildIncidentTimelineSteps(incidentDetail).map((step) => (
                      <li key={step.key} className="detail-timeline-step">
                        <span
                          className={`timeline-dot ${step.done ? 'timeline-dot--done' : 'timeline-dot--pending'}`}
                          aria-hidden
                        />
                        <span className="detail-timeline-time">
                          {step.at ? formatShortTime(step.at) : '—'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(() => {
                const statusForUi =
                  incidentDetail?.id === selected.id ? incidentDetail.status : selected.status
                if (isExpiredOrClosedStatus(statusForUi)) return null
                const first = nearby[0]
                if (!first) return null
                return (
                  <div className="detail-nearest-amb">
                    <h3 className="detail-section-title">Nearest ambulance</h3>
                    <p className="detail-ambulance-line">{nearestAmbulanceOneLine(first)}</p>
                  </div>
                )
              })()}
              {isIncidentExpiredByAge(selected.created_at) || selected.status === 'expired' ? (
                <span className="expired-badge" title="Older than 2 hours since created — no actions available">
                  Expired
                </span>
              ) : selected.status === 'recalled' ? (
                <p className="recall-msg">Ambulance recalled — hoax confirmed</p>
              ) : selected.status === 'confirmed_real' ? (
                <p className="confirm-msg">Incident verified as real ✓</p>
              ) : selected.status === 'dispatched' ? (
                <div className="card-dispatch-actions card-dispatch-stack">
                  <div className="card-dispatch-actions">
                    <button
                      type="button"
                      className="dispatch-btn confirm-btn"
                      disabled={!!dispatchingByIncidentId[selected.id]}
                      onClick={() => void confirmRealIncident(selected)}
                    >
                      Confirmed Real ✓
                    </button>
                    <button
                      type="button"
                      className="dispatch-btn recall-btn"
                      disabled={!!dispatchingByIncidentId[selected.id]}
                      onClick={() => void recallIncident(selected)}
                    >
                      Hoax — Recall ✗
                    </button>
                  </div>
                  {selected.eligible_for_reassign ? (
                    <button
                      type="button"
                      className="dispatch-btn reassign-btn"
                      disabled={!!dispatchingByIncidentId[selected.id]}
                      onClick={() => void reassignIncident(selected)}
                    >
                      {dispatchingByIncidentId[selected.id] ? 'Reassigning...' : 'Reassign'}
                    </button>
                  ) : null}
                </div>
              ) : selected.eligible_for_reassign ? (
                <button
                  type="button"
                  className="dispatch-btn reassign-btn"
                  disabled={!!dispatchingByIncidentId[selected.id]}
                  onClick={() => void reassignIncident(selected)}
                >
                  {dispatchingByIncidentId[selected.id] ? 'Reassigning...' : 'Reassign'}
                </button>
              ) : (
                <button
                  type="button"
                  className="dispatch-btn"
                  title={DISPATCH_BTN_HINT}
                  disabled={!!dispatchingByIncidentId[selected.id]}
                  onClick={() => void dispatchIncident(selected)}
                >
                  {dispatchingByIncidentId[selected.id] ? 'Dispatching...' : 'Dispatch nearest available'}
                </button>
              )}
              {error && (
                <p className="err" title={errorHint ?? undefined}>
                  {error}
                  {errorHint ? <span className="err-hint-hint"> (hover for details)</span> : null}
                </p>
              )}
            </div>
          )}
        </aside>

        <aside className="shift-notes-panel">
          <h3>Shift notes</h3>
          <p className="hint shift-notes-hint">Saved on this device. Use at end of shift.</p>
          <textarea
            className="shift-notes-textarea"
            rows={12}
            value={shiftNotes}
            onChange={(e) => {
              const v = e.target.value
              setShiftNotes(v)
              localStorage.setItem(SHIFT_NOTES_KEY, v)
              const ts = new Date().toISOString()
              localStorage.setItem('reach_shift_notes_edit_v1', ts)
              setShiftNotesEditedAt(ts)
            }}
            placeholder="Equipment checks, corridor issues, handover items…"
          />
          <div className="shift-notes-meta">
            <span className="shift-notes-ts">
              Last edited: {shiftNotesEditedAt ? new Date(shiftNotesEditedAt).toLocaleString() : '—'}
            </span>
          </div>
          <div className="shift-notes-actions">
            <button
              type="button"
              className="dispatch-btn handover-btn"
              onClick={() => {
                const name = user.full_name?.trim() || user.phone || 'Operator'
                const at = new Date().toISOString()
                localStorage.setItem(SHIFT_HANDOVER_KEY, JSON.stringify({ at, by: name }))
                setShiftHandoverLine(`Handed over by ${name} at ${new Date().toLocaleString()}`)
              }}
            >
              Hand over
            </button>
          </div>
          {shiftHandoverLine ? <p className="shift-handover-line">{shiftHandoverLine}</p> : null}
        </aside>
      </div>
      {selected && isDetailOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setIsDetailOpen(false)}
          role="presentation"
        >
          <section
            className="incident-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Incident details"
          >
            <div className="incident-modal-header">
              <h2>Incident details</h2>
              <button type="button" onClick={() => setIsDetailOpen(false)}>
                Close
              </button>
            </div>
            <dl className="kv modal-kv">
              <dt>ID</dt>
              <dd>{selected.id}</dd>
              <dt>Type</dt>
              <dd>{selected.incident_type}</dd>
              <dt>Severity</dt>
              <dd>{selected.severity}</dd>
              <dt>Status</dt>
              <dd>{selected.status}</dd>
              <dt>Corridor</dt>
              <dd>{selected.corridor_id}</dd>
              <dt>Reporter</dt>
              <dd>{selected.reporter_type}</dd>
              <dt>KM marker</dt>
              <dd>{incidentDetail?.km_marker ?? selected.km_marker ?? '—'}</dd>
              <dt>Injured count</dt>
              <dd>{incidentDetail?.injured_count ?? selected.injured_count}</dd>
              <dt>Created</dt>
              <dd>{new Date(selected.created_at).toLocaleString()}</dd>
              <dt>Updated</dt>
              <dd>{new Date(selected.updated_at).toLocaleString()}</dd>
              <dt>Photo URL</dt>
              <dd>
                {incidentDetail?.photo_url ? (
                  <a className="link" href={incidentDetail.photo_url} target="_blank" rel="noreferrer">
                    Open photo
                  </a>
                ) : (
                  '—'
                )}
              </dd>
              <dt>Location link</dt>
              <dd>
                {(() => {
                  const lat = incidentDetail?.latitude ?? selected.latitude
                  const lng = incidentDetail?.longitude ?? selected.longitude
                  if (lat == null || lng == null) return '—'
                  return (
                    <a
                      className="link"
                      href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open map location
                    </a>
                  )
                })()}
              </dd>
              <dt>Notes</dt>
              <dd className="notes-dd modal-notes">
                {incidentDetail?.notes?.trim() ? incidentDetail.notes : '—'}
              </dd>
            </dl>
            {incidentDetail?.trust_factors?.length ? (
              <div className="modal-section">
                <h4>Trust factors</h4>
                <pre className="json-block">{JSON.stringify(incidentDetail.trust_factors, null, 2)}</pre>
              </div>
            ) : null}
            {incidentDetail?.timeline?.length ? (
              <div className="modal-section">
                <h4>Timeline</h4>
                <ul className="vehicle-list">
                  {incidentDetail.timeline.map((ev) => (
                    <li key={ev.id}>
                      <strong>{ev.event_type}</strong> - {new Date(ev.created_at).toLocaleString()}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </div>
      )}
      <footer className="footer">
        API <code>{apiUrl('/health')}</code>
      </footer>
    </div>
  )
}

export default App
