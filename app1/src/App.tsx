import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { latLngBounds } from 'leaflet'
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet'
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
  driver_phone?: string | null
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

/** True if reported within the last 30 minutes (not in the future). */
function isNewIncident(createdAt: string): boolean {
  const t = new Date(createdAt).getTime()
  if (Number.isNaN(t)) return false
  const ageMs = Date.now() - t
  if (ageMs < 0) return false
  return ageMs <= 30 * 60 * 1000
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2 }

function severityRank(sev: string): number {
  return SEVERITY_ORDER[sev.toLowerCase()] ?? 9
}

/** Expired / closed — e.g. no nearby-vehicle queries. */
function isExpiredOrClosedStatus(status: string): boolean {
  return status === 'expired' || status === 'closed' || status === 'archived'
}

/** Terminal / inactive — always sort below any active incident. */
function isTerminalSortStatus(status: string): boolean {
  const s = status.toLowerCase()
  return ['expired', 'closed', 'archived', 'recalled', 'cancelled'].includes(s)
}

/** open → verifying → confirmed → dispatched / en route / on scene; NEW (<30m) before older; terminal last. */
function sortIncidentsDispatchConsole(items: Incident[]): Incident[] {
  const statusOrder = (status: string): number => {
    const s = status.toLowerCase()
    if (s === 'open') return 0
    if (s === 'verifying') return 1
    if (s === 'confirmed_real') return 2
    if (['dispatched', 'en_route', 'on_scene', 'transporting', 'accepted'].includes(s)) return 3
    return 5
  }
  return [...items].sort((a, b) => {
    const ta = isTerminalSortStatus(a.status)
    const tb = isTerminalSortStatus(b.status)
    if (ta !== tb) return ta ? 1 : -1
    const na = !ta && isNewIncident(a.created_at)
    const nb = !tb && isNewIncident(b.created_at)
    if (na !== nb) return na ? -1 : 1
    const ra = statusOrder(a.status)
    const rb = statusOrder(b.status)
    if (ra !== rb) return ra - rb
    const sr = severityRank(a.severity) - severityRank(b.severity)
    if (sr !== 0) return sr
    return +new Date(b.created_at) - +new Date(a.created_at)
  })
}

function isStatusExpired(status: string): boolean {
  return status === 'expired'
}

const AVG_CORRIDOR_KMH = 80

/** NH48 Bengaluru → Chennai corridor length used for KM interpolation and vehicle ETA projection. */
const NH48_TOTAL_KM = 312

const NH48_ROUTE_LINE: [number, number][] = [
  [12.9716, 77.5946],
  [12.7409, 77.8253],
  [12.5266, 78.2137],
  [12.9165, 79.1325],
  [13.0827, 80.2707],
]

function hasValidKmMarker(km: number | null | undefined): km is number {
  return km != null && Number.isFinite(km)
}

function formatHeaderAvgDispatchMinutes(raw: number | null): string {
  if (raw == null) return '—'
  if (raw > 200) return '—'
  const capped = Math.min(raw, 999)
  return `${capped.toFixed(1)} min`
}

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

/** Loud multi-beep for critical incidents (dispatch console). */
function playCriticalAlarm(): void {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    const g = ctx.createGain()
    g.gain.value = 0.42
    g.connect(ctx.destination)
    const playOne = (offset: number) => {
      const o = ctx.createOscillator()
      o.type = 'square'
      o.frequency.value = 920
      o.connect(g)
      o.start(ctx.currentTime + offset)
      o.stop(ctx.currentTime + offset + 0.14)
    }
    playOne(0)
    playOne(0.2)
    playOne(0.4)
    playOne(0.62)
    window.setTimeout(() => {
      ctx.close().catch(() => {})
    }, 900)
  } catch {
    playNewIncidentBeep()
  }
}

const SHIFT_NOTES_KEY = 'reach_dispatch_shift_notes_v1'
const SHIFT_HANDOVER_KEY = 'reach_dispatch_shift_handover_v1'
const OPERATOR_PHONE_KEY = 'reach_dispatch_operator_phone_v1'
const NEXT_OPERATOR_PHONE_KEY = 'reach_dispatch_next_operator_phone_v1'
const CRITICAL_ALERTED_KEY = 'reach_dispatch_critical_alerted_v1'

function loadCriticalAlertedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(CRITICAL_ALERTED_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.map(String) : [])
  } catch {
    return new Set()
  }
}

function saveCriticalAlertedIds(ids: Set<string>): void {
  localStorage.setItem(CRITICAL_ALERTED_KEY, JSON.stringify([...ids]))
}

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

function hasIncidentGps(lat: number | null, lng: number | null): boolean {
  return lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)
}

type DispatchTrustTier = 'verified' | 'likely' | 'unverified'

function deriveDispatchTrustDisplay(input: {
  status: string
  trust_factors: unknown
  latitude: number | null
  longitude: number | null
  km_marker: number | null
}): {
  tier: DispatchTrustTier
  emoji: string
  label: string
  reporterCount: number
  className: string
} {
  const reporters = reporterCountFromTrustFactors(input.trust_factors)
  const gps = hasIncidentGps(input.latitude, input.longitude)
  const hasKm = hasValidKmMarker(input.km_marker)
  const operatorConfirmed = input.status === 'confirmed_real'
  const blockLikelyKmNoGps = hasKm && !gps
  const allowLikely = !blockLikelyKmNoGps && (gps || reporters >= 2)

  if (operatorConfirmed || reporters >= 3) {
    return {
      tier: 'verified',
      emoji: '🟢',
      label: 'Verified',
      reporterCount: reporters,
      className: 'dispatch-trust-badge--verified',
    }
  }
  if (allowLikely) {
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
    km_marker: incident.km_marker,
  })
  const reportsText = `${d.reporterCount} ${d.reporterCount === 1 ? 'report' : 'reports'}`
  return (
    <span className={`dispatch-trust-badge ${d.className}`}>
      {d.emoji} {d.label} · {reportsText}
    </span>
  )
}

function incidentTypeIcon(incidentType: string): string {
  const t = incidentType.toLowerCase().replace(/_/g, ' ')
  if (t.includes('accident')) return '🚗'
  if (t.includes('pedestrian')) return '🚶'
  if (t.includes('truck')) return '🚛'
  if (t.includes('medical')) return '🏥'
  if (t.includes('fire')) return '🔥'
  if (t.includes('motorcycle') || t.includes('bike')) return '🏍️'
  if (t.includes('animal')) return '🐄'
  if (t.includes('hazard') || t.includes('debris')) return '⚠️'
  return '📋'
}

function humanizeIncidentType(incidentType: string): string {
  return incidentType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function buildDriverDispatchSms(incident: Incident, operatorDisplayName: string): string {
  const km =
    incident.km_marker != null && Number.isFinite(Number(incident.km_marker))
      ? `KM${Math.round(Number(incident.km_marker))}`
      : 'KM unknown'
  const type = humanizeIncidentType(incident.incident_type)
  const sev = incident.severity.toLowerCase()
  return `REACH DISPATCH: ${type} ${km} ${sev}. Proceed immediately. - ${operatorDisplayName}`
}

function normalizeTelDigits(phone: string): string {
  const t = phone.trim()
  if (t.startsWith('+')) return `+${t.slice(1).replace(/\D/g, '')}`
  return t.replace(/\D/g, '')
}

function smsHref(phone: string, body: string): string {
  const n = normalizeTelDigits(phone)
  return `sms:${n}?body=${encodeURIComponent(body)}`
}

function telHref(phone: string): string {
  return `tel:${normalizeTelDigits(phone)}`
}

function reportedViaLabel(reporterType: string): string {
  const r = reporterType.toLowerCase().trim()
  if (r === 'public_sos') return 'Public SOS app'
  if (r === 'sms' || r.includes('sms')) return 'SMS'
  return humanizeIncidentType(reporterType)
}

function formatTrustFactorBullet(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || !('factor' in raw)) return null
  const o = raw as { factor?: string; weight?: number; count?: number; note?: string }
  switch (o.factor) {
    case 'public_sos_gps':
      return '📍 GPS location provided by reporter'
    case 'public_sos_no_gps':
      return '📍 No GPS — location estimated from KM marker'
    case 'no_gps_deduction':
      return '📍 Trust score reduced for missing GPS'
    case 'photo_uploaded':
      return '📷 Photo attached to report'
    case 'multiple_reports':
      return `👥 ${typeof o.count === 'number' ? o.count : 'Multiple'} nearby reports corroborate this incident`
    case 'single_report':
      return '👤 Only one report in the area'
    case 'sms_report':
      return '📱 Reported via SMS channel'
    case 'ai_verified':
      return o.note ? `✓ ${o.note}` : '✓ Automated assessment: likely real'
    default:
      if (typeof o.note === 'string' && o.note.trim()) return `• ${o.note}`
      if (o.factor) return `• ${o.factor.replace(/_/g, ' ')}`
      return null
  }
}

function severityDetailBadgeClass(severity: string): string {
  const s = severity.toLowerCase()
  if (s === 'critical') return 'detail-pill detail-pill--sev-critical'
  if (s === 'major') return 'detail-pill detail-pill--sev-major'
  if (s === 'minor') return 'detail-pill detail-pill--sev-minor'
  return 'detail-pill detail-pill--muted'
}

function statusDetailBadgeClass(status: string): string {
  const s = status.toLowerCase()
  if (s === 'closed' || s === 'archived' || s === 'expired' || s === 'cancelled') return 'detail-pill detail-pill--st-muted'
  if (s === 'recalled') return 'detail-pill detail-pill--st-danger'
  if (s === 'confirmed_real' || s === 'arrived' || s === 'on_scene') return 'detail-pill detail-pill--st-ok'
  if (s === 'dispatched' || s === 'en_route' || s === 'accepted') return 'detail-pill detail-pill--st-warn'
  if (s === 'open' || s === 'verifying') return 'detail-pill detail-pill--st-info'
  return 'detail-pill detail-pill--muted'
}

function humanizeTimelineEventType(eventType: string): string {
  return eventType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
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

function incidentMapPoint(i: Incident): [number, number] | null {
  if (hasIncidentGps(i.latitude, i.longitude)) {
    return [i.latitude as number, i.longitude as number]
  }
  if (hasValidKmMarker(i.km_marker)) {
    const p = estimatePointFromKm(Number(i.km_marker))
    return [p.lat, p.lng]
  }
  return null
}

function OverviewFitBounds({ latLngs }: { latLngs: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (latLngs.length === 0) {
      map.setView([12.9, 78.2], 7)
    } else {
      map.fitBounds(latLngBounds(latLngs), { padding: [48, 48], maxZoom: 11 })
    }
    map.invalidateSize()
  }, [map, latLngs])
  return null
}

function DispatchCorridorOverviewMap({
  incidents,
  onSelectIncident,
}: {
  incidents: Incident[]
  onSelectIncident: (id: string) => void
}) {
  const latLngs = useMemo(() => {
    const pts: [number, number][] = NH48_ROUTE_LINE.map((p) => [p[0], p[1]])
    for (const i of incidents) {
      if (isTerminalSortStatus(i.status)) continue
      const pt = incidentMapPoint(i)
      if (pt) pts.push(pt)
    }
    return pts
  }, [incidents])

  return (
    <div className="dispatch-overview-map-wrap">
      <MapContainer
        className="leaflet-map dispatch-overview-map"
        center={[12.9, 78.2]}
        zoom={7}
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Polyline
          positions={NH48_ROUTE_LINE}
          pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.92, lineCap: 'round' }}
        />
        {incidents.map((i) => {
          if (isTerminalSortStatus(i.status)) return null
          const pt = incidentMapPoint(i)
          if (!pt) return null
          const fill = severityColor[i.severity] ?? '#ef4444'
          return (
            <CircleMarker
              key={i.id}
              center={pt}
              radius={8}
              pathOptions={{
                color: '#0f172a',
                weight: 2,
                fillColor: fill,
                fillOpacity: 0.9,
              }}
              eventHandlers={{ click: () => onSelectIncident(i.id) }}
            >
              <Popup>
                {humanizeIncidentType(i.incident_type)}
                <br />
                <span className="map-popup-sub">{i.status}</span>
              </Popup>
            </CircleMarker>
          )
        })}
        <OverviewFitBounds latLngs={latLngs} />
      </MapContainer>
    </div>
  )
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
  /** Status `expired` cards: collapsed by default until operator expands. */
  const [expiredCardsExpanded, setExpiredCardsExpanded] = useState<Record<string, boolean>>({})
  const [showExpiredIncidents, setShowExpiredIncidents] = useState(false)
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
  const [operatorPhone, setOperatorPhone] = useState(() => localStorage.getItem(OPERATOR_PHONE_KEY) ?? '')
  const [nextOperatorPhone, setNextOperatorPhone] = useState(() => localStorage.getItem(NEXT_OPERATOR_PHONE_KEY) ?? '')
  const [criticalBanner, setCriticalBanner] = useState<{ id: string; km: string; typeLabel: string } | null>(null)
  const criticalAlertedRef = useRef<Set<string>>(loadCriticalAlertedIds())
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

  useEffect(() => {
    if (!token) return
    for (const inc of incidents) {
      if (inc.severity.toLowerCase() !== 'critical') continue
      if (isExpiredOrClosedStatus(inc.status)) continue
      if (criticalAlertedRef.current.has(inc.id)) continue
      criticalAlertedRef.current.add(inc.id)
      saveCriticalAlertedIds(criticalAlertedRef.current)
      playCriticalAlarm()
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('REACH Dispatch — CRITICAL', {
            body: `${humanizeIncidentType(inc.incident_type)} · ${
              hasValidKmMarker(inc.km_marker) ? `KM ${inc.km_marker}` : 'KM unknown'
            }`,
            tag: `critical-${inc.id}`,
            requireInteraction: true,
          })
        } catch {
          /* ignore */
        }
      }
      const km =
        hasValidKmMarker(inc.km_marker) ? String(inc.km_marker) : 'unknown'
      setCriticalBanner({
        id: inc.id,
        km,
        typeLabel: humanizeIncidentType(inc.incident_type),
      })
      window.setTimeout(() => {
        setCriticalBanner((b) => (b?.id === inc.id ? null : b))
      }, 90_000)
    }
  }, [incidents, token])

  const sortedIncidents = useMemo(() => sortIncidentsDispatchConsole(incidents), [incidents])
  const expiredIncidentCount = useMemo(
    () => incidents.filter((i) => i.status === 'expired').length,
    [incidents],
  )
  const visibleIncidents = useMemo(
    () => (showExpiredIncidents ? sortedIncidents : sortedIncidents.filter((i) => i.status !== 'expired')),
    [sortedIncidents, showExpiredIncidents],
  )

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
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission()
      }
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
                Avg dispatch time: {formatHeaderAvgDispatchMinutes(stats.avg_response_time_minutes)}
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
          <details className="dispatch-settings">
            <summary className="dispatch-settings-summary">Settings</summary>
            <div className="dispatch-settings-body">
              <label className="dispatch-settings-label">
                Phone number
                <input
                  type="tel"
                  className="dispatch-settings-input"
                  value={operatorPhone}
                  onChange={(e) => {
                    const v = e.target.value
                    setOperatorPhone(v)
                    localStorage.setItem(OPERATOR_PHONE_KEY, v)
                  }}
                  placeholder="+91…"
                  autoComplete="tel"
                />
              </label>
              <p className="hint dispatch-settings-hint">Saved on this device. Shown in SMS templates.</p>
              {typeof Notification !== 'undefined' && Notification.permission !== 'granted' ? (
                <button
                  type="button"
                  className="dispatch-notify-btn"
                  onClick={() => void Notification.requestPermission()}
                >
                  Enable browser alerts
                </button>
              ) : (
                <p className="hint dispatch-settings-hint">Browser alerts enabled for critical incidents.</p>
              )}
            </div>
          </details>
          <button type="button" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      {criticalBanner ? (
        <div className="critical-flash-banner" role="alert">
          <span className="critical-flash-banner-text">
            🚨 NEW CRITICAL INCIDENT — KM {criticalBanner.km} — {criticalBanner.typeLabel}
          </span>
          <button type="button" className="critical-flash-dismiss" onClick={() => setCriticalBanner(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="layout">
        <aside className="list">
          <h3>Live incidents</h3>
          {expiredIncidentCount > 0 ? (
            <div className="dispatch-list-toolbar">
              <button
                type="button"
                className="dispatch-toggle-expired-btn"
                onClick={() => setShowExpiredIncidents((v) => !v)}
              >
                {showExpiredIncidents ? 'Hide expired' : 'Show expired'} ({expiredIncidentCount})
              </button>
            </div>
          ) : null}
          {visibleIncidents.map((i) => {
            void etaTick
            void ageTick
            const isExp = isStatusExpired(i.status)
            const expiredExpanded = !!expiredCardsExpanded[i.id]
            const isExpCollapsed = isExp && !expiredExpanded
            const hidePriorityBadge = i.status === 'expired'
            return (
            <div
              key={i.id}
              role="button"
              tabIndex={0}
              className={`inc-card ${selectedId === i.id ? 'active' : ''} ${dispatchUrgencyClass(i.created_at, i.status)} ${isExp ? 'inc-card--expired' : ''}`}
              onClick={() => {
                setSelectedId(i.id)
                if (isExp && !expiredCardsExpanded[i.id]) {
                  setExpiredCardsExpanded((p) => ({ ...p, [i.id]: true }))
                  return
                }
                setExpandedTimelineId((e) => (e === i.id ? null : i.id))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedId(i.id)
                  if (isExp && !expiredCardsExpanded[i.id]) {
                    setExpiredCardsExpanded((p) => ({ ...p, [i.id]: true }))
                    return
                  }
                  setExpandedTimelineId((ex) => (ex === i.id ? null : i.id))
                }
              }}
              style={{ borderLeftColor: isExp ? '#64748b' : severityColor[i.severity] ?? '#64748b' }}
            >
              {isExpCollapsed ? (
                <>
                  <div className="row">
                    <strong>{i.incident_type}</strong>
                    <span className="pill pill--expired-label">
                      <span className="expired-pill-long">Expired</span>
                      <span className="expired-pill-short">EXP</span>
                    </span>
                  </div>
                  <div className={`meta ${!hasValidKmMarker(i.km_marker) ? 'inc-km-unknown' : ''}`}>
                    {hasValidKmMarker(i.km_marker) ? `KM ${i.km_marker}` : 'KM unknown'}
                  </div>
                  <div className="meta">{relativeReportedTime(i.created_at)}</div>
                </>
              ) : (
                <>
              <div className="row">
                <strong>{i.incident_type}</strong>
                <div className="chip-row">
                  {i.severity.toLowerCase() === 'critical' && !hidePriorityBadge && (
                    <span className="priority-badge">PRIORITY</span>
                  )}
                  {!isExp && isNewIncident(i.created_at) && <span className="new-pill">NEW</span>}
                  {isExp ? (
                    <span className="pill pill--expired-label">
                      <span className="expired-pill-long">Expired</span>
                      <span className="expired-pill-short">EXP</span>
                    </span>
                  ) : (
                    <span className="pill" style={{ background: severityColor[i.severity] }}>
                      {i.severity}
                    </span>
                  )}
                </div>
              </div>
              {isExp && expiredExpanded ? (
                <div className="inc-card-expired-toolbar">
                  <button
                    type="button"
                    className="link-button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpiredCardsExpanded((p) => {
                        const next = { ...p }
                        delete next[i.id]
                        return next
                      })
                      setExpandedTimelineId((ex) => (ex === i.id ? null : ex))
                    }}
                  >
                    Show less
                  </button>
                </div>
              ) : null}
              <div className="meta inc-card-trust-line">
                <DispatchTrustBadge incident={i} detail={selectedId === i.id ? incidentDetail : null} />
              </div>
              <div className={`meta ${!hasValidKmMarker(i.km_marker) ? 'inc-km-unknown' : ''}`}>
                {hasValidKmMarker(i.km_marker) ? `KM ${i.km_marker}` : 'KM unknown'}
              </div>
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
              {isIncidentExpiredByAge(i.created_at) && i.status !== 'expired' ? (
                <span className="expired-badge" title="Older than 2 hours since created — no actions available">
                  <span className="expired-badge-long">Expired</span>
                  <span className="expired-badge-short">EXP</span>
                </span>
              ) : i.status === 'expired' ? null : i.status === 'recalled' ? (
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
                </>
              )}
            </div>
            )
          })}
        </aside>

        <aside className="detail">
          {!selected && (
            <div className="detail-overview-empty">
              <h3 className="detail-section-title">NH48 corridor</h3>
              <p className="detail-overview-hint">
                Active incidents are shown on the map. Select a dot or choose an incident from the list.
              </p>
              <DispatchCorridorOverviewMap incidents={incidents} onSelectIncident={setSelectedId} />
            </div>
          )}
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
                  {hasValidKmMarker(selected.km_marker) ? (
                    <span className="detail-hero-km-num">{selected.km_marker}</span>
                  ) : (
                    <span className="detail-hero-km-num detail-hero-km-unknown">unknown</span>
                  )}
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

              {selected.status === 'dispatched' && assignedVehicleByIncidentId[selected.id] ? (
                <div className="detail-driver-contact">
                  <h3 className="detail-section-title">Driver</h3>
                  {(() => {
                    const vid = assignedVehicleByIncidentId[selected.id].vehicle_id
                    const drv = corridorVehicles.find((v) => v.id === vid)
                    const driverPhone = drv?.driver_phone?.trim()
                    const opName = user.full_name?.trim() || user.phone || 'Dispatch'
                    const smsBody = buildDriverDispatchSms(selected, opName)
                    return driverPhone ? (
                      <>
                        <p className="detail-driver-phone-line">
                          <span className="detail-meta-label">Assigned driver phone</span>
                          <span className="detail-driver-phone-num">{driverPhone}</span>
                        </p>
                        <div className="detail-driver-actions">
                          <a className="dispatch-btn detail-sms-btn" href={smsHref(driverPhone, smsBody)}>
                            Alert via SMS
                          </a>
                          <a className="dispatch-btn detail-call-btn" href={telHref(driverPhone)}>
                            Call driver
                          </a>
                        </div>
                      </>
                    ) : (
                      <p className="hint">No driver phone on file for this vehicle.</p>
                    )
                  })()}
                </div>
              ) : null}

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
          <label className="shift-next-op-label">
            Next operator phone (handover)
            <input
              type="tel"
              className="shift-next-op-input"
              value={nextOperatorPhone}
              onChange={(e) => {
                const v = e.target.value
                setNextOperatorPhone(v)
                localStorage.setItem(NEXT_OPERATOR_PHONE_KEY, v)
              }}
              placeholder="+91…"
              autoComplete="tel"
            />
          </label>
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
              className="dispatch-btn handover-sms-btn"
              disabled={!nextOperatorPhone.trim() || !shiftNotes.trim()}
              onClick={() => {
                const to = nextOperatorPhone.trim()
                const body = `REACH handover from ${user.full_name?.trim() || user.phone || 'operator'}:\n\n${shiftNotes.trim()}`
                window.location.href = smsHref(to, body)
              }}
            >
              Send handover SMS
            </button>
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
            className="incident-modal incident-detail-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Incident details"
          >
            {(() => {
              const detail = incidentDetail?.id === selected.id ? incidentDetail : null
              const src = detail ?? selected
              const trust = deriveDispatchTrustDisplay({
                status: src.status,
                trust_factors: detail?.trust_factors ?? selected.trust_factors ?? [],
                latitude: detail?.latitude ?? selected.latitude,
                longitude: detail?.longitude ?? selected.longitude,
                km_marker: detail?.km_marker ?? selected.km_marker,
              })
              const km = detail?.km_marker ?? selected.km_marker
              const corridorName = corridors.find((c) => c.id === selected.corridor_id)?.name ?? 'NH48'
              const locationLine = hasValidKmMarker(km)
                ? `KM ${Number(km)} on ${corridorName}`
                : 'KM unknown'
              const factorBullets = (detail?.trust_factors ?? selected.trust_factors ?? [])
                .map((raw) => formatTrustFactorBullet(raw))
                .filter((x): x is string => Boolean(x))
              const notesText = detail?.notes?.trim() ? detail.notes : '—'
              const typeIcon = incidentTypeIcon(selected.incident_type)
              const typeLabel = humanizeIncidentType(selected.incident_type)
              return (
                <>
                  <div className="incident-modal-header">
                    <h2>Incident details</h2>
                    <button type="button" onClick={() => setIsDetailOpen(false)}>
                      Close
                    </button>
                  </div>
                  <div className="detail-modal-grid">
                    <div className="detail-modal-card">
                      <div className="detail-field">
                        <span className="detail-field-label">Type</span>
                        <div className="detail-field-value detail-type-row">
                          <span className="detail-type-icon" aria-hidden>
                            {typeIcon}
                          </span>
                          <span>{typeLabel}</span>
                        </div>
                      </div>
                      <div className="detail-field">
                        <span className="detail-field-label">Severity</span>
                        <div>
                          <span className={severityDetailBadgeClass(selected.severity)}>
                            {humanizeIncidentType(selected.severity)}
                          </span>
                        </div>
                      </div>
                      <div className="detail-field">
                        <span className="detail-field-label">Status</span>
                        <div>
                          <span className={statusDetailBadgeClass(selected.status)}>{statusLabel(selected.status)}</span>
                        </div>
                      </div>
                      <div className="detail-field">
                        <span className="detail-field-label">Reported via</span>
                        <div className="detail-field-value">{reportedViaLabel(selected.reporter_type)}</div>
                      </div>
                      <div className="detail-field">
                        <span className="detail-field-label">Location</span>
                        <div className="detail-field-value detail-location-line">{locationLine}</div>
                      </div>
                    </div>
                    <div className="detail-modal-card">
                      <div className="detail-field">
                        <span className="detail-field-label">Verification</span>
                        <div className="detail-verification-block">
                          <span className="detail-verification-emoji" aria-hidden>
                            {trust.emoji}
                          </span>
                          <div>
                            <div className="detail-verification-label">{trust.label}</div>
                            <div className="detail-verification-sub">
                              {trust.reporterCount} {trust.reporterCount === 1 ? 'report' : 'reports'}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="detail-field">
                        <span className="detail-field-label">Reported at</span>
                        <div className="detail-field-value detail-reported-time">
                          {new Date(selected.created_at).toLocaleString()}
                          <span className="detail-reported-relative">{relativeReportedTime(selected.created_at)}</span>
                        </div>
                      </div>
                      <div className="detail-field">
                        <span className="detail-field-label">Injured</span>
                        <div className="detail-field-value detail-injured-num">
                          {detail?.injured_count ?? selected.injured_count}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="detail-modal-card detail-modal-notes-card">
                    <span className="detail-field-label">Notes</span>
                    <p className="detail-notes-body">{notesText}</p>
                  </div>
                  {factorBullets.length > 0 ? (
                    <div className="detail-modal-card detail-trust-factors-card">
                      <h3 className="detail-modal-section-title">Trust factors</h3>
                      <ul className="detail-trust-factors-list">
                        {factorBullets.map((line, idx) => (
                          <li key={`${idx}-${line.slice(0, 24)}`}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {detail?.timeline?.length ? (
                    <div className="detail-modal-card detail-modal-timeline-card">
                      <h3 className="detail-modal-section-title">Timeline</h3>
                      <ul className="detail-timeline-modal-list">
                        {detail.timeline.map((ev) => (
                          <li key={ev.id}>
                            <span className="detail-timeline-modal-ev">{humanizeTimelineEventType(ev.event_type)}</span>
                            <span className="detail-timeline-modal-time">
                              {new Date(ev.created_at).toLocaleString()}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              )
            })()}
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
