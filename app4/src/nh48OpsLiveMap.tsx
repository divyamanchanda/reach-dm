import { useEffect, useRef } from 'react'
import L from 'leaflet'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import 'leaflet/dist/leaflet.css'
import {
  locationStackKey,
  nh48LeafletLatLngs,
  resolveIncidentMapPosition,
  resolveVehicleMapPosition,
  stackOffsetLayerPixels,
} from './nh48Route'

const DefaultIcon = L.icon({
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
})
L.Marker.prototype.options.icon = DefaultIcon

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
 * Shared NH48 Leaflet map: blue road polyline, snapped incidents, snapped/km ambulances, 10px stack offset when overlapping.
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
    const groups = new Map<string, Prepared[]>()
    for (const p of prepared) {
      const k = locationStackKey(p.ll.lat, p.ll.lng)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(p)
    }

    const offsetLatLngForStack = (ll: L.LatLng, idx: number, n: number) => {
      const { dx, dy } = stackOffsetLayerPixels(idx, n)
      const pt = map.latLngToLayerPoint(ll)
      return map.layerPointToLatLng(L.point(pt.x + dx, pt.y + dy))
    }

    for (const arr of groups.values()) {
      arr.forEach((p, idx) => {
        const at = offsetLatLngForStack(p.ll, idx, arr.length)
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
            `<div class="ops-popup"><strong>${inc.incident_type.replace(/_/g, ' ')}</strong><br/>` +
              `${inc.severity} · ${inc.status}<br/>` +
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
            `<div class="ops-popup"><strong>${v.label}</strong><br/>` +
              `${v.status}${v.driver_name ? `<br/>Driver: ${v.driver_name}` : ''}` +
              `${v.assigned_incident_type ? `<br/>Assignment: ${v.assigned_incident_type}` : ''}</div>`,
          )
          mk.addTo(layer)
          vehMarkersRef.current.set(v.id, mk)
        }
      })
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
