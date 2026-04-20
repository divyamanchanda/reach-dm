import { useEffect, useRef } from 'react'
import L from 'leaflet'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import 'leaflet/dist/leaflet.css'
import { nh48LeafletLatLngs, resolveIncidentMapPosition, resolveVehicleMapPosition } from './nh48Route'

const DefaultIcon = L.icon({
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
})
L.Marker.prototype.options.icon = DefaultIcon

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function ufFind(parent: number[], i: number): number {
  if (parent[i] !== i) parent[i] = ufFind(parent, parent[i])
  return parent[i]
}

function ufUnion(parent: number[], i: number, j: number): void {
  const ri = ufFind(parent, i)
  const rj = ufFind(parent, j)
  if (ri !== rj) parent[rj] = ri
}

export type Nh48LiveMapIncident = {
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

export type Nh48LiveMapVehicle = {
  id: string
  label: string
  status: string
  km_marker: number | null
  latitude: number | null
  longitude: number | null
  assigned_incident_type?: string | null
  driver_name?: string | null
}

export type Nh48LiveMapData = {
  corridors: {
    id: string
    name: string
    incidents: Nh48LiveMapIncident[]
    vehicles: Nh48LiveMapVehicle[]
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

/**
 * Shared NH48 Leaflet map: blue road polyline, snapped incidents/vehicles;
 * markers within 5px cluster — pairs offset horizontally; 3+ shown as count badge.
 */
export function Nh48OpsLiveMap({
  liveMap,
  highlightVehicleId,
  footnote,
}: {
  liveMap: Nh48LiveMapData | null
  highlightVehicleId?: string | null
  footnote?: string
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
    const poly = L.polyline(nh48LeafletLatLngs(), {
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

    type Prepared =
      | { kind: 'inc'; inc: Nh48LiveMapIncident; ll: L.LatLng }
      | { kind: 'veh'; v: Nh48LiveMapVehicle; ll: L.LatLng }
    const prepared: Prepared[] = []
    for (const c of liveMap.corridors) {
      for (const inc of c.incidents) {
        const pos = resolveIncidentMapPosition(inc)
        if (!pos) continue
        prepared.push({ kind: 'inc', inc, ll: L.latLng(pos.lat, pos.lng) })
      }
      for (const v of c.vehicles) {
        const pos = resolveVehicleMapPosition(v)
        if (!pos) continue
        prepared.push({ kind: 'veh', v, ll: L.latLng(pos.lat, pos.lng) })
      }
    }

    const n = prepared.length
    const pts = prepared.map((p) => map.latLngToLayerPoint(p.ll))
    const parent = Array.from({ length: n }, (_, i) => i)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (pts[i].distanceTo(pts[j]) <= 5) ufUnion(parent, i, j)
      }
    }
    const byRoot = new Map<number, number[]>()
    for (let i = 0; i < n; i++) {
      const r = ufFind(parent, i)
      if (!byRoot.has(r)) byRoot.set(r, [])
      byRoot.get(r)!.push(i)
    }
    const clusters = [...byRoot.values()]

    const sortKeyForIndex = (idx: number): string => {
      const p = prepared[idx]
      if (p.kind === 'inc') return `0-${p.inc.id}`
      return `1-${p.v.id}`
    }

    for (const idxs of clusters) {
      if (idxs.length >= 3) {
        let sx = 0
        let sy = 0
        for (const i of idxs) {
          sx += pts[i].x
          sy += pts[i].y
        }
        const at = map.layerPointToLatLng(L.point(sx / idxs.length, sy / idxs.length))
        const lines = idxs
          .map((i) => prepared[i])
          .map((p) => {
            if (p.kind === 'inc') {
              const inc = p.inc
              return `<strong>${escHtml(inc.incident_type.replace(/_/g, ' '))}</strong> · ${escHtml(inc.severity)} · ${escHtml(inc.status)} · KM ${inc.km_marker != null ? inc.km_marker : '—'}`
            }
            const v = p.v
            return `<strong>${escHtml(v.label)}</strong> · ${escHtml(v.status)}${v.driver_name ? ` · ${escHtml(v.driver_name)}` : ''}`
          })
          .join('<br/><br/>')
        const icon = L.divIcon({
          className: 'ops-leaflet-divicon',
          html: `<span class="ops-map-cluster-badge">${idxs.length}</span>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        })
        const mk = L.marker(at, { icon })
        mk.bindPopup(`<div class="ops-popup">${lines}</div>`)
        mk.addTo(layer)
        for (const i of idxs) {
          const p = prepared[i]
          if (p.kind === 'veh') vehMarkersRef.current.set(p.v.id, mk)
        }
        continue
      }

      if (idxs.length === 2) {
        const sorted = [...idxs].sort((a, b) => sortKeyForIndex(a).localeCompare(sortKeyForIndex(b)))
        sorted.forEach((pi, k) => {
          const p = prepared[pi]
          const base = pts[pi]
          const dx = k === 0 ? 0 : 15
          const at = map.layerPointToLatLng(L.point(base.x + dx, base.y))
          if (p.kind === 'inc') {
            const inc = p.inc
            const icon = L.divIcon({
              className: 'ops-leaflet-divicon',
              html: incidentMarkerHtml(inc.severity),
              iconSize: [20, 20],
              iconAnchor: [10, 10],
            })
            const m = L.marker(at, { icon })
            m.bindPopup(
              `<div class="ops-popup"><strong>${escHtml(inc.incident_type.replace(/_/g, ' '))}</strong><br/>` +
                `${escHtml(inc.severity)} · ${escHtml(inc.status)}<br/>` +
                `KM: ${inc.km_marker != null ? inc.km_marker : '—'}<br/>` +
                `${new Date(inc.created_at).toLocaleString()}</div>`,
            )
            m.addTo(layer)
          } else {
            const v = p.v
            const col = vehicleStatusColor(v.status)
            const icon = L.divIcon({
              className: 'ops-leaflet-divicon',
              html: vehicleMarkerHtml(col),
              iconSize: [18, 18],
              iconAnchor: [9, 9],
            })
            const mk = L.marker(at, { icon })
            mk.bindPopup(
              `<div class="ops-popup"><strong>${escHtml(v.label)}</strong><br/>` +
                `${escHtml(v.status)}${v.driver_name ? `<br/>Driver: ${escHtml(v.driver_name)}` : ''}` +
                `${v.assigned_incident_type ? `<br/>Assignment: ${escHtml(v.assigned_incident_type)}` : ''}</div>`,
            )
            mk.addTo(layer)
            vehMarkersRef.current.set(v.id, mk)
          }
        })
        continue
      }

      const i = idxs[0]
      const p = prepared[i]
      const at = p.ll
      if (p.kind === 'inc') {
        const inc = p.inc
        const icon = L.divIcon({
          className: 'ops-leaflet-divicon',
          html: incidentMarkerHtml(inc.severity),
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        })
        const m = L.marker(at, { icon })
        m.bindPopup(
          `<div class="ops-popup"><strong>${escHtml(inc.incident_type.replace(/_/g, ' '))}</strong><br/>` +
            `${escHtml(inc.severity)} · ${escHtml(inc.status)}<br/>` +
            `KM: ${inc.km_marker != null ? inc.km_marker : '—'}<br/>` +
            `${new Date(inc.created_at).toLocaleString()}</div>`,
        )
        m.addTo(layer)
      } else {
        const v = p.v
        const col = vehicleStatusColor(v.status)
        const icon = L.divIcon({
          className: 'ops-leaflet-divicon',
          html: vehicleMarkerHtml(col),
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        })
        const mk = L.marker(at, { icon })
        mk.bindPopup(
          `<div class="ops-popup"><strong>${escHtml(v.label)}</strong><br/>` +
            `${escHtml(v.status)}${v.driver_name ? `<br/>Driver: ${escHtml(v.driver_name)}` : ''}` +
            `${v.assigned_incident_type ? `<br/>Assignment: ${escHtml(v.assigned_incident_type)}` : ''}</div>`,
        )
        mk.addTo(layer)
        vehMarkersRef.current.set(v.id, mk)
      }
    }

    const hid = highlightVehicleId ?? null
    if (hid) {
      const mk = vehMarkersRef.current.get(hid)
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
      <p className="ops-map-footnote">
        {footnote ??
          'NH48 road path · GPS snapped to polyline · KM interpolated along 312 km · stacked markers when overlapping'}
      </p>
    </div>
  )
}
