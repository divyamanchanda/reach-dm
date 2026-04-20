/**
 * NH48 Bengaluru → Chennai reference polyline (road-following path, not a straight chord).
 * KM scale 0–312 is mapped proportionally to cumulative geodesic length along this path.
 */

export const NH48_KM_LENGTH = 312

export const NH48_WAYPOINTS: ReadonlyArray<{ lat: number; lng: number }> = [
  { lat: 12.9716, lng: 77.5946 }, // Bengaluru
  { lat: 12.8458, lng: 77.6692 }, // Electronic City
  { lat: 12.7409, lng: 77.8253 }, // Hosur
  { lat: 12.5266, lng: 78.2137 }, // Krishnagiri
  { lat: 12.7833, lng: 78.7167 }, // Ambur
  { lat: 12.9165, lng: 79.1325 }, // Vellore
  { lat: 12.9224, lng: 79.3327 }, // Ranipet
  { lat: 12.9674, lng: 79.9475 }, // Sriperumbudur
  { lat: 13.0827, lng: 80.2707 }, // Chennai
]

export const NH48_CITY_LABELS = [
  'Bengaluru',
  'Electronic City',
  'Hosur',
  'Krishnagiri',
  'Ambur',
  'Vellore',
  'Ranipet',
  'Sriperumbudur',
  'Chennai',
] as const

export type LatLng = { lat: number; lng: number }

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}

/** Cumulative distance [km] from first waypoint along the polyline (same length as route). */
export function cumulativeDistancesKm(route: readonly LatLng[]): number[] {
  const acc: number[] = [0]
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]
    const b = route[i]
    acc.push(acc[i - 1] + haversineKm(a.lat, a.lng, b.lat, b.lng))
  }
  return acc
}

let _cumCache: number[] | null = null
function nh48Cum(): number[] {
  if (!_cumCache) _cumCache = cumulativeDistancesKm(NH48_WAYPOINTS)
  return _cumCache
}

/** Total geodesic length of NH48 polyline (km). */
export function nh48TotalRouteKm(): number {
  const c = nh48Cum()
  return c[c.length - 1]
}

/** Interpolate position at distance `d` km from start along `route` (uses `cum` from cumulativeDistancesKm). */
export function positionAtDistanceKm(route: readonly LatLng[], cum: readonly number[], d: number): LatLng {
  if (route.length === 0) throw new Error('empty route')
  if (route.length === 1) return { ...route[0] }
  const maxD = cum[cum.length - 1]
  if (d <= 0) return { ...route[0] }
  if (d >= maxD) return { ...route[route.length - 1] }
  for (let i = 0; i < route.length - 1; i++) {
    if (d <= cum[i + 1] + 1e-9) {
      const segStart = cum[i]
      const segLen = cum[i + 1] - segStart
      const t = segLen > 1e-12 ? (d - segStart) / segLen : 0
      const u = Math.max(0, Math.min(1, t))
      const a = route[i]
      const b = route[i + 1]
      return {
        lat: a.lat + (b.lat - a.lat) * u,
        lng: a.lng + (b.lng - a.lng) * u,
      }
    }
  }
  return { ...route[route.length - 1] }
}

/**
 * Map official NH km (0–312) to a point on the polyline: proportional to arc length.
 */
export function latLngFromOfficialKm(km: number): LatLng {
  const k = Math.max(0, Math.min(NH48_KM_LENGTH, km))
  const cum = nh48Cum()
  const total = cum[cum.length - 1]
  if (total <= 0) return { ...NH48_WAYPOINTS[0] }
  const d = (k / NH48_KM_LENGTH) * total
  return positionAtDistanceKm(NH48_WAYPOINTS, cum, d)
}

/** Closest point on segment a–b to p (planar lat/lng — adequate for snapping). */
export function closestPointOnSegment(p: LatLng, a: LatLng, b: LatLng): LatLng {
  const dx = b.lng - a.lng
  const dy = b.lat - a.lat
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) return { ...a }
  let t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return { lat: a.lat + t * dy, lng: a.lng + t * dx }
}

function sqPlanarDist(p: LatLng, q: LatLng): number {
  const dlat = p.lat - q.lat
  const dlng = p.lng - q.lng
  return dlat * dlat + dlng * dlng
}

/** Snap GPS to nearest point on the NH48 polyline (vertex-to-vertex segments). */
export function snapGpsToNH48Polyline(lat: number, lng: number): LatLng {
  const p: LatLng = { lat, lng }
  const route = NH48_WAYPOINTS
  let best: LatLng = { ...p }
  let bestD = Infinity
  for (let i = 0; i < route.length - 1; i++) {
    const c = closestPointOnSegment(p, route[i], route[i + 1])
    const d = sqPlanarDist(p, c)
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

/** Geodesic distance along the polyline from start to the projection of `point` onto the nearest segment. */
export function distanceAlongRouteKm(point: LatLng): number {
  const route = NH48_WAYPOINTS
  const cum = nh48Cum()
  let bestAlong = 0
  let bestD = Infinity
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]
    const b = route[i + 1]
    const c = closestPointOnSegment(point, a, b)
    const d = haversineKm(point.lat, point.lng, c.lat, c.lng)
    const dx = b.lng - a.lng
    const dy = b.lat - a.lat
    const len2 = dx * dx + dy * dy
    const t = len2 > 1e-18 ? ((c.lng - a.lng) * dx + (c.lat - a.lat) * dy) / len2 : 0
    const u = Math.max(0, Math.min(1, t))
    const segLen = haversineKm(a.lat, a.lng, b.lat, b.lng)
    const along = cum[i] + u * segLen
    if (d < bestD) {
      bestD = d
      bestAlong = along
    }
  }
  return bestAlong
}

/** Official NH km (0–312) corresponding to a snapped GPS position. */
export function officialKmFromSnappedPoint(snap: LatLng): number {
  const total = nh48TotalRouteKm()
  if (total <= 0) return 0
  const along = distanceAlongRouteKm(snap)
  return Math.max(0, Math.min(NH48_KM_LENGTH, (along / total) * NH48_KM_LENGTH))
}

export function resolveIncidentMapPosition(inc: {
  latitude: number | null | undefined
  longitude: number | null | undefined
  km_marker: number | null | undefined
}): LatLng | null {
  if (
    inc.latitude != null &&
    inc.longitude != null &&
    Number.isFinite(inc.latitude) &&
    Number.isFinite(inc.longitude)
  ) {
    return snapGpsToNH48Polyline(inc.latitude, inc.longitude)
  }
  if (inc.km_marker != null && Number.isFinite(inc.km_marker)) {
    return latLngFromOfficialKm(inc.km_marker)
  }
  return null
}

export function resolveVehicleMapPosition(v: {
  latitude: number | null | undefined
  longitude: number | null | undefined
  km_marker: number | null | undefined
}): LatLng | null {
  return resolveIncidentMapPosition(v)
}

/** Leaflet LatLng tuple for polyline. */
export function nh48LeafletLatLngs(): [number, number][] {
  return NH48_WAYPOINTS.map((p) => [p.lat, p.lng])
}

/** Diagram/schematic: KM (0–312) for each waypoint along proportional arc length. */
export function nh48DiagramCityMarkers(): { km: number; label: string }[] {
  const cum = nh48Cum()
  const total = cum[cum.length - 1]
  return NH48_WAYPOINTS.map((_, i) => ({
    km: total > 0 ? (cum[i] / total) * NH48_KM_LENGTH : (i / (NH48_WAYPOINTS.length - 1)) * NH48_KM_LENGTH,
    label: NH48_CITY_LABELS[i] ?? `Pt ${i}`,
  }))
}

const STACK_PX = 10

/** Spread markers that share the same stack key (e.g. same rounded lat/lng) in screen space. */
export function stackOffsetLayerPixels(stackIndex: number, stackSize: number): { dx: number; dy: number } {
  if (stackSize <= 1) return { dx: 0, dy: 0 }
  const angle = (stackIndex / stackSize) * 2 * Math.PI
  return { dx: STACK_PX * Math.cos(angle), dy: STACK_PX * Math.sin(angle) }
}

export function locationStackKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`
}
