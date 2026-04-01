import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { API, apiUrl, deleteJson, fetchJson, healthPing, login, postJson, type User } from './api'

type Tab = 'dashboard' | 'map' | 'users' | 'corridors'

type Dashboard = {
  active_incidents: number
  total_vehicles: number
  total_corridors: number
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
  public_report_id: string | null
  created_at: string
  assigned_vehicle_label: string | null
  timeline: TimelineEvent[]
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

function vehicleStatusLabel(status: string): string {
  const s = status.toLowerCase().replace(/_/g, ' ')
  if (s === 'available') return 'idle'
  return s
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function estimatePointFromKm(km: number): LatLng {
  const bengaluru = { lat: 12.9716, lng: 77.5946 }
  const chennai = { lat: 13.0827, lng: 80.2707 }
  const nh48Km = 312
  const t = Math.min(1, Math.max(0, km / nh48Km))
  return {
    lat: bengaluru.lat + (chennai.lat - bengaluru.lat) * t,
    lng: bengaluru.lng + (chennai.lng - bengaluru.lng) * t,
  }
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

function LiveLeafletMap({ leafletReady, corridors }: { leafletReady: boolean; corridors: LiveMapCorridor[] }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any>(null)
  const layerRef = useRef<any>(null)
  const markerPointsRef = useRef<[number, number][]>([])
  const hasAnyMappable = corridors.some(
    (c) =>
      c.incidents.some((i) => incidentLatLng(i) != null) ||
      c.vehicles.some((v) => vehicleLatLng(v) != null),
  )

  const scheduleInvalidate = useCallback((map: any) => {
    window.setTimeout(() => map.invalidateSize(), 120)
    window.requestAnimationFrame(() => map.invalidateSize())
  }, [])

  useEffect(() => {
    if (!leafletReady) return
    const L = (window as any).L
    const el = hostRef.current
    if (!L || !el || mapRef.current) return
    if ((el as any)._leaflet_id) el.innerHTML = ''
    const map = L.map(el).setView([20.5937, 78.9629], 6)
    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors, SRTM | OpenTopoMap',
      maxZoom: 17,
    }).addTo(map)
    mapRef.current = map
    layerRef.current = L.layerGroup().addTo(map)
    scheduleInvalidate(map)
    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [leafletReady, scheduleInvalidate])

  useEffect(() => {
    const L = (window as any).L
    const map = mapRef.current
    const layer = layerRef.current
    if (!leafletReady || !L || !map || !layer) return
    layer.clearLayers()
    const points: [number, number][] = []

    for (const corridor of corridors) {
      for (const inc of corridor.incidents) {
        const p = incidentLatLng(inc)
        if (!p) continue
        points.push([p.lat, p.lng])
        const marker = L.circleMarker([p.lat, p.lng], {
          radius: 8,
          color: '#0f172a',
          weight: 1.5,
          fillColor: incidentDotColor(inc.severity),
          fillOpacity: 0.92,
        })
        marker.bindPopup(
          `<strong>${escapeHtml(inc.incident_type)}</strong><br/>` +
            `Severity: ${escapeHtml(inc.severity)}<br/>` +
            `Status: ${escapeHtml(inc.status)}<br/>` +
            `Trust: ${escapeHtml(trustLabel(inc.trust_score))}<br/>` +
            `Time reported: ${escapeHtml(new Date(inc.created_at).toLocaleString())}<br/>` +
            `Report ID: ${inc.public_report_id ? escapeHtml(inc.public_report_id) : '—'}`,
        )
        marker.addTo(layer)
      }
      for (const v of corridor.vehicles) {
        const p = vehicleLatLng(v)
        if (!p) continue
        points.push([p.lat, p.lng])
        const marker = L.marker([p.lat, p.lng], {
          icon: L.divIcon({
            className: 'ambulance-marker',
            html: '<span>🚑</span>',
            iconSize: [26, 26],
            iconAnchor: [13, 13],
          }),
        })
        marker.bindPopup(
          `<strong>${escapeHtml(v.label)}</strong><br/>` +
            `Status: ${escapeHtml(vehicleStatusLabel(v.status))}<br/>` +
            `Assigned incident: ${v.assigned_incident_id ?? '—'}`,
        )
        marker.addTo(layer)
      }
    }

    markerPointsRef.current = points
  }, [leafletReady, corridors])

  const fitAllMarkers = useCallback(() => {
    const L = (window as any).L
    const map = mapRef.current
    const points = markerPointsRef.current
    if (!L || !map || points.length === 0) return
    map.fitBounds(L.latLngBounds(points), { padding: [28, 28] })
  }, [])

  if (!leafletReady) return <div className="leaflet-box live-leaflet-map map-loading">Loading map engine...</div>
  return (
    <div className="live-map-wrap">
      <div className="inline-row live-map-toolbar">
        <button type="button" onClick={fitAllMarkers} disabled={!hasAnyMappable}>
          Fit all markers
        </button>
      </div>
      <div className="leaflet-box live-leaflet-map" ref={hostRef} />
    </div>
  )
}

export default function App() {
  const leafletReady = useLeafletReady()
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('reach_token'))
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
  const [liveMap, setLiveMap] = useState<LiveMapCorridor[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [corridors, setCorridors] = useState<CorridorRow[]>([])
  const [orgs, setOrgs] = useState<Organisation[]>([])
  const [pageErr, setPageErr] = useState<string | null>(null)
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

  const loadDashboard = useCallback(async () => {
    if (!token) return
    const ok = await healthPing()
    setApiOk(ok)
    const [d, r] = await Promise.all([
      fetchJson<Dashboard>('/admin/dashboard', token),
      fetchJson<RecentIncident[]>('/admin/incidents/recent?limit=10', token),
    ])
    setDash(d)
    setRecent(r)
  }, [token])

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
    void loadDashboard().catch((e: unknown) => setPageErr(e instanceof Error ? e.message : String(e)))
  }, [token, loadDashboard])

  useEffect(() => {
    if (!token || tab !== 'map') return
    void loadMap().catch((e: unknown) => setPageErr(e instanceof Error ? e.message : String(e)))
    const id = window.setInterval(() => {
      void loadMap().catch(() => {})
    }, 15000)
    return () => window.clearInterval(id)
  }, [token, tab, loadMap])

  useEffect(() => {
    if (!token || tab !== 'users') return
    void loadUsers().catch((e: unknown) => setPageErr(e instanceof Error ? e.message : String(e)))
  }, [token, tab, loadUsers])

  useEffect(() => {
    if (!token || tab !== 'corridors') return
    void loadCorridors().catch((e: unknown) => setPageErr(e instanceof Error ? e.message : String(e)))
  }, [token, tab, loadCorridors])

  const doLogin = async (e: FormEvent) => {
    e.preventDefault()
    setLoginErr(null)
    try {
      const res = await login(loginPhone, loginPw)
      localStorage.setItem('reach_token', res.access_token)
      localStorage.setItem('reach_user', JSON.stringify(res.user))
      setToken(res.access_token)
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
      setPageErr(err instanceof Error ? err.message : 'Failed to fetch incident detail')
    } finally {
      setIncidentLoading(false)
    }
  }

  const logout = () => {
    localStorage.removeItem('reach_token')
    localStorage.removeItem('reach_user')
    setToken(null)
    setUser(null)
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
      setPageErr(err instanceof Error ? err.message : 'Failed to add user')
    }
  }

  const removeUser = async (id: string) => {
    if (!token || !confirm('Delete this user?')) return
    setPageErr(null)
    try {
      await deleteJson(`/admin/users/${id}`, token)
      await loadUsers()
    } catch (err: unknown) {
      setPageErr(err instanceof Error ? err.message : 'Failed to delete')
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
      setPageErr(err instanceof Error ? err.message : 'Failed to delete corridor')
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
      setPageErr(err instanceof Error ? err.message : 'Failed to add corridor')
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
        <button type="button" className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
        <button type="button" className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>Live Map</button>
        <button type="button" className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Users</button>
        <button type="button" className={tab === 'corridors' ? 'active' : ''} onClick={() => setTab('corridors')}>Corridors</button>
        <div className="logout">
          <button type="button" onClick={logout}>Log out {user.full_name ?? user.phone}</button>
        </div>
      </nav>

      <main className="main">
        {tab === 'dashboard' && (
          <>
            <h2>Dashboard</h2>
            {pageErr && <p className="err">{pageErr}</p>}
            <div className="grid-stats">
              <div className="stat-card"><div className="label">API health</div><div className={`value ${apiOk ? 'ok' : 'bad'}`}>{apiOk === null ? '…' : apiOk ? 'Up' : 'Down'}</div></div>
              <div className="stat-card"><div className="label">Active incidents</div><div className="value">{dash?.active_incidents ?? '—'}</div></div>
              <div className="stat-card"><div className="label">Vehicles</div><div className="value">{dash?.total_vehicles ?? '—'}</div></div>
              <div className="stat-card"><div className="label">Corridors</div><div className="value">{dash?.total_corridors ?? '—'}</div></div>
            </div>
            <div className="feed">
              <h3>Last 10 incidents (click for detail)</h3>
              <ul>
                {recent.map((i) => (
                  <li key={i.id}>
                    <button type="button" className="feed-row" onClick={() => void openIncidentDetail(i.id)}>
                      <span className={severityClass(i.severity)}>{i.severity}</span> · {i.incident_type} · <strong>{i.corridor_name}</strong> · KM {i.km_marker ?? '—'} · {i.status} · {new Date(i.created_at).toLocaleString()}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <p className="hint" style={{ marginTop: '1rem', color: 'var(--muted)', fontSize: '0.85rem' }}>
              Health: <code>{API}/api/health</code> · Data via <code>{apiUrl('/admin/dashboard')}</code>
            </p>
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
              Real OpenStreetMap terrain view. Incidents/ambulances use GPS when available; otherwise positions are estimated from NH48 KM (Bengaluru to Chennai).
            </p>
            <p style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Corridors: {liveMap.length}. Refreshes every 15s.</p>
            <LiveLeafletMap leafletReady={leafletReady} corridors={liveMap} />
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
          <section className="incident-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="incident-modal-header">
              <h3>Incident Detail</h3>
              <button type="button" onClick={() => setSelectedIncident(null)}>Close</button>
            </div>
            {incidentLoading ? <p>Loading…</p> : (
              <>
                <dl className="kv">
                  <dt>Type</dt><dd>{selectedIncident.incident_type}</dd>
                  <dt>Severity</dt><dd>{selectedIncident.severity}</dd>
                  <dt>Status</dt><dd>{selectedIncident.status}</dd>
                  <dt>Trust</dt><dd>{trustLabel(selectedIncident.trust_score)}</dd>
                  <dt>KM marker</dt><dd>{selectedIncident.km_marker ?? '—'}</dd>
                  <dt>Report ID</dt><dd>{selectedIncident.public_report_id ?? '—'}</dd>
                  <dt>Time reported</dt><dd>{new Date(selectedIncident.created_at).toLocaleString()}</dd>
                  <dt>Assigned vehicle</dt><dd>{selectedIncident.assigned_vehicle_label ?? '—'}</dd>
                </dl>
                <h4>Timeline</h4>
                <ul className="vehicle-list">
                  {selectedIncident.timeline.map((ev) => (
                    <li key={ev.id}><strong>{ev.event_type}</strong> · {new Date(ev.created_at).toLocaleString()}</li>
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
