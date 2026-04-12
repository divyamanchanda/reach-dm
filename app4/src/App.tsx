import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { AnalyticsPage, BroadcastPage, SpeedZonesPage } from './adminAnalytics'
import {
  API,
  AUTH_TOKEN_KEY,
  apiUrl,
  deleteJson,
  downloadBlob,
  fetchJson,
  healthPing,
  isSessionExpiredError,
  login,
  postJson,
  setAuthFailureHandler,
  type User,
} from './api'

type Tab = 'dashboard' | 'map' | 'users' | 'corridors' | 'analytics' | 'broadcast' | 'speed_zones'

type Dashboard = {
  active_incidents: number
  total_vehicles: number
  total_corridors: number
  dispatched_incidents: number
  closed_today: number
}

type TimelineEvent = {
  id: string
  event_type: string
  payload: Record<string, unknown> | null
  created_at: string
}

type IncidentDetail = {
  id: string
  incident_type: string
  severity: string
  status: string
  trust_score: number
  km_marker: number | null
  latitude?: number | null
  longitude?: number | null
  public_report_id: string | null
  created_at: string
  reporter_type?: string
  injured_count?: number
  notes?: string | null
  sos_details?: Record<string, unknown> | null
  assigned_vehicle_id?: string | null
  assigned_vehicle_label: string | null
  driver_name?: string | null
  eta_minutes?: number | null
  timeline: TimelineEvent[]
}

type AdminVehicleRow = {
  id: string
  label: string
  corridor_name: string
  driver_name: string | null
  status: string
  is_available: boolean
  km_marker: number | null
  latitude: number | null
  longitude: number | null
  updated_at: string
}

type RecentIncident = {
  id: string
  corridor_id: string
  corridor_name: string
  incident_type: string
  severity: string
  status: string
  km_marker: number | null
  created_at: string
}

type CorridorRow = {
  id: string
  name: string
  code: string | null
  start_lat: number | null
  start_lng: number | null
  end_lat: number | null
  end_lng: number | null
  km_start: number | null
  km_end: number | null
  is_active: boolean
}

type Organisation = {
  id: string
  name: string
}

type LiveMapIncident = {
  id: string
  incident_type: string
  severity: string
  trust_score: number
  km_marker: number | null
  status: string
  created_at: string
  latitude: number | null
  longitude: number | null
  public_report_id?: string | null
}

type LiveMapVehicle = {
  id: string
  label: string
  status: string
  km_marker: number | null
  latitude: number | null
  longitude: number | null
  assigned_incident_id?: string | null
  assigned_incident_type?: string | null
  driver_name?: string | null
}

type LiveMapCorridor = {
  id: string
  name: string
  km_start: number | null
  km_end: number | null
  incidents: LiveMapIncident[]
  vehicles: LiveMapVehicle[]
}

type CorridorDraft = {
  name: string
  start_lat: number
  start_lng: number
  end_lat: number
  end_lng: number
  km_length: number
  code: string | null
}

type NominatimRow = {
  display_name: string
  lat: string
  lon: string
  type?: string
  class?: string
  boundingbox?: [string, string, string, string]
  geojson?: { type: string; coordinates: unknown }
}

type LatLng = { lat: number; lng: number }

function useLeafletReady() {
  const [ready, setReady] = useState<boolean>(() => typeof window !== 'undefined' && !!(window as any).L)

  useEffect(() => {
    if ((window as any).L) {
      setReady(true)
      return
    }

    let cancelled = false
    const markReady = () => {
      if (!cancelled) setReady(!!(window as any).L)
    }

    const script = document.querySelector<HTMLScriptElement>('script[src*="unpkg.com/leaflet"]')
    if (script) script.addEventListener('load', markReady)

    const timer = window.setInterval(() => {
      if ((window as any).L) {
        markReady()
        window.clearInterval(timer)
      }
    }, 150)

    return () => {
      cancelled = true
      if (script) script.removeEventListener('load', markReady)
      window.clearInterval(timer)
    }
  }, [])

  return ready
}

function roleLabel(role: string): string {
  if (role === 'dispatch_operator') return 'Operator'
  if (role === 'driver') return 'Driver'
  if (role === 'admin') return 'Admin'
  return role
}

function severityClass(sev: string): string {
  const s = sev.toLowerCase()
  if (s === 'critical') return 'sev-critical'
  if (s === 'major') return 'sev-major'
  return 'sev-minor'
}

function severityRowClass(sev: string): string {
  const s = sev.toLowerCase()
  if (s === 'critical') return 'feed-row-sev-critical'
  if (s === 'major') return 'feed-row-sev-major'
  return 'feed-row-sev-minor'
}

function incidentRowClass(i: RecentIncident): string {
  const st = i.status.toLowerCase()
  if (['closed', 'archived', 'expired', 'cancelled', 'recalled'].includes(st)) {
    return 'feed-row--done'
  }
  return severityRowClass(i.severity)
}

function incidentTypeEmoji(t: string): string {
  const s = t.toLowerCase()
  if (s.includes('fire')) return '🔥'
  if (s.includes('medical')) return '🏥'
  if (s.includes('breakdown')) return '🛑'
  if (s.includes('accident')) return '🚗'
  if (s.includes('obstacle')) return '🚧'
  return '⚠️'
}

function hazardIdLabel(id: string): string {
  const m: Record<string, string> = {
    fire_smoke: 'Fire/smoke',
    fuel_spill: 'Fuel spill',
    live_wire: 'Live wire down',
    lane_blocked: 'Lane blocked',
    none_visible: 'None visible',
  }
  return m[id] || id
}

function directionHuman(d: unknown): string {
  if (d === 'towards_chennai') return 'Towards Chennai'
  if (d === 'towards_bengaluru') return 'Towards Bengaluru'
  if (typeof d === 'string' && d) return d
  return '—'
}

type DashboardSection = 'recent' | 'active' | 'vehicles' | 'corridors'

function vehicleStatusToneClass(status: string, isAvailable: boolean): string {
  const s = status.toLowerCase()
  if (s === 'available' && isAvailable) return 'veh-row--avail'
  if (['dispatched', 'en_route', 'on_scene', 'transporting'].includes(s)) return 'veh-row--dispatched'
  return 'veh-row--offline'
}

function incidentDotColor(sev: string): string {
  const s = sev.toLowerCase()
  if (s === 'critical') return '#dc2626'
  if (s === 'major') return '#ea580c'
  return '#16a34a'
}

function trustLabel(score: number): string {
  if (score <= 30) return '🔴 Unverified'
  if (score <= 60) return '🟡 Partially verified'
  return '🟢 High confidence'
}

/** Live highway SVG only — marker fill by vehicle.status */
function ambulanceDiagramFill(status: string): string {
  const s = status.toLowerCase().replace(/\s+/g, '_')
  if (s === 'available' || s === 'idle') return '#22c55e'
  if (s === 'dispatched' || s === 'en_route') return '#f97316'
  if (s === 'on_scene') return '#ef4444'
  return '#64748b'
}

function vehicleStatusLabel(status: string): string {
  const s = status.toLowerCase().replace(/_/g, ' ')
  if (s === 'available') return 'idle'
  return s
}

const NH48_KM_LENGTH = 312

const HW_DIAGRAM = { w: 1000, h: 210, pad: 52, roadY: 118 } as const

function kmToDiagramX(km: number): number {
  const t = Math.max(0, Math.min(1, km / NH48_KM_LENGTH))
  return HW_DIAGRAM.pad + t * (HW_DIAGRAM.w - 2 * HW_DIAGRAM.pad)
}

function estimatePointFromKm(km: number): LatLng {
  const bengaluru = { lat: 12.9716, lng: 77.5946 }
  const chennai = { lat: 13.0827, lng: 80.2707 }
  const t = Math.min(1, Math.max(0, km / NH48_KM_LENGTH))
  return {
    lat: bengaluru.lat + (chennai.lat - bengaluru.lat) * t,
    lng: bengaluru.lng + (chennai.lng - bengaluru.lng) * t,
  }
}

/** Approximate KM along NH48 from coordinates (planar projection onto Bengaluru–Chennai segment). */
function kmAlongNh48FromLatLng(lat: number, lng: number): number {
  const b = { lat: 12.9716, lng: 77.5946 }
  const c = { lat: 13.0827, lng: 80.2707 }
  const dx = c.lng - b.lng
  const dy = c.lat - b.lat
  const len2 = dx * dx + dy * dy
  if (len2 <= 0) return 0
  const t = Math.max(0, Math.min(1, ((lng - b.lng) * dx + (lat - b.lat) * dy) / len2))
  return t * NH48_KM_LENGTH
}

const NH48_DIAGRAM_CITIES: { km: number; label: string }[] = [
  { km: 0, label: 'Bengaluru' },
  { km: 40, label: 'Hosur' },
  { km: 90, label: 'Krishnagiri' },
  { km: 190, label: 'Vellore' },
  { km: NH48_KM_LENGTH, label: 'Chennai' },
]

function jitterId(id: string, range: number): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i) * (i + 1)) % 1009
  return ((h % (range * 2 + 1)) - range) * 0.6
}

function incidentLatLng(inc: LiveMapIncident): LatLng | null {
  if (inc.latitude != null && inc.longitude != null) {
    return { lat: inc.latitude, lng: inc.longitude }
  }
  if (inc.km_marker != null && Number.isFinite(inc.km_marker)) {
    return estimatePointFromKm(inc.km_marker)
  }
  return null
}

function vehicleLatLng(v: LiveMapVehicle): LatLng | null {
  if (v.latitude != null && v.longitude != null) {
    return { lat: v.latitude, lng: v.longitude }
  }
  if (v.km_marker != null && Number.isFinite(v.km_marker)) {
    return estimatePointFromKm(v.km_marker)
  }
  return null
}

function kmForLiveIncident(inc: LiveMapIncident): number | null {
  if (inc.km_marker != null && Number.isFinite(inc.km_marker)) {
    return Math.max(0, Math.min(NH48_KM_LENGTH, inc.km_marker))
  }
  const ll = incidentLatLng(inc)
  if (!ll) return null
  return kmAlongNh48FromLatLng(ll.lat, ll.lng)
}

function kmForLiveVehicle(v: LiveMapVehicle): number | null {
  if (v.km_marker != null && Number.isFinite(v.km_marker)) {
    return Math.max(0, Math.min(NH48_KM_LENGTH, v.km_marker))
  }
  const ll = vehicleLatLng(v)
  if (!ll) return null
  return kmAlongNh48FromLatLng(ll.lat, ll.lng)
}

function isLikelyHighwayHit(row: NominatimRow): boolean {
  const name = row.display_name.toLowerCase()
  const t = (row.type ?? '').toLowerCase()
  const c = (row.class ?? '').toLowerCase()
  return t === 'highway' || c === 'highway' || name.includes('national highway') || /\bnh\d+/i.test(row.display_name)
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

/** Cumulative distance along polyline from first vertex to each vertex (same length as route). */
function cumulativeDistancesKm(route: LatLng[]): number[] {
  const acc: number[] = [0]
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]
    const b = route[i]
    acc.push(acc[i - 1] + haversineKm(a.lat, a.lng, b.lat, b.lng))
  }
  return acc
}

function polylinePathLengthKm(points: LatLng[]): number {
  let s = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    s += haversineKm(a.lat, a.lng, b.lat, b.lng)
  }
  return s
}

/** Closest point on segment a–b to p (geodesic short leg — planar lerp is fine for small segments). */
function closestOnSegment(p: LatLng, a: LatLng, b: LatLng): { point: LatLng; t: number } {
  // Project in lat/lng space (adequate for highway segment snapping).
  const dx = b.lng - a.lng
  const dy = b.lat - a.lat
  const len2 = dx * dx + dy * dy
  const tRaw = len2 > 0 ? ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2 : 0
  const t = Math.min(1, Math.max(0, tRaw))
  return {
    point: { lat: a.lat + t * dy, lng: a.lng + t * dx },
    t,
  }
}

/** Distance from click to nearest point on polyline (km) + snap point + distance along route from start. */
function snapToPolyline(route: LatLng[], click: LatLng): { snap: LatLng; distAlong: number } | null {
  if (route.length < 2) return null
  const cum = cumulativeDistancesKm(route)
  let bestDist = Infinity
  let bestSnap = route[0]
  let bestAlong = 0
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]
    const b = route[i + 1]
    const { point, t } = closestOnSegment(click, a, b)
    const d = haversineKm(click.lat, click.lng, point.lat, point.lng)
    if (d < bestDist) {
      bestDist = d
      bestSnap = point
      const segLen = cum[i + 1] - cum[i]
      bestAlong = cum[i] + t * segLen
    }
  }
  return { snap: bestSnap, distAlong: bestAlong }
}

/** Sub-route from A to B following vertex order (includes snapped endpoints). */
function sliceRouteBetween(route: LatLng[], snapA: LatLng, snapB: LatLng): LatLng[] {
  const sa = snapToPolyline(route, snapA)
  const sb = snapToPolyline(route, snapB)
  if (!sa || !sb) return [snapA, snapB]
  const d0 = Math.min(sa.distAlong, sb.distAlong)
  const d1 = Math.max(sa.distAlong, sb.distAlong)
  const startPt = sa.distAlong <= sb.distAlong ? sa.snap : sb.snap
  const endPt = sa.distAlong <= sb.distAlong ? sb.snap : sa.snap
  const cum = cumulativeDistancesKm(route)
  const mid: LatLng[] = []
  for (let i = 0; i < route.length; i++) {
    const d = cum[i]
    if (d > d0 && d < d1) mid.push(route[i])
  }
  return [startPt, ...mid, endPt]
}

function lngLatPairsFromRing(ring: [number, number][]): LatLng[] {
  return ring.map(([lng, lat]) => ({ lat, lng }))
}

function geoJsonToRoute(g: { type: string; coordinates: unknown }): LatLng[] | null {
  try {
    const t = g.type
    const c = g.coordinates
    if (t === 'LineString' && Array.isArray(c) && c.length >= 2) {
      return lngLatPairsFromRing(c as [number, number][])
    }
    if (t === 'MultiLineString' && Array.isArray(c)) {
      const lines = c as [number, number][][]
      const best = lines.reduce((a, b) => (a.length >= b.length ? a : b), [])
      return best.length >= 2 ? lngLatPairsFromRing(best) : null
    }
    if (t === 'Polygon' && Array.isArray(c) && c[0]) {
      const ring = c[0] as [number, number][]
      return ring.length >= 2 ? lngLatPairsFromRing(ring) : null
    }
    if (t === 'MultiPolygon' && Array.isArray(c) && c[0]?.[0]) {
      const ring = c[0][0] as [number, number][]
      return ring.length >= 2 ? lngLatPairsFromRing(ring) : null
    }
  } catch {
    return null
  }
  return null
}

function bboxFallbackRoute(hit: NominatimRow): LatLng[] {
  if (hit.boundingbox?.length === 4) {
    const [south, north, west, east] = hit.boundingbox.map(Number)
    return [
      { lat: south, lng: west },
      { lat: north, lng: east },
    ]
  }
  const lat = Number(hit.lat)
  const lng = Number(hit.lon)
  return [
    { lat, lng },
    { lat: lat + 0.05, lng: lng + 0.05 },
  ]
}

function routeFromNominatimHit(hit: NominatimRow): LatLng[] {
  if (hit.geojson?.coordinates) {
    const r = geoJsonToRoute(hit.geojson)
    if (r && r.length >= 2) return r
  }
  return bboxFallbackRoute(hit)
}

function CorridorRouteMap({
  leafletReady,
  routePath,
  segmentStart,
  segmentEnd,
  onPickAlongRoute,
}: {
  leafletReady: boolean
  routePath: LatLng[] | null
  segmentStart: LatLng | null
  segmentEnd: LatLng | null
  onPickAlongRoute: (snap: LatLng) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const baseLineRef = useRef<any>(null)
  const highlightRef = useRef<any>(null)
  const markersRef = useRef<{ a: any | null; b: any | null }>({ a: null, b: null })

  const scheduleInvalidate = useCallback((map: any) => {
    window.setTimeout(() => map.invalidateSize(), 150)
    window.requestAnimationFrame(() => map.invalidateSize())
  }, [])

  const routePathRef = useRef(routePath)
  const onPickRef = useRef(onPickAlongRoute)
  useEffect(() => {
    routePathRef.current = routePath
  }, [routePath])
  useEffect(() => {
    onPickRef.current = onPickAlongRoute
  }, [onPickAlongRoute])

  useEffect(() => {
    if (!leafletReady) return
    const L = (window as any).L
    const el = hostRef.current
    if (!L || !el || mapRef.current) return
    if ((el as any)._leaflet_id) {
      el.innerHTML = ''
    }
    const map = L.map(el).setView([20.5937, 78.9629], 5)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map)
    mapRef.current = map
    scheduleInvalidate(map)

    map.on('click', (e: any) => {
      const rp = routePathRef.current
      if (!rp || rp.length < 2) return
      const snap = snapToPolyline(rp, { lat: e.latlng.lat, lng: e.latlng.lng })
      if (snap) onPickRef.current(snap.snap)
    })

    return () => {
      map.remove()
      mapRef.current = null
      baseLineRef.current = null
      highlightRef.current = null
      markersRef.current = { a: null, b: null }
    }
  }, [leafletReady, scheduleInvalidate])

  useEffect(() => {
    const map = mapRef.current
    const L = (window as any).L
    if (!leafletReady || !map || !L) return

    if (baseLineRef.current) {
      map.removeLayer(baseLineRef.current)
      baseLineRef.current = null
    }
    if (highlightRef.current) {
      map.removeLayer(highlightRef.current)
      highlightRef.current = null
    }
    if (markersRef.current.a) {
      map.removeLayer(markersRef.current.a)
      markersRef.current.a = null
    }
    if (markersRef.current.b) {
      map.removeLayer(markersRef.current.b)
      markersRef.current.b = null
    }

    if (routePath && routePath.length >= 2) {
      const ll = routePath.map((p) => [p.lat, p.lng])
      baseLineRef.current = L.polyline(ll, { color: '#2563eb', weight: 5, opacity: 0.85 }).addTo(map)
      const fg = L.featureGroup([baseLineRef.current])
      window.setTimeout(() => {
        scheduleInvalidate(map)
        map.fitBounds(fg.getBounds().pad(0.08))
      }, 160)
    } else {
      map.setView([20.5937, 78.9629], 5)
      scheduleInvalidate(map)
    }
  }, [leafletReady, routePath, scheduleInvalidate])

  useEffect(() => {
    const map = mapRef.current
    const L = (window as any).L
    if (!leafletReady || !map || !L || !routePath || routePath.length < 2) return

    if (highlightRef.current) {
      map.removeLayer(highlightRef.current)
      highlightRef.current = null
    }
    if (markersRef.current.a) {
      map.removeLayer(markersRef.current.a)
      markersRef.current.a = null
    }
    if (markersRef.current.b) {
      map.removeLayer(markersRef.current.b)
      markersRef.current.b = null
    }

    if (segmentStart) {
      markersRef.current.a = L.circleMarker([segmentStart.lat, segmentStart.lng], {
        radius: 8,
        color: '#22c55e',
        fillColor: '#bbf7d0',
        fillOpacity: 0.9,
      })
        .bindTooltip('Section start')
        .addTo(map)
    }
    if (segmentEnd) {
      markersRef.current.b = L.circleMarker([segmentEnd.lat, segmentEnd.lng], {
        radius: 8,
        color: '#ef4444',
        fillColor: '#fecaca',
        fillOpacity: 0.9,
      })
        .bindTooltip('Section end')
        .addTo(map)
    }
    if (segmentStart && segmentEnd) {
      const slice = sliceRouteBetween(routePath, segmentStart, segmentEnd)
      highlightRef.current = L.polyline(
        slice.map((p) => [p.lat, p.lng]),
        { color: '#facc15', weight: 8, opacity: 0.95 },
      ).addTo(map)
    }
    scheduleInvalidate(map)
  }, [leafletReady, routePath, segmentStart, segmentEnd, scheduleInvalidate])

  if (!leafletReady) return <div className="leaflet-box corridor-route-map map-loading">Loading map engine...</div>
  return <div className="leaflet-box corridor-route-map" ref={hostRef} />
}

function LiveHighwayDiagram({ corridors }: { corridors: LiveMapCorridor[] }) {
  const roadY = HW_DIAGRAM.roadY
  const [openVehicleKey, setOpenVehicleKey] = useState<string | null>(null)

  const incidentsPlaced = useMemo(() => {
    const out: { key: string; inc: LiveMapIncident; km: number; x: number; y: number }[] = []
    for (const c of corridors) {
      for (const inc of c.incidents) {
        const km = kmForLiveIncident(inc)
        if (km == null) continue
        const x = kmToDiagramX(km) + jitterId(inc.id, 8)
        const y = roadY - 38 + jitterId(`${inc.id}y`, 6)
        out.push({ key: `${c.id}-${inc.id}`, inc, km, x, y })
      }
    }
    return out
  }, [corridors, roadY])

  const { vehiclesPlaced, diagramH } = useMemo(() => {
    const STAGGER_PX = 36
    const BASE_OFF = 42
    type Raw = { key: string; v: LiveMapVehicle; km: number; x: number }
    const raw: Raw[] = []
    for (const c of corridors) {
      for (const v of c.vehicles) {
        const km = kmForLiveVehicle(v)
        if (km == null) continue
        const x = kmToDiagramX(km) + jitterId(v.id, 6)
        raw.push({ key: `${c.id}-${v.id}`, v, km, x })
      }
    }
    raw.sort((a, b) => a.km - b.km || a.key.localeCompare(b.key))
    const lanes: number[] = []
    for (let i = 0; i < raw.length; i++) {
      let lane = 0
      while (true) {
        let laneOk = true
        for (let j = 0; j < i; j++) {
          if (Math.abs(raw[i].km - raw[j].km) <= 20 && lanes[j] === lane) {
            laneOk = false
            break
          }
        }
        if (laneOk) break
        lane += 1
      }
      lanes.push(lane)
    }
    const maxLane = lanes.length ? Math.max(...lanes) : 0
    const h = Math.max(HW_DIAGRAM.h, roadY + BASE_OFF + maxLane * STAGGER_PX + 96)
    const placed = raw.map((r, i) => ({
      key: r.key,
      v: r.v,
      km: r.km,
      x: r.x,
      lane: lanes[i],
      y: roadY + BASE_OFF + lanes[i] * STAGGER_PX + jitterId(`${r.key}y`, 3),
    }))
    return { vehiclesPlaced: placed, diagramH: h }
  }, [corridors, roadY])

  const openVehicleRow = useMemo(
    () => (openVehicleKey ? vehiclesPlaced.find((p) => p.key === openVehicleKey) : undefined),
    [openVehicleKey, vehiclesPlaced],
  )

  const kmTicks = [0, 50, 100, 150, 200, 250, 300]
  const x0 = kmToDiagramX(0)
  const xEnd = kmToDiagramX(NH48_KM_LENGTH)

  return (
    <div className="highway-wrap live-road">
      <div className="highway-diagram-head">
        <strong>NH48 schematic</strong>
        <span className="muted">
          Horizontal KM {0}–{NH48_KM_LENGTH} · Incidents &amp; vehicles from <code>/admin/live-map</code>
        </span>
      </div>
      <div className="highway-legend" aria-label="Schematic legend">
        <div className="highway-legend-block">
          <span className="highway-legend-title">Incident dots</span>
          <ul className="highway-legend-items">
            <li>
              <span className="hw-leg-dot" style={{ background: '#dc2626' }} aria-hidden />
              Critical severity
            </li>
            <li>
              <span className="hw-leg-dot" style={{ background: '#ea580c' }} aria-hidden />
              Major severity
            </li>
            <li>
              <span className="hw-leg-dot" style={{ background: '#16a34a' }} aria-hidden />
              Minor severity
            </li>
          </ul>
        </div>
        <div className="highway-legend-block">
          <span className="highway-legend-title">Ambulance markers</span>
          <ul className="highway-legend-items">
            <li>
              <span className="hw-leg-dot" style={{ background: '#22c55e' }} aria-hidden />
              Idle / available
            </li>
            <li>
              <span className="hw-leg-dot" style={{ background: '#f97316' }} aria-hidden />
              Dispatched or en route
            </li>
            <li>
              <span className="hw-leg-dot" style={{ background: '#ef4444' }} aria-hidden />
              On scene
            </li>
          </ul>
        </div>
      </div>
      <svg
        className="highway-svg highway-svg-live"
        viewBox={`0 0 ${HW_DIAGRAM.w} ${diagramH}`}
        role="img"
        aria-label="Highway diagram: incidents and ambulances by kilometre"
      >
        <defs>
          <linearGradient id="hwRoadGradH" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#334155" />
            <stop offset="100%" stopColor="#1e293b" />
          </linearGradient>
        </defs>
        <rect
          width={HW_DIAGRAM.w}
          height={diagramH}
          fill="transparent"
          onClick={() => setOpenVehicleKey(null)}
          style={{ pointerEvents: 'all' }}
        />
        <line
          x1={x0}
          y1={roadY}
          x2={xEnd}
          y2={roadY}
          stroke="url(#hwRoadGradH)"
          strokeWidth={44}
          strokeLinecap="round"
          pointerEvents="none"
        />
        <line
          x1={x0}
          y1={roadY}
          x2={xEnd}
          y2={roadY}
          stroke="#475569"
          strokeWidth={3}
          strokeDasharray="12 16"
          opacity={0.85}
          pointerEvents="none"
        />
        {kmTicks.map((km) => {
          const x = kmToDiagramX(km)
          return (
            <g key={`tick-${km}`} style={{ pointerEvents: 'none' }}>
              <line x1={x} y1={roadY - 24} x2={x} y2={roadY + 24} stroke="#64748b" strokeWidth={1.5} opacity={0.7} />
              <text x={x} y={roadY + 44} textAnchor="middle" fill="#94a3b8" fontSize={11} fontWeight={600}>
                {km} km
              </text>
            </g>
          )
        })}
        {NH48_DIAGRAM_CITIES.map(({ km, label }) => {
          const x = kmToDiagramX(km)
          return (
            <g key={label} style={{ pointerEvents: 'none' }}>
              <text
                x={x}
                y={roadY - 52}
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize={13}
                fontWeight={700}
                style={{ textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}
              >
                {label}
              </text>
              <circle cx={x} cy={roadY - 38} r={3} fill="#38bdf8" opacity={0.9} />
            </g>
          )
        })}
        {incidentsPlaced.map(({ key, inc, km, x, y }) => (
          <g key={`inc-${key}`} transform={`translate(${x}, ${y})`} style={{ pointerEvents: 'none' }}>
            <title>
              {`${inc.incident_type} · ${inc.severity} · KM ${km.toFixed(0)} · ${inc.status} · ${new Date(inc.created_at).toLocaleString()} · Trust ${trustLabel(inc.trust_score)}`}
            </title>
            <circle r={11} fill={incidentDotColor(inc.severity)} stroke="#0f172a" strokeWidth={2} className="hw-incident-dot" />
          </g>
        ))}
        {vehiclesPlaced.map(({ key, v, km, x, y }) => (
          <g
            key={`veh-${key}`}
            className="hw-amb-svg hw-amb-marker"
            role="button"
            tabIndex={0}
            transform={`translate(${x}, ${y})`}
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation()
              setOpenVehicleKey((prev) => (prev === key ? null : key))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                setOpenVehicleKey((prev) => (prev === key ? null : key))
              }
            }}
          >
            <title>
              {`${v.label} · ${vehicleStatusLabel(v.status)} · KM ${km.toFixed(0)} · Click for details`}
            </title>
            <circle
              r={20}
              fill={ambulanceDiagramFill(v.status)}
              stroke={openVehicleKey === key ? '#f8fafc' : '#0f172a'}
              strokeWidth={openVehicleKey === key ? 2.5 : 1.5}
              opacity={0.96}
            />
            <text x={0} y={6} textAnchor="middle" fontSize={16} pointerEvents="none">
              🚑
            </text>
            <text
              x={0}
              y={32}
              textAnchor="middle"
              fill="#e2e8f0"
              fontSize={10}
              fontWeight={700}
              pointerEvents="none"
              style={{ textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}
            >
              {v.label}
            </text>
          </g>
        ))}
        {openVehicleRow ? (
          <foreignObject
            x={Math.min(openVehicleRow.x + 26, HW_DIAGRAM.w - 272)}
            y={Math.max(6, openVehicleRow.y - 58)}
            width={260}
            height={172}
            className="hw-amb-foreign"
          >
            <div
              className="hw-amb-popup"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="hw-amb-popup-head">
                <strong className="hw-amb-popup-title">{openVehicleRow.v.label}</strong>
                <button
                  type="button"
                  className="hw-amb-popup-close"
                  aria-label="Close"
                  onClick={() => setOpenVehicleKey(null)}
                >
                  ×
                </button>
              </div>
              <dl className="hw-amb-popup-dl">
                <div>
                  <dt>Status</dt>
                  <dd>{vehicleStatusLabel(openVehicleRow.v.status)}</dd>
                </div>
                {openVehicleRow.v.assigned_incident_type ? (
                  <div>
                    <dt>Assigned incident</dt>
                    <dd>{openVehicleRow.v.assigned_incident_type}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Driver</dt>
                  <dd>{openVehicleRow.v.driver_name?.trim() || '—'}</dd>
                </div>
              </dl>
            </div>
          </foreignObject>
        ) : null}
      </svg>
    </div>
  )
}

function IncidentMiniMap({
  leafletReady,
  latitude,
  longitude,
}: {
  leafletReady: boolean
  latitude: number | null
  longitude: number | null
}) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!leafletReady || latitude == null || longitude == null) return
    const L = (window as unknown as { L?: any }).L
    if (!L || !hostRef.current) return
    const el = hostRef.current
    const map = L.map(el).setView([latitude, longitude], 10)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
    }).addTo(map)
    L.circleMarker([latitude, longitude], {
      radius: 11,
      color: '#b91c1c',
      fillColor: '#ef4444',
      fillOpacity: 0.95,
      weight: 2,
    }).addTo(map)
    const nh = [estimatePointFromKm(0), estimatePointFromKm(NH48_KM_LENGTH)]
    L.polyline(
      nh.map((p) => [p.lat, p.lng]),
      { color: '#64748b', weight: 3, opacity: 0.55 },
    ).addTo(map)
    return () => {
      map.remove()
    }
  }, [leafletReady, latitude, longitude])

  if (latitude == null || longitude == null) {
    return <p className="muted incident-map-fallback">No map position (add GPS or KM to the incident).</p>
  }
  if (!leafletReady) {
    return <div className="leaflet-box incident-mini-map map-loading">Loading map…</div>
  }
  return <div className="leaflet-box incident-mini-map" ref={hostRef} />
}

function buildPhaseTimes(detail: IncidentDetail): {
  created: string | null
  dispatched: string | null
  arrived: string | null
  cleared: string | null
} {
  const out = {
    created: null as string | null,
    dispatched: null as string | null,
    arrived: null as string | null,
    cleared: null as string | null,
  }
  out.created = detail.timeline.find((e) => e.event_type === 'created')?.created_at ?? detail.created_at
  for (const ev of detail.timeline) {
    if (ev.event_type === 'dispatch' && !out.dispatched) out.dispatched = ev.created_at
    if (ev.event_type === 'status_change') {
      const st = (ev.payload as { status?: string } | null)?.status?.toLowerCase()
      if (st === 'on_scene' && !out.arrived) out.arrived = ev.created_at
      if (['closed', 'archived', 'cancelled', 'recalled', 'expired'].includes(st || '') && !out.cleared) {
        out.cleared = ev.created_at
      }
    }
  }
  const st = detail.status.toLowerCase()
  if (['closed', 'archived', 'cancelled', 'recalled', 'expired'].includes(st) && !out.cleared) {
    const last = [...detail.timeline].reverse().find((e) => e.event_type === 'status_change')
    out.cleared = last?.created_at ?? detail.created_at
  }
  return out
}

export default function App() {
  const leafletReady = useLeafletReady()
  const [token, setToken] = useState<string | null>(() => {
    const raw = localStorage.getItem(AUTH_TOKEN_KEY)
    const t = raw?.trim()
    return t ? t : null
  })
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem('reach_user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as User
    } catch {
      return null
    }
  })
  const [tab, setTab] = useState<Tab>('dashboard')
  const [loginPhone, setLoginPhone] = useState('+919876543210')
  const [loginPw, setLoginPw] = useState('reach2026')
  const [loginErr, setLoginErr] = useState<string | null>(null)
  const [apiOk, setApiOk] = useState<boolean | null>(null)
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [recent, setRecent] = useState<RecentIncident[]>([])
  const [dashboardSection, setDashboardSection] = useState<DashboardSection>('recent')
  const [activeIncidents, setActiveIncidents] = useState<RecentIncident[]>([])
  const [vehiclesDash, setVehiclesDash] = useState<AdminVehicleRow[]>([])
  const [liveMap, setLiveMap] = useState<LiveMapCorridor[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [corridors, setCorridors] = useState<CorridorRow[]>([])
  const [orgs, setOrgs] = useState<Organisation[]>([])
  const [pageErr, setPageErr] = useState<string | null>(null)
  const [archiveStaleBusy, setArchiveStaleBusy] = useState(false)
  const [archiveStaleInfo, setArchiveStaleInfo] = useState<string | null>(null)
  const [selectedIncident, setSelectedIncident] = useState<IncidentDetail | null>(null)
  const [incidentLoading, setIncidentLoading] = useState(false)

  const [newUserPhone, setNewUserPhone] = useState('')
  const [newUserPw, setNewUserPw] = useState('')
  const [newUserName, setNewUserName] = useState('')
  const [newUserRole, setNewUserRole] = useState<'dispatch_operator' | 'driver' | 'admin'>('driver')

  const [corridorCreateMode, setCorridorCreateMode] = useState<'search' | 'manual'>('search')
  const [searchQuery, setSearchQuery] = useState('NH48')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchResults, setSearchResults] = useState<NominatimRow[]>([])
  const [selectedSearchIndex, setSelectedSearchIndex] = useState<number | null>(null)
  const [routePath, setRoutePath] = useState<LatLng[] | null>(null)
  const [routeSectionPicks, setRouteSectionPicks] = useState<{ start: LatLng | null; end: LatLng | null }>({
    start: null,
    end: null,
  })
  const [manualStartLat, setManualStartLat] = useState('')
  const [manualStartLng, setManualStartLng] = useState('')
  const [manualEndLat, setManualEndLat] = useState('')
  const [manualEndLng, setManualEndLng] = useState('')
  const [corridorDraft, setCorridorDraft] = useState<CorridorDraft | null>(null)
  const [newCorridorOrgId, setNewCorridorOrgId] = useState('')

  const reportApiErr = useCallback((e: unknown, fallback?: string) => {
    if (isSessionExpiredError(e)) return
    setPageErr(e instanceof Error ? e.message : fallback ?? String(e))
  }, [])

  useEffect(() => {
    setAuthFailureHandler(() => {
      localStorage.removeItem(AUTH_TOKEN_KEY)
      localStorage.removeItem('reach_user')
      setToken(null)
      setUser(null)
      setPageErr(null)
      setDash(null)
      setRecent([])
      setLiveMap([])
      setUsers([])
      setCorridors([])
    })
    return () => setAuthFailureHandler(null)
  }, [])

  useEffect(() => {
    setPageErr(null)
    setArchiveStaleInfo(null)
  }, [tab])

  const loadDashboard = useCallback(async () => {
    if (!token) return
    const ok = await healthPing()
    setApiOk(ok)
    const [d, r] = await Promise.all([
      fetchJson<Dashboard>('/admin/dashboard', token),
      fetchJson<RecentIncident[]>('/admin/incidents/recent?limit=10', token),
    ])
    setDash({
      ...d,
      dispatched_incidents: d.dispatched_incidents ?? 0,
      closed_today: d.closed_today ?? 0,
    })
    setRecent(r)
  }, [token])

  const loadActiveIncidents = useCallback(async () => {
    if (!token) return
    setPageErr(null)
    try {
      setActiveIncidents(await fetchJson<RecentIncident[]>('/admin/incidents/active?limit=100', token))
    } catch (e: unknown) {
      if (isSessionExpiredError(e)) return
      reportApiErr(e, 'Failed to load active incidents')
    }
  }, [token, reportApiErr])

  const loadVehiclesDashboard = useCallback(async () => {
    if (!token) return
    setPageErr(null)
    try {
      setVehiclesDash(await fetchJson<AdminVehicleRow[]>('/admin/vehicles', token))
    } catch (e: unknown) {
      if (isSessionExpiredError(e)) return
      reportApiErr(e, 'Failed to load vehicles')
    }
  }, [token, reportApiErr])

  const loadMap = useCallback(async () => {
    if (!token) return
    const data = await fetchJson<{ corridors: LiveMapCorridor[] }>('/admin/live-map', token)
    setLiveMap(data.corridors)
  }, [token])

  const loadUsers = useCallback(async () => {
    if (!token) return
    setUsers(await fetchJson<User[]>('/admin/users', token))
  }, [token])

  const loadCorridors = useCallback(async () => {
    if (!token) return
    const [c, o] = await Promise.all([
      fetchJson<CorridorRow[]>('/admin/corridors', token),
      fetchJson<Organisation[]>('/admin/organisations', token),
    ])
    setCorridors(c)
    setOrgs(o)
    setNewCorridorOrgId((prev) => prev || o[0]?.id || '')
  }, [token])

  useEffect(() => {
    if (!token) return
    void loadDashboard().catch((e: unknown) => reportApiErr(e))
  }, [token, loadDashboard, reportApiErr])

  useEffect(() => {
    if (!token || tab !== 'map') return
    void loadMap().catch((e: unknown) => reportApiErr(e))
    const id = window.setInterval(() => {
      void loadMap().catch((e: unknown) => {
        if (!isSessionExpiredError(e)) {
          /* interval: ignore transient errors; 401 handled in api */
        }
      })
    }, 15000)
    return () => window.clearInterval(id)
  }, [token, tab, loadMap, reportApiErr])

  useEffect(() => {
    if (!token || tab !== 'users') return
    void loadUsers().catch((e: unknown) => reportApiErr(e))
  }, [token, tab, loadUsers, reportApiErr])

  useEffect(() => {
    if (!token || tab !== 'corridors') return
    void loadCorridors().catch((e: unknown) => reportApiErr(e))
  }, [token, tab, loadCorridors, reportApiErr])

  useEffect(() => {
    if (!token || tab !== 'speed_zones') return
    void loadCorridors().catch((e: unknown) => reportApiErr(e))
  }, [token, tab, loadCorridors, reportApiErr])

  const doLogin = async (e: FormEvent) => {
    e.preventDefault()
    setLoginErr(null)
    try {
      const res = await login(loginPhone, loginPw)
      const at = res.access_token.trim()
      localStorage.setItem(AUTH_TOKEN_KEY, at)
      localStorage.setItem('reach_user', JSON.stringify(res.user))
      setToken(at)
      setUser(res.user)
    } catch (err: unknown) {
      setLoginErr(err instanceof Error ? err.message : 'Login failed')
    }
  }

  const openIncidentDetail = async (incidentId: string) => {
    if (!token) return
    setIncidentLoading(true)
    setPageErr(null)
    try {
      const detail = await fetchJson<IncidentDetail>(`/admin/incidents/${incidentId}`, token)
      setSelectedIncident(detail)
    } catch (err: unknown) {
      reportApiErr(err, 'Failed to fetch incident detail')
    } finally {
      setIncidentLoading(false)
    }
  }

  const logout = () => {
    localStorage.removeItem(AUTH_TOKEN_KEY)
    localStorage.removeItem('reach_user')
    setToken(null)
    setUser(null)
  }

  const archiveStaleTestData = async () => {
    if (!token) return
    if (
      !confirm(
        'Archive test data? Incidents older than 24 hours will be marked archived. Active dispatches (dispatched / en route / on scene) are not changed.',
      )
    ) {
      return
    }
    setArchiveStaleBusy(true)
    setArchiveStaleInfo(null)
    setPageErr(null)
    try {
      const r = await postJson<{ updated: number }>('/admin/incidents/archive-stale', token, {})
      setArchiveStaleInfo(`Archived ${r.updated} incident(s).`)
      await loadDashboard()
      if (tab === 'map') await loadMap()
    } catch (err: unknown) {
      reportApiErr(err, 'Archive failed')
    } finally {
      setArchiveStaleBusy(false)
    }
  }

  const addUser = async (e: FormEvent) => {
    e.preventDefault()
    if (!token) return
    setPageErr(null)
    try {
      await postJson('/admin/users', token, {
        phone: newUserPhone,
        password: newUserPw,
        full_name: newUserName || null,
        role: newUserRole,
      })
      setNewUserPhone('')
      setNewUserPw('')
      setNewUserName('')
      await loadUsers()
    } catch (err: unknown) {
      reportApiErr(err, 'Failed to add user')
    }
  }

  const removeUser = async (id: string) => {
    if (!token || !confirm('Delete this user?')) return
    setPageErr(null)
    try {
      await deleteJson(`/admin/users/${id}`, token)
      await loadUsers()
    } catch (err: unknown) {
      reportApiErr(err, 'Failed to delete')
    }
  }

  const removeCorridor = async (id: string) => {
    if (!token || !confirm('Delete this corridor?')) return
    setPageErr(null)
    try {
      await deleteJson(`/admin/corridors/${id}`, token)
      await loadCorridors()
      if (tab === 'map') await loadMap()
    } catch (err: unknown) {
      reportApiErr(err, 'Failed to delete corridor')
    }
  }

  const applyRouteFromNominatimHit = useCallback((hit: NominatimRow) => {
    setRoutePath(routeFromNominatimHit(hit))
    setRouteSectionPicks({ start: null, end: null })
    setCorridorDraft(null)
  }, [])

  useEffect(() => {
    if (corridorCreateMode !== 'search') return
    const { start, end } = routeSectionPicks
    if (!routePath || routePath.length < 2 || !start || !end) {
      setCorridorDraft(null)
      return
    }
    const slice = sliceRouteBetween(routePath, start, end)
    const km = polylinePathLengthKm(slice)
    if (!Number.isFinite(km) || km <= 0) {
      setCorridorDraft(null)
      return
    }
    const label = searchQuery.trim() || 'Highway corridor'
    setCorridorDraft({
      name: label,
      start_lat: start.lat,
      start_lng: start.lng,
      end_lat: end.lat,
      end_lng: end.lng,
      km_length: km,
      code: searchQuery.trim() ? searchQuery.trim().toUpperCase() : null,
    })
  }, [corridorCreateMode, routePath, routeSectionPicks, searchQuery])

  const handlePickAlongRoute = useCallback(
    (snap: LatLng) => {
      if (corridorCreateMode !== 'search') return
      setRouteSectionPicks((prev) => {
        if (!prev.start || (prev.start && prev.end)) {
          return { start: snap, end: null }
        }
        return { start: prev.start, end: snap }
      })
    },
    [corridorCreateMode],
  )

  const searchHighway = async () => {
    setSearchLoading(true)
    setPageErr(null)
    try {
      const q = encodeURIComponent(`${searchQuery} India national highway`)
      const rows = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=15&countrycodes=in&polygon_geojson=1&q=${q}`,
        { headers: { Accept: 'application/json' } },
      ).then((r) => r.json() as Promise<NominatimRow[]>)
      const filtered = rows.filter(isLikelyHighwayHit)
      if (!filtered.length) throw new Error('No National Highway match found in Nominatim')
      setSearchResults(filtered)
      setSelectedSearchIndex(0)
      applyRouteFromNominatimHit(filtered[0])
    } catch (err: unknown) {
      setPageErr(err instanceof Error ? err.message : 'Highway search failed')
    } finally {
      setSearchLoading(false)
    }
  }

  const chooseSearchResult = (idx: number) => {
    const hit = searchResults[idx]
    if (!hit) return
    setSelectedSearchIndex(idx)
    applyRouteFromNominatimHit(hit)
  }

  const applyManualCorridor = () => {
    setPageErr(null)
    const slat = Number(manualStartLat)
    const slng = Number(manualStartLng)
    const elat = Number(manualEndLat)
    const elng = Number(manualEndLng)
    if (![slat, slng, elat, elng].every((n) => Number.isFinite(n))) {
      setPageErr('Enter valid numeric start and end latitude/longitude.')
      return
    }
    const km = haversineKm(slat, slng, elat, elng)
    if (!(km > 0)) {
      setPageErr('Segment length must be greater than zero.')
      return
    }
    const a: LatLng = { lat: slat, lng: slng }
    const b: LatLng = { lat: elat, lng: elng }
    setRoutePath([a, b])
    setRouteSectionPicks({ start: a, end: b })
    setCorridorDraft({
      name: `Manual ${slat.toFixed(5)},${slng.toFixed(5)} → ${elat.toFixed(5)},${elng.toFixed(5)}`,
      start_lat: slat,
      start_lng: slng,
      end_lat: elat,
      end_lng: elng,
      km_length: km,
      code: null,
    })
  }

  const resetCorridorForm = () => {
    setRoutePath(null)
    setRouteSectionPicks({ start: null, end: null })
    setCorridorDraft(null)
    setSearchResults([])
    setSelectedSearchIndex(null)
  }

  const addCorridor = async (e: FormEvent) => {
    e.preventDefault()
    if (!token) return
    if (!corridorDraft) {
      setPageErr('Complete the corridor: search the highway and pick start/end on the blue line, or enter manual coordinates.')
      return
    }
    setPageErr(null)
    try {
      await postJson('/admin/corridors', token, {
        name: corridorDraft.name,
        code: corridorDraft.code,
        start_lat: corridorDraft.start_lat,
        start_lng: corridorDraft.start_lng,
        end_lat: corridorDraft.end_lat,
        end_lng: corridorDraft.end_lng,
        km_length: corridorDraft.km_length,
        organisation_id: newCorridorOrgId || null,
      })
      resetCorridorForm()
      await loadCorridors()
    } catch (err: unknown) {
      reportApiErr(err, 'Failed to add corridor')
    }
  }

  const activeMapCount = useMemo(() => liveMap.reduce((acc, c) => acc + c.incidents.length, 0), [liveMap])
  const criticalCount = useMemo(
    () =>
      liveMap.reduce(
        (acc, c) => acc + c.incidents.filter((i) => i.severity.toLowerCase() === 'critical').length,
        0,
      ),
    [liveMap],
  )
  const activeAmbulances = useMemo(
    () =>
      liveMap.reduce(
        (acc, c) =>
          acc +
          c.vehicles.filter((v) => ['dispatched', 'en_route', 'on_scene'].includes(v.status.toLowerCase())).length,
        0,
      ),
    [liveMap],
  )

  if (!token || !user) {
    return (
      <div className="login-panel">
        <h1>REACH — Internal admin</h1>
        <form onSubmit={(e) => void doLogin(e)}>
          <label>
            Phone
            <input value={loginPhone} onChange={(e) => setLoginPhone(e.target.value)} autoComplete="username" />
          </label>
          <label>
            Password
            <input type="password" value={loginPw} onChange={(e) => setLoginPw(e.target.value)} autoComplete="current-password" />
          </label>
          {loginErr && <p className="err">{loginErr}</p>}
          <button type="submit">Sign in</button>
        </form>
        <p className="hint">Same JWT as dispatch console. Demo: +919876543210 / reach2026.</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Admin sections">
        <h1>REACH Admin</h1>
        <button type="button" className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>
          Dashboard
        </button>
        <button type="button" className={tab === 'analytics' ? 'active' : ''} onClick={() => setTab('analytics')}>
          Analytics
        </button>
        <button type="button" className={tab === 'broadcast' ? 'active' : ''} onClick={() => setTab('broadcast')}>
          Broadcast
        </button>
        <button type="button" className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>
          Live Map
        </button>
        <button type="button" className={tab === 'speed_zones' ? 'active' : ''} onClick={() => setTab('speed_zones')}>
          Speed zones
        </button>
        <button type="button" className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
          Users
        </button>
        <button type="button" className={tab === 'corridors' ? 'active' : ''} onClick={() => setTab('corridors')}>
          Corridors
        </button>
        <div className="logout">
          <button type="button" onClick={logout}>Log out {user.full_name ?? user.phone}</button>
        </div>
      </nav>

      <main className="main">
        {tab === 'dashboard' && (
          <>
            <h2>Dashboard</h2>
            {pageErr && <p className="err">{pageErr}</p>}
            {archiveStaleInfo && <p className="info-banner">{archiveStaleInfo}</p>}
            <div className="grid-stats">
              <div className="stat-card stat-card-lg">
                <div className="stat-card-inner">
                  <span className="stat-card-icon" aria-hidden>
                    🟢
                  </span>
                  <div>
                    <div className="label">API health</div>
                    <div className={`value ${apiOk === true ? 'ok' : apiOk === false ? 'bad' : ''}`}>{apiOk === null ? '…' : apiOk ? 'Up' : 'Down'}</div>
                  </div>
                </div>
              </div>
              <button
                type="button"
                className={`stat-card stat-card-lg stat-card--clickable ${dashboardSection === 'active' ? 'stat-card--selected' : ''}`}
                onClick={() => {
                  setDashboardSection('active')
                  void loadActiveIncidents()
                }}
              >
                <div className="stat-card-inner">
                  <span className="stat-card-icon" aria-hidden>
                    🚨
                  </span>
                  <div>
                    <div className="label">Active incidents</div>
                    <div className="value">{dash?.active_incidents ?? '—'}</div>
                  </div>
                </div>
              </button>
              <button
                type="button"
                className={`stat-card stat-card-lg stat-card--clickable ${dashboardSection === 'vehicles' ? 'stat-card--selected' : ''}`}
                onClick={() => {
                  setDashboardSection('vehicles')
                  void loadVehiclesDashboard()
                }}
              >
                <div className="stat-card-inner">
                  <span className="stat-card-icon" aria-hidden>
                    🚑
                  </span>
                  <div>
                    <div className="label">Vehicles</div>
                    <div className="value">{dash?.total_vehicles ?? '—'}</div>
                  </div>
                </div>
              </button>
              <button
                type="button"
                className={`stat-card stat-card-lg stat-card--clickable ${dashboardSection === 'corridors' ? 'stat-card--selected' : ''}`}
                onClick={() => {
                  setDashboardSection('corridors')
                  void loadCorridors().catch((e: unknown) => reportApiErr(e))
                }}
              >
                <div className="stat-card-inner">
                  <span className="stat-card-icon" aria-hidden>
                    🛣️
                  </span>
                  <div>
                    <div className="label">Corridors</div>
                    <div className="value">{dash?.total_corridors ?? '—'}</div>
                  </div>
                </div>
              </button>
            </div>
            <p className="dash-summary" role="status">
              {dash ? (
                <>
                  <strong>{dash.active_incidents}</strong> active · <strong>{dash.dispatched_incidents}</strong> dispatched ·{' '}
                  <strong>{dash.closed_today}</strong> closed today
                </>
              ) : (
                '…'
              )}
            </p>
            <p className="dash-section-hint">
              <button type="button" className="link-btn" onClick={() => setDashboardSection('recent')}>
                Show last 10 incidents
              </button>
            </p>
            <div className="dash-export-row">
              <button
                type="button"
                className="btn-export"
                onClick={() => {
                  if (!token) return
                  void downloadBlob('/admin/incidents/export?limit=100', token, 'reach_incidents_export.csv').catch(
                    (e: unknown) => reportApiErr(e, 'Export failed'),
                  )
                }}
              >
                Export last 100 incidents (CSV)
              </button>
              <button type="button" className="btn-clear-test" disabled={archiveStaleBusy} onClick={() => void archiveStaleTestData()}>
                {archiveStaleBusy ? 'Working…' : 'Clear test data'}
              </button>
            </div>
            {dashboardSection === 'vehicles' ? (
              <div className="feed feed--table">
                <h3>All vehicles</h3>
                <div className="table-wrap">
                  <table className="veh-table">
                    <thead>
                      <tr>
                        <th>Ambulance ID</th>
                        <th>Driver</th>
                        <th>Status</th>
                        <th>Location (KM)</th>
                        <th>Last updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vehiclesDash.map((v) => (
                        <tr key={v.id} className={vehicleStatusToneClass(v.status, v.is_available)}>
                          <td>
                            <strong>{v.label}</strong>
                            <span className="muted small-block">{v.corridor_name}</span>
                          </td>
                          <td>{v.driver_name ?? '—'}</td>
                          <td>
                            <span className="veh-status-pill">{v.status}</span>
                          </td>
                          <td>{v.km_marker != null ? `KM ${v.km_marker.toFixed(1)}` : '—'}</td>
                          <td>{new Date(v.updated_at).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : dashboardSection === 'corridors' ? (
              <div className="feed feed--table">
                <h3>Corridor details</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Code</th>
                        <th>KM range</th>
                        <th>Active</th>
                      </tr>
                    </thead>
                    <tbody>
                      {corridors.map((c) => (
                        <tr key={c.id}>
                          <td>{c.name}</td>
                          <td>{c.code ?? '—'}</td>
                          <td>
                            {c.km_start != null && c.km_end != null ? `${c.km_start}–${c.km_end}` : '—'}
                          </td>
                          <td>{c.is_active ? 'Yes' : 'No'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="feed">
                <h3>
                  {dashboardSection === 'active' ? 'Active incidents' : 'Last 10 incidents'}{' '}
                  <span className="feed-hint">(click a row for detail)</span>
                </h3>
                <ul>
                  {(dashboardSection === 'active' ? activeIncidents : recent).map((i) => (
                    <li key={i.id} className={incidentRowClass(i)}>
                      <button type="button" className="feed-row" onClick={() => void openIncidentDetail(i.id)}>
                        <span className={severityClass(i.severity)}>{i.severity}</span> · {i.incident_type} · <strong>{i.corridor_name}</strong> · KM {i.km_marker ?? '—'} · {i.status} ·{' '}
                        {new Date(i.created_at).toLocaleString()}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="hint" style={{ marginTop: '1rem', color: 'var(--muted)', fontSize: '0.85rem' }}>
              Health: <code>{API}/api/health</code> · Data via <code>{apiUrl('/admin/dashboard')}</code>
            </p>
          </>
        )}

        {tab === 'analytics' && token && (
          <>
            {pageErr && <p className="err">{pageErr}</p>}
            <AnalyticsPage token={token} onError={setPageErr} />
          </>
        )}

        {tab === 'broadcast' && token && (
          <>
            {pageErr && <p className="err">{pageErr}</p>}
            <BroadcastPage token={token} onError={setPageErr} />
          </>
        )}

        {tab === 'speed_zones' && token && (
          <>
            {pageErr && <p className="err">{pageErr}</p>}
            <SpeedZonesPage token={token} corridors={corridors} onError={setPageErr} />
          </>
        )}

        {tab === 'map' && (
          <>
            <h2>Live map — India operations</h2>
            {pageErr && <p className="err">{pageErr}</p>}
            <div className="map-summary">
              <span>Total incidents: {activeMapCount}</span>
              <span className="critical">Critical: {criticalCount}</span>
              <span className="active-amb">Ambulances active: {activeAmbulances}</span>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginTop: 0 }}>
              SVG highway: positions use <strong>km_marker</strong> when set, otherwise GPS projected onto the Bengaluru–Chennai axis (0–312 km).
            </p>
            <p style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>
              Corridors: {liveMap.length}. Data: <code>GET /api/admin/live-map</code>. Refreshes every 15s.
            </p>
            <LiveHighwayDiagram corridors={liveMap} />
          </>
        )}

        {tab === 'users' && (
          <>
            <h2>Users</h2>
            {pageErr && <p className="err">{pageErr}</p>}
            <form className="form-panel" onSubmit={(e) => void addUser(e)}>
              <h3>Add user</h3>
              <div className="form-row"><label>Phone</label><input value={newUserPhone} onChange={(e) => setNewUserPhone(e.target.value)} required /></div>
              <div className="form-row"><label>Password</label><input type="password" value={newUserPw} onChange={(e) => setNewUserPw(e.target.value)} required /></div>
              <div className="form-row"><label>Full name</label><input value={newUserName} onChange={(e) => setNewUserName(e.target.value)} /></div>
              <div className="form-row">
                <label>Role</label>
                <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as typeof newUserRole)}>
                  <option value="dispatch_operator">Operator</option>
                  <option value="driver">Driver</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button type="submit">Add user</button>
            </form>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th /></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.full_name ?? '—'}</td><td>{u.phone}</td><td>{roleLabel(u.role)}</td>
                      <td><button type="button" className="btn-danger" onClick={() => void removeUser(u.id)}>Delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'corridors' && (
          <>
            <h2>Corridors</h2>
            {pageErr && <p className="err">{pageErr}</p>}
            <form className="form-panel" onSubmit={(e) => void addCorridor(e)}>
              <h3>Create corridor (real geo coordinates)</h3>
              <div className="segmented">
                <button
                  className={corridorCreateMode === 'search' ? 'active' : ''}
                  type="button"
                  onClick={() => {
                    setCorridorCreateMode('search')
                    setManualStartLat('')
                    setManualStartLng('')
                    setManualEndLat('')
                    setManualEndLng('')
                  }}
                >
                  Highway search + section on map
                </button>
                <button
                  className={corridorCreateMode === 'manual' ? 'active' : ''}
                  type="button"
                  onClick={() => {
                    setCorridorCreateMode('manual')
                    setRoutePath(null)
                    setRouteSectionPicks({ start: null, end: null })
                    setCorridorDraft(null)
                    setSearchResults([])
                    setSelectedSearchIndex(null)
                  }}
                >
                  Manual lat / long
                </button>
              </div>
              {corridorCreateMode === 'search' ? (
                <div className="form-row">
                  <p className="hint" style={{ margin: '0 0 0.5rem', fontSize: '0.85rem' }}>
                    <strong>Step 1</strong> — Search (e.g. NH48). Nominatim returns the route; it is drawn in <strong>blue</strong>.
                    <strong> Step 2</strong> — Click <strong>twice on or near that blue line</strong> for your section start and end (snapped to the route).
                    <strong> Step 3</strong> — The yellow highlight shows the segment; confirmation below lists coordinates and path length (sum of Haversine legs along the route).
                    The map opens with a zoomed-out India view so you can inspect the full route first.
                  </p>
                  <label>Highway name (e.g. NH48, NH44)</label>
                  <div className="inline-row">
                    <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
                    <button type="button" onClick={() => void searchHighway()} disabled={searchLoading}>
                      {searchLoading ? 'Searching...' : 'Search OSM'}
                    </button>
                  </div>
                  {searchResults.length > 0 && (
                    <div className="search-results">
                      {searchResults.map((row, idx) => (
                        <button
                          type="button"
                          key={`${row.lat}-${row.lon}-${idx}`}
                          className={selectedSearchIndex === idx ? 'active' : ''}
                          onClick={() => chooseSearchResult(idx)}
                        >
                          {row.display_name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="inline-row" style={{ marginTop: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={() => setRouteSectionPicks({ start: null, end: null })}
                      disabled={!routeSectionPicks.start && !routeSectionPicks.end}
                    >
                      Clear section picks
                    </button>
                  </div>
                  <label style={{ marginTop: '0.6rem' }}>Map (zoom/pan enabled)</label>
                  <CorridorRouteMap
                    leafletReady={leafletReady}
                    routePath={routePath}
                    segmentStart={routeSectionPicks.start}
                    segmentEnd={routeSectionPicks.end}
                    onPickAlongRoute={handlePickAlongRoute}
                  />
                  <div className="hint" style={{ fontSize: '0.82rem', marginTop: '0.35rem' }}>
                    Picks: {routeSectionPicks.start ? 'start ✓' : 'start …'} · {routeSectionPicks.end ? 'end ✓' : 'end …'}
                  </div>
                </div>
              ) : (
                <div className="form-row">
                  <p className="hint" style={{ margin: '0 0 0.5rem', fontSize: '0.85rem' }}>
                    Enter exact start and end coordinates. Length is the straight-line Haversine distance between the two points.
                  </p>
                  <div className="form-row grid-manual-coords">
                    <label>
                      Start latitude
                      <input value={manualStartLat} onChange={(e) => setManualStartLat(e.target.value)} placeholder="e.g. 12.9716" />
                    </label>
                    <label>
                      Start longitude
                      <input value={manualStartLng} onChange={(e) => setManualStartLng(e.target.value)} placeholder="e.g. 77.5946" />
                    </label>
                    <label>
                      End latitude
                      <input value={manualEndLat} onChange={(e) => setManualEndLat(e.target.value)} />
                    </label>
                    <label>
                      End longitude
                      <input value={manualEndLng} onChange={(e) => setManualEndLng(e.target.value)} />
                    </label>
                  </div>
                  <button type="button" onClick={applyManualCorridor}>
                    Apply manual coordinates
                  </button>
                  <label style={{ marginTop: '0.75rem' }}>Map preview</label>
                  <CorridorRouteMap
                    leafletReady={leafletReady}
                    routePath={routePath}
                    segmentStart={routeSectionPicks.start}
                    segmentEnd={routeSectionPicks.end}
                    onPickAlongRoute={() => {}}
                  />
                </div>
              )}
              <div className="form-row">
                <label>Organisation</label>
                <select value={newCorridorOrgId} onChange={(e) => setNewCorridorOrgId(e.target.value)}>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div className="confirm-box">
                <h4>Confirmation</h4>
                <div>Name: {corridorDraft?.name ?? '—'}</div>
                <div>
                  Start: {corridorDraft ? `${corridorDraft.start_lat.toFixed(6)}, ${corridorDraft.start_lng.toFixed(6)}` : '—'}
                </div>
                <div>
                  End: {corridorDraft ? `${corridorDraft.end_lat.toFixed(6)}, ${corridorDraft.end_lng.toFixed(6)}` : '—'}
                </div>
                <div>KM length: {corridorDraft ? corridorDraft.km_length.toFixed(2) : '—'}</div>
              </div>
              <button type="submit" disabled={!corridorDraft}>Save corridor</button>
            </form>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Start (lat,lng)</th><th>End (lat,lng)</th><th>KM length</th><th>Active</th><th /></tr></thead>
                <tbody>
                  {corridors.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.start_lat != null && c.start_lng != null ? `${c.start_lat.toFixed(4)}, ${c.start_lng.toFixed(4)}` : '—'}</td>
                      <td>{c.end_lat != null && c.end_lng != null ? `${c.end_lat.toFixed(4)}, ${c.end_lng.toFixed(4)}` : '—'}</td>
                      <td>{c.km_end != null ? c.km_end.toFixed(2) : '—'}</td>
                      <td>{c.is_active ? 'Yes' : 'No'}</td>
                      <td>
                        <button type="button" className="btn-danger" onClick={() => void removeCorridor(c.id)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>

      {selectedIncident && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSelectedIncident(null)}>
          <section className="incident-modal incident-modal--wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="incident-modal-header">
              <h3 className="incident-modal-title">Incident</h3>
              <button type="button" className="modal-close-x" aria-label="Close" onClick={() => setSelectedIncident(null)}>
                ×
              </button>
            </div>
            {incidentLoading ? (
              <p>Loading…</p>
            ) : (
              <>
                <div className="incident-modal-hero">
                  <span className="incident-type-ico" aria-hidden>
                    {incidentTypeEmoji(selectedIncident.incident_type)}
                  </span>
                  <div className="incident-badges">
                    <span className={`pill pill-sev ${severityClass(selectedIncident.severity)}`}>{selectedIncident.severity}</span>
                    <span className="pill pill-status">{selectedIncident.status}</span>
                    <span className="pill pill-km">KM {selectedIncident.km_marker ?? '—'}</span>
                  </div>
                </div>
                <IncidentMiniMap
                  leafletReady={leafletReady}
                  latitude={selectedIncident.latitude ?? null}
                  longitude={selectedIncident.longitude ?? null}
                />
                <div className="incident-modal-grid">
                  <div>
                    <h4>Details</h4>
                    <dl className="kv kv-tight">
                      <dt>Reported at</dt>
                      <dd>{new Date(selectedIncident.created_at).toLocaleString()}</dd>
                      <dt>Reporter</dt>
                      <dd>{selectedIncident.reporter_type ?? '—'}</dd>
                      <dt>Injured</dt>
                      <dd>{selectedIncident.injured_count ?? '—'}</dd>
                      <dt>Hazards</dt>
                      <dd>
                        {Array.isArray(selectedIncident.sos_details?.hazards) && (selectedIncident.sos_details?.hazards as string[]).length
                          ? (selectedIncident.sos_details?.hazards as string[]).map(hazardIdLabel).join(', ')
                          : '—'}
                      </dd>
                      <dt>Direction</dt>
                      <dd>{directionHuman(selectedIncident.sos_details?.direction)}</dd>
                      <dt>Notes</dt>
                      <dd>{selectedIncident.notes?.trim() || '—'}</dd>
                      <dt>Report ID</dt>
                      <dd>{selectedIncident.public_report_id ?? '—'}</dd>
                    </dl>
                  </div>
                  <div>
                    <h4>Assigned vehicle</h4>
                    <dl className="kv kv-tight">
                      <dt>Ambulance</dt>
                      <dd>{selectedIncident.assigned_vehicle_label ?? '—'}</dd>
                      <dt>Driver</dt>
                      <dd>{selectedIncident.driver_name ?? '—'}</dd>
                      <dt>ETA</dt>
                      <dd>
                        {selectedIncident.eta_minutes != null ? `${selectedIncident.eta_minutes} min (approx)` : '—'}
                      </dd>
                    </dl>
                    <div className="trust-pill-wrap">
                      <span className="trust-pill" title="Trust score">
                        Trust {selectedIncident.trust_score}/100 — {trustLabel(selectedIncident.trust_score)}
                      </span>
                    </div>
                  </div>
                </div>
                <h4>Timeline</h4>
                <ul className="phase-timeline">
                  {(() => {
                    const ph = buildPhaseTimes(selectedIncident)
                    return (
                      <>
                        <li>
                          <span className="phase-label">Created</span>
                          <span className="phase-time">{ph.created ? new Date(ph.created).toLocaleString() : '—'}</span>
                        </li>
                        <li>
                          <span className="phase-label">Dispatched</span>
                          <span className="phase-time">{ph.dispatched ? new Date(ph.dispatched).toLocaleString() : '—'}</span>
                        </li>
                        <li>
                          <span className="phase-label">Arrived</span>
                          <span className="phase-time">{ph.arrived ? new Date(ph.arrived).toLocaleString() : '—'}</span>
                        </li>
                        <li>
                          <span className="phase-label">Cleared</span>
                          <span className="phase-time">{ph.cleared ? new Date(ph.cleared).toLocaleString() : '—'}</span>
                        </li>
                      </>
                    )
                  })()}
                </ul>
                <h4 className="muted-heading">Raw events</h4>
                <ul className="vehicle-list vehicle-list--compact">
                  {selectedIncident.timeline.map((ev) => (
                    <li key={ev.id}>
                      <strong>{ev.event_type}</strong> · {new Date(ev.created_at).toLocaleString()}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
