import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  Pie,
  PieChart,
  RadialBar,
  RadialBarChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import 'leaflet/dist/leaflet.css'
import { deleteJson, fetchJson, isSessionExpiredError, patchJson, postJson } from './api'

const DefaultIcon = L.icon({
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
})
L.Marker.prototype.options.icon = DefaultIcon

const NH48_KM_LENGTH = 312
/** NH48 route: KM anchors along Bengaluru → Chennai polyline (analytics map). */
const NH48_ROUTE: { km: number; lat: number; lng: number }[] = [
  { km: 0, lat: 12.9716, lng: 77.5946 },
  { km: 52, lat: 12.7409, lng: 77.8253 },
  { km: 100, lat: 12.5266, lng: 78.2137 },
  { km: 218, lat: 12.9165, lng: 79.1325 },
  { km: 312, lat: 13.0827, lng: 80.2707 },
]

const NH48_WAYPOINTS: L.LatLngExpression[] = NH48_ROUTE.map((p) => [p.lat, p.lng])

/** Icons as codepoints — keeps source file encoding-safe. */
const Ic = {
  up: '\u25b2',
  down: '\u25bc',
  alert: String.fromCodePoint(0x1f6a8),
  clock: String.fromCodePoint(0x23f1, 0xfe0f),
  tick: String.fromCodePoint(0x2705),
  masks: String.fromCodePoint(0x1f3ad),
  ambulance: String.fromCodePoint(0x1f691),
  pin: String.fromCodePoint(0x1f4cd),
  warn: String.fromCodePoint(0x26a0, 0xfe0f),
  liveDot: String.fromCodePoint(0x1f534),
  urgentLbl: String.fromCodePoint(0x1f534),
  infoLbl: String.fromCodePoint(0x1f7e1),
} as const

const TOWN_ANCHORS_KM: { km: number; name: string }[] = [
  { km: 0, name: 'Bengaluru' },
  { km: 52, name: 'Hosur' },
  { km: 100, name: 'Krishnagiri' },
  { km: 218, name: 'Vellore' },
  { km: 312, name: 'Chennai' },
]

function nearestTownForSegmentMid(midKm: number): string {
  let best = TOWN_ANCHORS_KM[0]
  let d = Math.abs(midKm - best.km)
  for (const t of TOWN_ANCHORS_KM) {
    const nd = Math.abs(midKm - t.km)
    if (nd < d) {
      d = nd
      best = t
    }
  }
  return best.name
}

function latLngFromKm(km: number): L.LatLngTuple {
  const k = Math.max(0, Math.min(NH48_KM_LENGTH, km))
  const r = NH48_ROUTE
  if (k <= r[0].km) return [r[0].lat, r[0].lng]
  for (let i = 0; i < r.length - 1; i++) {
    const a = r[i]
    const b = r[i + 1]
    if (k <= b.km) {
      const span = b.km - a.km
      const t = span > 0 ? (k - a.km) / span : 0
      const u = Math.max(0, Math.min(1, t))
      return [a.lat + (b.lat - a.lat) * u, a.lng + (b.lng - a.lng) * u]
    }
  }
  const last = r[r.length - 1]
  return [last.lat, last.lng]
}

function hasValidGps(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)
}

function closestPointOnSegment(
  lat: number,
  lng: number,
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): L.LatLngTuple {
  const dlat = lat2 - lat1
  const dlng = lng2 - lng1
  const len2 = dlat * dlat + dlng * dlng
  if (len2 < 1e-18) return [lat1, lng1]
  let t = ((lat - lat1) * dlat + (lng - lng1) * dlng) / len2
  t = Math.max(0, Math.min(1, t))
  return [lat1 + t * dlat, lng1 + t * dlng]
}

function squaredPlanarDist(latA: number, lngA: number, latB: number, lngB: number): number {
  const dlat = latA - latB
  const dlng = lngA - lngB
  return dlat * dlat + dlng * dlng
}

/** Snap a GPS point to the nearest point on the NH48 polyline (segment-wise). */
function snapGpsToNH48(lat: number, lng: number): L.LatLngTuple {
  let best: L.LatLngTuple = [lat, lng]
  let bestD = Infinity
  for (let i = 0; i < NH48_ROUTE.length - 1; i++) {
    const a = NH48_ROUTE[i]
    const b = NH48_ROUTE[i + 1]
    const c = closestPointOnSegment(lat, lng, a.lat, a.lng, b.lat, b.lng)
    const d = squaredPlanarDist(lat, lng, c[0], c[1])
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

export type AnalyticsPeriod = 'today' | '7d' | '30d'

export type AnalyticsIncidentRow = {
  id: string
  incident_type: string
  severity: string
  status: string
  created_at: string
  km_marker: number | null
  latitude: number | null
  longitude: number | null
  first_response_minutes: number | null
  time_to_scene_minutes: number | null
}

export type AdminAnalytics = {
  period: AnalyticsPeriod
  comparison_label: string
  incidents: AnalyticsIncidentRow[]
  incidents_previous: AnalyticsIncidentRow[]
  fleet: { available: number; dispatched: number; offline: number }
  coverage: { active_corridors: number; km_monitored: number }
  vehicle_performance: {
    vehicle_id: string
    label: string
    driver_name: string | null
    dispatch_count: number
    avg_response_minutes: number | null
    best_response_minutes: number | null
    status: string
    on_scene_now: boolean
    latitude: number | null
    longitude: number | null
  }[]
}

type LiveMapIncident = {
  id: string
  incident_type: string
  severity: string
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
  assigned_incident_type?: string | null
  driver_name?: string | null
}

type LiveMapOut = {
  corridors: {
    id: string
    name: string
    incidents: LiveMapIncident[]
    vehicles: LiveMapVehicle[]
  }[]
}

const INCIDENT_SEVERITY_COLOR: Record<string, string> = {
  critical: '#FF2D2D',
  major: '#FF6B00',
  minor: '#FFD600',
}

function vehicleStatusColor(status: string): string {
  const s = status.toLowerCase()
  if (s === 'available' || s === 'idle') return '#0EA5E9'
  if (s === 'dispatched' || s === 'en_route' || s === 'transporting') return '#8B5CF6'
  if (s === 'on_scene') return '#06B6D4'
  return '#64748b'
}

function incidentMarkerHtml(severity: string): string {
  const c = INCIDENT_SEVERITY_COLOR[severity.toLowerCase()] ?? '#f97316'
  const pulse = severity.toLowerCase() === 'critical' ? ' ops-inc--pulse' : ''
  return `<span class="ops-map-dot${pulse}" style="background:${c}"></span>`
}

function vehicleMarkerHtml(color: string): string {
  return `<span class="ops-map-veh" style="background:${color}"></span>`
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function resolutionRatePct(incidents: AnalyticsIncidentRow[]): number | null {
  if (incidents.length === 0) return null
  const cleared = incidents.filter((i) => ['closed', 'archived'].includes(i.status.toLowerCase())).length
  return Math.round((1000 * cleared) / incidents.length) / 10
}

function hoaxRatePct(incidents: AnalyticsIncidentRow[]): number | null {
  if (incidents.length === 0) return null
  const hoax = incidents.filter((i) => i.status.toLowerCase() === 'recalled').length
  return Math.round((1000 * hoax) / incidents.length) / 10
}

const TYPE_KEYS = ['accident', 'medical_emergency', 'breakdown', 'fire', 'obstacle_on_road'] as const
const TYPE_LABEL: Record<string, string> = {
  accident: 'Accident',
  medical_emergency: 'Medical Emergency',
  breakdown: 'Breakdown',
  fire: 'Fire',
  obstacle_on_road: 'Obstacle',
  other: 'Other',
}

const TYPE_COLORS = ['#38bdf8', '#a78bfa', '#f472b6', '#fb923c', '#4ade80', '#94a3b8']

function bucketIncidentType(raw: string): string {
  const k = raw.toLowerCase()
  if ((TYPE_KEYS as readonly string[]).includes(k)) return k
  if (k.includes('medical')) return 'medical_emergency'
  if (k.includes('obstacle')) return 'obstacle_on_road'
  return 'other'
}

function formatPeakLabel(hourCounts: number[]): string {
  const ranked = hourCounts
    .map((c, h) => ({ h, c }))
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c || a.h - b.h)
  if (ranked.length === 0) return ''
  const top = ranked.slice(0, 3).map((r) => r.h)
  top.sort((a, b) => a - b)
  const pad = (n: number) => String(n).padStart(2, '0')
  const ranges: string[] = []
  let s = top[0]
  let p = top[0]
  for (let i = 1; i < top.length; i++) {
    if (top[i] === p + 1) p = top[i]
    else {
      ranges.push(s === p ? `${pad(s)}:00` : `${pad(s)}:00–${pad(p + 1)}:00`)
      s = p = top[i]
    }
  }
  ranges.push(s === p ? `${pad(s)}:00` : `${pad(s)}:00–${pad(p + 1)}:00`)
  return `Peak: ${ranges.join(', ')}`
}

function stretchBarColor(count: number): string {
  if (count >= 3) return '#ef4444'
  if (count === 2) return '#fb923c'
  if (count === 1) return '#facc15'
  return '#475569'
}

function OpsLiveMap({
  liveMap,
  highlightVehicleId,
}: {
  liveMap: LiveMapOut | null
  highlightVehicleId: string | null
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const vehMarkersRef = useRef<Map<string, L.Marker>>(new Map())
  const layerRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    const el = rootRef.current
    if (!el || mapRef.current) return
    const map = L.map(el, { scrollWheelZoom: true }).setView([12.9, 78.2], 8)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map)
    const poly = L.polyline(NH48_WAYPOINTS, {
      color: '#2563eb',
      weight: 4,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map)
    map.fitBounds(poly.getBounds(), { padding: [40, 40] })
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
      vehMarkersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer || !liveMap) return
    layer.clearLayers()
    vehMarkersRef.current.clear()

    for (const c of liveMap.corridors) {
      for (const inc of c.incidents) {
        let lat: number
        let lng: number
        if (hasValidGps(inc.latitude, inc.longitude)) {
          ;[lat, lng] = snapGpsToNH48(inc.latitude as number, inc.longitude as number)
        } else if (inc.km_marker != null) {
          ;[lat, lng] = latLngFromKm(inc.km_marker)
        } else {
          continue
        }
        const icon = L.divIcon({
          className: 'ops-leaflet-divicon',
          html: incidentMarkerHtml(inc.severity),
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        })
        const m = L.marker([lat, lng], { icon })
        m.bindPopup(
          `<div class="ops-popup"><strong>${inc.incident_type.replace(/_/g, ' ')}</strong><br/>` +
            `${inc.severity} · ${inc.status}<br/>` +
            `KM: ${inc.km_marker != null ? inc.km_marker : '—'}<br/>` +
            `${new Date(inc.created_at).toLocaleString()}</div>`,
        )
        m.addTo(layer)
      }

      for (const v of c.vehicles) {
        let lat: number
        let lng: number
        if (hasValidGps(v.latitude, v.longitude)) {
          lat = v.latitude as number
          lng = v.longitude as number
        } else if (v.km_marker != null) {
          ;[lat, lng] = latLngFromKm(v.km_marker)
        } else {
          continue
        }
        const col = vehicleStatusColor(v.status)
        const icon = L.divIcon({
          className: 'ops-leaflet-divicon',
          html: vehicleMarkerHtml(col),
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        })
        const m = L.marker([lat, lng], { icon })
        m.bindPopup(
          `<div class="ops-popup"><strong>${v.label}</strong><br/>` +
            `${v.status}${v.driver_name ? `<br/>Driver: ${v.driver_name}` : ''}` +
            `${v.assigned_incident_type ? `<br/>Assignment: ${v.assigned_incident_type}` : ''}</div>`,
        )
        m.addTo(layer)
        vehMarkersRef.current.set(v.id, m)
      }
    }

    if (highlightVehicleId) {
      const mk = vehMarkersRef.current.get(highlightVehicleId)
      if (mk) {
        const ll = mk.getLatLng()
        map.setView(ll, Math.max(map.getZoom(), 11), { animate: true })
        mk.openPopup()
      }
    }
  }, [liveMap, highlightVehicleId])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    setTimeout(() => map.invalidateSize(), 200)
  }, [liveMap])

  return (
    <div className="ops-map-wrap">
      <div className="ops-map-shell">
        <div ref={rootRef} className="ops-map-canvas" />
        <div className="ops-map-live-badge" aria-hidden>
          <span className="ops-map-live-dot" /> LIVE
        </div>
      </div>
      <p className="ops-map-footnote">Incidents snapped to nearest highway point</p>
    </div>
  )
}

function GaugeAvgResponse({ minutes, compact }: { minutes: number | null; compact?: boolean }) {
  if (minutes == null) {
    return <div className={`ops-gauge-empty ${compact ? 'ops-gauge-empty--compact' : ''}`}>—</div>
  }
  const maxM = 30
  const pct = Math.min(100, (minutes / maxM) * 100)
  let col = '#22c55e'
  if (minutes > 15) col = '#ef4444'
  else if (minutes >= 8) col = '#f59e0b'
  const data = [{ name: 'r', value: pct, fill: col }]
  const dim = compact ? 88 : 112
  const c = dim / 2
  const inner = compact ? 24 : 32
  const outer = compact ? 38 : 48
  return (
    <div className={`ops-gauge-wrap ${compact ? 'ops-gauge-wrap--compact' : ''}`}>
      <RadialBarChart
        width={dim}
        height={dim}
        cx={c}
        cy={c}
        innerRadius={inner}
        outerRadius={outer}
        data={data}
        startAngle={90}
        endAngle={-270}
      >
        <RadialBar dataKey="value" cornerRadius={6} background={{ fill: '#1e293b' }} />
      </RadialBarChart>
      <span className={`ops-gauge-center ${compact ? 'ops-gauge-center--compact' : ''}`}>{minutes.toFixed(1)}</span>
    </div>
  )
}

const PERIOD_OPTIONS: { id: AnalyticsPeriod; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
]

const REFRESH_MS = 15_000

export function AnalyticsPage({ token, onError }: { token: string; onError: (msg: string | null) => void }) {
  const [period, setPeriod] = useState<AnalyticsPeriod>('7d')
  const [data, setData] = useState<AdminAnalytics | null>(null)
  const [liveMap, setLiveMap] = useState<LiveMapOut | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [highlightVehicleId, setHighlightVehicleId] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([
        fetchJson<AdminAnalytics>(`/admin/analytics?period=${encodeURIComponent(period)}`, token),
        fetchJson<LiveMapOut>('/admin/live-map', token),
      ])
      setData(a)
      setLiveMap(m)
      setLastUpdated(new Date())
      onError(null)
    } catch (e: unknown) {
      if (isSessionExpiredError(e)) return
      onError(e instanceof Error ? e.message : 'Failed to load operations data')
    }
  }, [token, onError, period])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    const t = setInterval(() => void loadAll(), REFRESH_MS)
    return () => clearInterval(t)
  }, [loadAll])

  const incidents = data?.incidents ?? []
  const prevIncidents = data?.incidents_previous ?? []
  const hasPrev = prevIncidents.length > 0

  const metrics = useMemo(() => {
    const curN = incidents.length
    const prevN = prevIncidents.length
    const deltaTotal = curN - prevN

    const sceneVals = incidents.map((i) => i.time_to_scene_minutes).filter((x): x is number => x != null)
    const avgResp = mean(sceneVals)

    const prevRespVals = prevIncidents.map((i) => i.time_to_scene_minutes).filter((x): x is number => x != null)
    const avgPrevResp = mean(prevRespVals)

    const resPct = resolutionRatePct(incidents)
    const resPrevPct = resolutionRatePct(prevIncidents)

    const hoaxPct = hoaxRatePct(incidents)
    const hoaxPrevPct = hoaxRatePct(prevIncidents)

    return {
      deltaTotal,
      avgResp,
      avgPrevResp,
      resPct,
      resPrevPct,
      hoaxPct,
      hoaxPrevPct,
      prevN,
      curN,
    }
  }, [incidents, prevIncidents, hasPrev])

  const typeChartData = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of incidents) {
      const b = bucketIncidentType(i.incident_type)
      m.set(b, (m.get(b) ?? 0) + 1)
    }
    const order = [...TYPE_KEYS, 'other']
    const rows = order
      .map((k) => ({ key: k, name: TYPE_LABEL[k] ?? k, value: m.get(k) ?? 0 }))
      .filter((r) => r.value > 0)
    const sum = rows.reduce((a, r) => a + r.value, 0)
    return rows.map((r) => ({
      ...r,
      pct: sum ? Math.round((1000 * r.value) / sum) / 10 : 0,
    }))
  }, [incidents])

  const hourData = useMemo(() => {
    const counts = Array.from({ length: 24 }, () => 0)
    for (const i of incidents) {
      const h = new Date(i.created_at).getHours()
      counts[h] += 1
    }
    const ranked = counts.map((c, h) => ({ h, c })).sort((a, b) => b.c - a.c || a.h - b.h)
    const topHours = new Set(ranked.slice(0, 3).filter((x) => x.c > 0).map((x) => x.h))
    return counts.map((c, hour) => ({
      hour: `${String(hour).padStart(2, '0')}:00`,
      hourNum: hour,
      count: c,
      top: topHours.has(hour) && c > 0,
    }))
  }, [incidents])

  const peakLabel = useMemo(() => formatPeakLabel(hourData.map((d) => d.count)), [hourData])

  const responseTrendData = useMemo(() => {
    const withResp = incidents
      .filter((i) => i.time_to_scene_minutes != null)
      .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
      .slice(0, 10)
      .reverse()
      .map((i, idx) => ({
        n: idx + 1,
        minutes: i.time_to_scene_minutes as number,
        label: `#${idx + 1}`,
      }))
    return withResp
  }, [incidents])

  const stretchData = useMemo(() => {
    const counts = new Map<number, number>()
    for (const i of incidents) {
      if (i.km_marker == null) continue
      const seg = Math.floor(i.km_marker / 20) * 20
      counts.set(seg, (counts.get(seg) ?? 0) + 1)
    }
    const rows: { seg: number; count: number; label: string; fill: string }[] = []
    for (let s = 0; s < NH48_KM_LENGTH; s += 20) {
      const end = Math.min(s + 20, NH48_KM_LENGTH)
      const cnt = counts.get(s) ?? 0
      const mid = s + (end - s) / 2
      const town = nearestTownForSegmentMid(mid)
      rows.push({
        seg: s,
        count: cnt,
        label: `KM ${s}–${end} · ${town}`,
        fill: stretchBarColor(cnt),
      })
    }
    return [...rows].sort((a, b) => b.count - a.count || a.seg - b.seg)
  }, [incidents])

  const vehicleRowsSorted = useMemo(() => {
    const rows = [...(data?.vehicle_performance ?? [])]
    rows.sort((a, b) => {
      const av = a.avg_response_minutes
      const bv = b.avg_response_minutes
      if (av == null && bv == null) return a.label.localeCompare(b.label)
      if (av == null) return 1
      if (bv == null) return -1
      return av - bv
    })
    const withAvg = rows.filter((r) => r.avg_response_minutes != null).map((r) => r.avg_response_minutes as number)
    const fastest = withAvg.length ? Math.min(...withAvg) : null
    const slowest = withAvg.length ? Math.max(...withAvg) : null
    return { rows, fastest, slowest }
  }, [data?.vehicle_performance])

  const fmtUpdated = lastUpdated
    ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(lastUpdated)
    : '—'

  const totalTrendText = () => {
    if (!hasPrev) return '—'
    const d = metrics.deltaTotal
    if (d === 0) return `No change vs ${data?.comparison_label ?? 'prior period'}`
    if (d > 0) return `${Ic.up} ${d} vs ${data?.comparison_label ?? 'prior period'}`
    return `${Ic.down} ${Math.abs(d)} vs ${data?.comparison_label ?? 'prior period'}`
  }

  const totalTrendClass = () => {
    if (!hasPrev) return 'ops-kpi-sub--muted'
    if (metrics.deltaTotal === 0) return 'ops-kpi-sub--neutral'
    return metrics.deltaTotal > 0 ? 'ops-kpi-sub--bad' : 'ops-kpi-sub--good'
  }

  const resDonut = useMemo(() => {
    const pct = metrics.resPct
    if (pct == null) return []
    return [
      { name: 'Cleared', value: pct, fill: '#4ade80' },
      { name: 'Other', value: Math.max(0, 100 - pct), fill: '#334155' },
    ]
  }, [metrics.resPct])

  const exportPdf = () => window.print()

  return (
    <div className="ops-dashboard analytics-page--dark" id="ops-dashboard-print">
      <header className="ops-topbar">
        <div className="ops-topbar-left">
          <h2 className="ops-title">REACH Operations — Live</h2>
          <p className="ops-live-line">
            <span className="ops-pulse-dot" aria-hidden />
            Live — updates every 15s
          </p>
        </div>
        <div className="ops-topbar-mid">
          <div className="ops-period-toggle" role="tablist" aria-label="Time period">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={period === opt.id}
                className={period === opt.id ? 'ops-period-btn ops-period-btn--active' : 'ops-period-btn'}
                onClick={() => setPeriod(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="ops-updated">Last updated: {fmtUpdated}</p>
        </div>
        <div className="ops-topbar-right">
          <button type="button" className="ops-btn-pdf" onClick={exportPdf}>
            Export PDF
          </button>
        </div>
      </header>

      {!data ? (
        <p className="ops-loading">Loading operations dashboard…</p>
      ) : (
        <>
          <section className="ops-kpi-row">
            <article className="ops-kpi-card">
              <div className="ops-kpi-head">
                <span className="ops-kpi-ico" aria-hidden>{Ic.alert}</span>
                <span className="ops-kpi-name">Total Incidents</span>
              </div>
              <div className="ops-kpi-body">
                <div className="ops-kpi-num">{metrics.curN}</div>
                <div className={`ops-kpi-sub ${totalTrendClass()}`}>{totalTrendText()}</div>
              </div>
            </article>

            <article className="ops-kpi-card">
              <div className="ops-kpi-head">
                <span className="ops-kpi-ico" aria-hidden>{Ic.clock}</span>
                <span className="ops-kpi-name">Avg time to scene</span>
              </div>
              <div className="ops-kpi-body">
                <div className="ops-kpi-gauge-row">
                  <GaugeAvgResponse minutes={metrics.avgResp} compact />
                  <div className="ops-kpi-gauge-meta">
                    <div className="ops-kpi-num ops-kpi-num--sm">{metrics.avgResp != null ? `${metrics.avgResp.toFixed(1)} min` : '—'}</div>
                    <div className="ops-kpi-sub ops-kpi-sub--muted">
                      {!hasPrev || metrics.avgResp == null || metrics.avgPrevResp == null
                        ? '—'
                        : metrics.avgResp < metrics.avgPrevResp
                          ? `${Ic.down} vs ${data.comparison_label}`
                          : metrics.avgResp > metrics.avgPrevResp
                            ? `${Ic.up} vs ${data.comparison_label}`
                            : `Flat vs ${data.comparison_label}`}
                    </div>
                  </div>
                </div>
              </div>
            </article>

            <article className="ops-kpi-card">
              <div className="ops-kpi-head">
                <span className="ops-kpi-ico" aria-hidden>{Ic.tick}</span>
                <span className="ops-kpi-name">Resolution Rate</span>
              </div>
              <div className="ops-kpi-body">
                <div className="ops-kpi-resolution">
                  {metrics.resPct != null && resDonut.length > 0 ? (
                    <div className="ops-mini-donut">
                      <PieChart width={60} height={60}>
                        <Pie
                          data={resDonut}
                          dataKey="value"
                          cx={30}
                          cy={30}
                          innerRadius={14}
                          outerRadius={26}
                          paddingAngle={2}
                          stroke="none"
                        >
                          {resDonut.map((_, i) => (
                            <Cell key={i} fill={resDonut[i].fill} />
                          ))}
                        </Pie>
                      </PieChart>
                    </div>
                  ) : null}
                  <div className="ops-kpi-resolution-pct">{metrics.resPct != null ? `${metrics.resPct.toFixed(1)}%` : '—'}</div>
                  <div className="ops-kpi-sub ops-kpi-sub--muted ops-kpi-resolution-trend">
                    {!hasPrev || metrics.resPct == null || metrics.resPrevPct == null
                      ? '—'
                      : metrics.resPct > metrics.resPrevPct
                        ? `${Ic.up} vs ${data.comparison_label}`
                        : metrics.resPct < metrics.resPrevPct
                          ? `${Ic.down} vs ${data.comparison_label}`
                          : `Flat vs ${data.comparison_label}`}
                  </div>
                </div>
              </div>
            </article>

            <article className="ops-kpi-card">
              <div className="ops-kpi-head">
                <span className="ops-kpi-ico" aria-hidden>{Ic.masks}</span>
                <span className="ops-kpi-name">Hoax Rate</span>
                {metrics.hoaxPct != null && metrics.hoaxPct > 10 ? (
                  <span className="ops-warn-ico" title="Above 10%">{Ic.warn}</span>
                ) : null}
              </div>
              <div className="ops-kpi-body">
                <div className="ops-kpi-num">{metrics.hoaxPct != null ? `${metrics.hoaxPct.toFixed(1)}%` : '—'}</div>
                <div className="ops-kpi-sub ops-kpi-sub--muted">
                  {!hasPrev || metrics.hoaxPct == null || metrics.hoaxPrevPct == null
                    ? '—'
                    : metrics.hoaxPct < metrics.hoaxPrevPct
                      ? `${Ic.down} vs ${data.comparison_label} (good)`
                      : metrics.hoaxPct > metrics.hoaxPrevPct
                        ? `${Ic.up} vs ${data.comparison_label}`
                        : `Flat vs ${data.comparison_label}`}
                </div>
              </div>
            </article>

            <article className="ops-kpi-card">
              <div className="ops-kpi-head">
                <span className="ops-kpi-ico" aria-hidden>{Ic.ambulance}</span>
                <span className="ops-kpi-name">Fleet Status</span>
              </div>
              <div className="ops-kpi-body">
                <div className="ops-fleet-stack">
                  <div className="ops-fleet-row">
                    <span className="ops-fleet-dot ops-fleet-dot--avail" aria-hidden />
                    <span>
                      {data.fleet.available} available
                    </span>
                  </div>
                  <div className="ops-fleet-row">
                    <span className="ops-fleet-dot ops-fleet-dot--disp" aria-hidden />
                    <span>
                      {data.fleet.dispatched} dispatched
                    </span>
                  </div>
                  <div className="ops-fleet-row">
                    <span className="ops-fleet-dot ops-fleet-dot--off" aria-hidden />
                    <span>
                      {data.fleet.offline} offline
                    </span>
                  </div>
                </div>
              </div>
            </article>

            <article className="ops-kpi-card">
              <div className="ops-kpi-head">
                <span className="ops-kpi-ico" aria-hidden>{Ic.pin}</span>
                <span className="ops-kpi-name">Coverage</span>
              </div>
              <div className="ops-kpi-body">
                <div className="ops-kpi-coverage-lines">
                  <div className="ops-kpi-coverage-line1">
                    {data.coverage.active_corridors}{' '}
                    {data.coverage.active_corridors === 1 ? 'active corridor' : 'active corridors'}
                  </div>
                  <div className="ops-kpi-coverage-line2">{data.coverage.km_monitored.toFixed(0)} km monitored</div>
                </div>
              </div>
            </article>
          </section>

          <section className="ops-panel ops-panel--map">
            <div className="ops-panel-head">
              <h3>Live corridor map</h3>
              <p className="muted small">NH48 overview · incidents (warm) · ambulances (cool)</p>
            </div>
            <OpsLiveMap liveMap={liveMap} highlightVehicleId={highlightVehicleId} />
          </section>

          <div className="ops-chart-grid">
            <section className="ops-panel">
              <h3>Incidents by Type</h3>
              {typeChartData.length === 0 ? (
                <p className="ops-placeholder">Not enough data yet</p>
              ) : (
                <div className="ops-chart-tall">
                  <ResponsiveContainer width="100%" height={320}>
                    <PieChart>
                      <Pie
                        data={typeChartData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={110}
                        label={(p) => {
                          const row = p as unknown as { name?: string; value?: number; pct?: number }
                          return `${row.name ?? ''}: ${row.value ?? 0} (${row.pct ?? 0}%)`
                        }}
                      >
                        {typeChartData.map((_, i) => (
                          <Cell key={i} fill={TYPE_COLORS[i % TYPE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            <section className="ops-panel">
              <h3>Incidents by Hour of Day</h3>
              {incidents.length === 0 ? (
                <p className="ops-placeholder">Not enough data yet</p>
              ) : (
                <>
                  {peakLabel ? <p className="ops-peak-label">{peakLabel}</p> : null}
                  <div className="ops-chart-tall">
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={hourData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="hour" tick={{ fill: '#94a3b8', fontSize: 10 }} interval={2} />
                        <YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                        <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
                        <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                          {hourData.map((e, i) => (
                            <Cell key={i} fill={e.top ? '#ef4444' : '#38bdf8'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </section>
          </div>

          <div className="ops-chart-grid">
            <section className="ops-panel">
              <h3>Time to scene (recent incidents)</h3>
              {responseTrendData.length < 2 ? (
                <p className="ops-placeholder">Not enough data yet</p>
              ) : (
                <div className="ops-chart-tall">
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={responseTrendData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="n" tick={{ fill: '#94a3b8' }} label={{ value: 'Last incidents (chronological)', position: 'insideBottom', offset: -4, fill: '#64748b' }} />
                      <YAxis tick={{ fill: '#94a3b8' }} label={{ value: 'Minutes', angle: -90, position: 'insideLeft', fill: '#64748b' }} />
                      <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
                      <ReferenceArea
                        y1={0}
                        y2={8}
                        fill="#22c55e"
                        fillOpacity={0.12}
                        ifOverflow="extendDomain"
                      />
                      <ReferenceArea y1={8} y2={Math.max(8, ...responseTrendData.map((d) => d.minutes)) + 2} fill="#ef4444" fillOpacity={0.08} ifOverflow="extendDomain" />
                      <ReferenceLine y={8} stroke="#ef4444" strokeDasharray="4 4" label={{ value: '8 min target', fill: '#f87171', fontSize: 11 }} />
                      <Line type="monotone" dataKey="minutes" stroke="#38bdf8" strokeWidth={2} dot={{ r: 4, fill: '#38bdf8' }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            <section className="ops-panel">
              <h3>Dangerous Stretches</h3>
              {!incidents.some((i) => i.km_marker != null) ? (
                <p className="ops-placeholder">Not enough data yet</p>
              ) : (
                <div className="ops-chart-tall">
                  <ResponsiveContainer width="100%" height={360}>
                    <BarChart layout="vertical" data={stretchData} margin={{ left: 8, right: 24, top: 8, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                      <XAxis type="number" allowDecimals={false} tick={{ fill: '#94a3b8' }} />
                      <YAxis type="category" dataKey="label" width={200} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }} />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                        {stretchData.map((e, i) => (
                          <Cell key={i} fill={e.fill} />
                        ))}
                        <LabelList dataKey="count" position="right" fill="#e2e8f0" fontSize={11} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>
          </div>

          <section className="ops-panel ops-panel--table">
            <h3>Vehicle &amp; driver performance</h3>
            <p className="muted small">Sorted by average response (fastest first). Click a row to focus on the map.</p>
            <div className="table-wrap">
              <table className="ops-perf-table">
                <thead>
                  <tr>
                    <th>Ambulance</th>
                    <th>Driver</th>
                    <th>Dispatches</th>
                    <th>Avg response</th>
                    <th>Best response</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {vehicleRowsSorted.rows.map((r) => {
                    const isFast =
                      r.avg_response_minutes != null &&
                      vehicleRowsSorted.fastest != null &&
                      r.avg_response_minutes === vehicleRowsSorted.fastest &&
                      r.dispatch_count > 0
                    const isSlow =
                      r.avg_response_minutes != null &&
                      vehicleRowsSorted.slowest != null &&
                      r.avg_response_minutes === vehicleRowsSorted.slowest &&
                      r.dispatch_count > 0 &&
                      vehicleRowsSorted.rows.filter((x) => x.dispatch_count > 0).length > 1
                    return (
                      <tr
                        key={r.vehicle_id}
                        className={`${isFast ? 'ops-perf-row--fast' : ''} ${isSlow ? 'ops-perf-row--slow' : ''} ${highlightVehicleId === r.vehicle_id ? 'ops-perf-row--hi' : ''}`}
                        onClick={() => setHighlightVehicleId(r.vehicle_id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setHighlightVehicleId(r.vehicle_id)
                          }
                        }}
                        tabIndex={0}
                        role="button"
                      >
                        <td>{r.label}</td>
                        <td>{r.driver_name ?? '—'}</td>
                        <td>{r.dispatch_count}</td>
                        <td>{r.avg_response_minutes != null ? `${r.avg_response_minutes.toFixed(1)} min` : '—'}</td>
                        <td>{r.best_response_minutes != null ? `${r.best_response_minutes.toFixed(1)} min` : '—'}</td>
                        <td>
                          {r.on_scene_now ? (
                            <span className="ops-onscene-badge">
                              On scene now <span aria-hidden>{Ic.liveDot}</span>
                            </span>
                          ) : (
                            r.status
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {vehicleRowsSorted.rows.length === 0 ? <p className="muted">No vehicles in fleet.</p> : null}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

export type SpeedZoneRow = {
  id: string
  corridor_id: string
  start_km: number
  end_km: number
  speed_limit_kph: number
  created_at: string
}

type CorridorRow = { id: string; name: string }

export function BroadcastPage({
  token,
  onError,
}: {
  token: string
  onError: (msg: string | null) => void
}) {
  const [msg, setMsg] = useState('')
  const [priority, setPriority] = useState<'urgent' | 'info' | ''>('')
  const [sending, setSending] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!msg.trim()) return
    setSending(true)
    onError(null)
    try {
      await postJson('/admin/broadcast', token, {
        message: msg.trim(),
        priority: priority === '' ? null : priority,
      })
      setMsg('')
    } catch (err: unknown) {
      if (isSessionExpiredError(err)) return
      onError(err instanceof Error ? err.message : 'Broadcast failed')
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="broadcast-page">
      <h2>Broadcast</h2>
      <p className="muted intro">
        Send a message to all connected driver apps (Socket.IO). Drivers get a dispatch notification panel with sender and time;
        optional priority ({Ic.urgentLbl} Urgent / {Ic.infoLbl} Info).
      </p>
      <form className="form-panel broadcast-form" onSubmit={(e) => void submit(e)}>
        <label>
          Message
          <textarea
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            rows={4}
            placeholder="Type announcement for all drivers…"
            required
          />
        </label>
        <label>
          Priority (optional)
          <select value={priority} onChange={(e) => setPriority(e.target.value as 'urgent' | 'info' | '')}>
            <option value="">None</option>
            <option value="urgent">{Ic.urgentLbl} Urgent</option>
            <option value="info">{Ic.infoLbl} Info</option>
          </select>
        </label>
        <button type="submit" disabled={sending || !msg.trim()}>
          {sending ? 'Sending…' : 'Send to All Drivers'}
        </button>
      </form>
    </div>
  )
}

export function SpeedZonesPage({
  token,
  corridors,
  onError,
}: {
  token: string
  corridors: CorridorRow[]
  onError: (msg: string | null) => void
}) {
  const [zones, setZones] = useState<SpeedZoneRow[]>([])
  const [loading, setLoading] = useState(true)
  const [cid, setCid] = useState('')
  const [startKm, setStartKm] = useState('0')
  const [endKm, setEndKm] = useState('20')
  const [limitKph, setLimitKph] = useState('100')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [editLimit, setEditLimit] = useState('')

  const load = useCallback(async () => {
    onError(null)
    setLoading(true)
    try {
      setZones(await fetchJson<SpeedZoneRow[]>('/admin/speed-zones', token))
    } catch (e: unknown) {
      if (isSessionExpiredError(e)) return
      onError(e instanceof Error ? e.message : 'Failed to load zones')
    } finally {
      setLoading(false)
    }
  }, [token, onError])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!cid && corridors[0]?.id) setCid(corridors[0].id)
  }, [corridors, cid])

  const addZone = async (e: FormEvent) => {
    e.preventDefault()
    if (!cid) return
    onError(null)
    try {
      await postJson('/admin/speed-zones', token, {
        corridor_id: cid,
        start_km: Number(startKm),
        end_km: Number(endKm),
        speed_limit_kph: Number(limitKph) || 100,
      })
      await load()
    } catch (err: unknown) {
      if (isSessionExpiredError(err)) return
      onError(err instanceof Error ? err.message : 'Failed to add zone')
    }
  }

  const saveEdit = async (id: string) => {
    onError(null)
    try {
      await patchJson(`/admin/speed-zones/${id}`, token, {
        start_km: editStart === '' ? undefined : Number(editStart),
        end_km: editEnd === '' ? undefined : Number(editEnd),
        speed_limit_kph: editLimit === '' ? undefined : Number(editLimit),
      })
      setEditingId(null)
      await load()
    } catch (err: unknown) {
      if (isSessionExpiredError(err)) return
      onError(err instanceof Error ? err.message : 'Failed to update')
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this speed zone?')) return
    onError(null)
    try {
      await deleteJson(`/admin/speed-zones/${id}`, token)
      await load()
    } catch (err: unknown) {
      if (isSessionExpiredError(err)) return
      onError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  return (
    <div className="speed-zones-page">
      <h2>Speed zones</h2>
      <p className="muted intro">Corridor segments with speed limits (default 100 km/h). Stored in the database.</p>
      <form className="form-panel" onSubmit={(e) => void addZone(e)}>
        <h3>Add zone</h3>
        <div className="form-row">
          <label>
            Corridor
            <select value={cid} onChange={(e) => setCid(e.target.value)} required>
              {corridors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row grid-3">
          <label>
            Start KM
            <input type="number" step="0.1" value={startKm} onChange={(e) => setStartKm(e.target.value)} required />
          </label>
          <label>
            End KM
            <input type="number" step="0.1" value={endKm} onChange={(e) => setEndKm(e.target.value)} required />
          </label>
          <label>
            Limit (km/h)
            <input type="number" value={limitKph} onChange={(e) => setLimitKph(e.target.value)} min={1} max={200} />
          </label>
        </div>
        <button type="submit">Add zone</button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Corridor</th>
                <th>Start KM</th>
                <th>End KM</th>
                <th>Limit km/h</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {zones.map((z) => {
                const cname = corridors.find((c) => c.id === z.corridor_id)?.name ?? z.corridor_id.slice(0, 8)
                const isEd = editingId === z.id
                return (
                  <tr key={z.id}>
                    <td>{cname}</td>
                    <td>
                      {isEd ? (
                        <input value={editStart} onChange={(e) => setEditStart(e.target.value)} type="number" step="0.1" />
                      ) : (
                        z.start_km
                      )}
                    </td>
                    <td>
                      {isEd ? (
                        <input value={editEnd} onChange={(e) => setEditEnd(e.target.value)} type="number" step="0.1" />
                      ) : (
                        z.end_km
                      )}
                    </td>
                    <td>
                      {isEd ? (
                        <input value={editLimit} onChange={(e) => setEditLimit(e.target.value)} type="number" min={1} max={200} />
                      ) : (
                        z.speed_limit_kph
                      )}
                    </td>
                    <td className="cell-actions">
                      {isEd ? (
                        <>
                          <button type="button" onClick={() => void saveEdit(z.id)}>
                            Save
                          </button>
                          <button type="button" onClick={() => setEditingId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(z.id)
                              setEditStart(String(z.start_km))
                              setEditEnd(String(z.end_km))
                              setEditLimit(String(z.speed_limit_kph))
                            }}
                          >
                            Edit
                          </button>
                          <button type="button" className="btn-danger" onClick={() => void remove(z.id)}>
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
