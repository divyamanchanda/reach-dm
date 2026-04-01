import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet'
import { io, Socket } from 'socket.io-client'
import './App.css'
import { API, apiUrl, fetchJson, login, patchJson, postJson, type User } from './api'

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
  status: string
  reporter_type: string
  injured_count: number
  public_report_id: string | null
  created_at: string
  updated_at: string
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

function isNewIncident(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() <= 5 * 60 * 1000
}

function statusLabel(status: string): string {
  if (status === 'confirmed_real') return 'Verified ✓'
  if (status === 'recalled') return 'Hoax — Recalled'
  return status
}

function trustBand(score: number): { label: string; className: 'trust-low' | 'trust-mid' | 'trust-high' } {
  if (score <= 30) return { label: 'Unverified', className: 'trust-low' }
  if (score <= 60) return { label: 'Partially verified', className: 'trust-mid' }
  return { label: 'High confidence', className: 'trust-high' }
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

function RecenterMap({ latitude, longitude }: { latitude: number; longitude: number }) {
  const map = useMap()
  useEffect(() => {
    map.setView([latitude, longitude], Math.max(map.getZoom(), 13))
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
    const s = io(API, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
    })
    s.on('connect', () => {
      s.emit('subscribe_corridor', { corridor_id: corridorId })
    })
    const bump = () => refreshLists(corridorId, token).catch(() => {})
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
    s.on('incident:new', bump)
    s.on('incident:updated', bump)
    s.on('incident:dispatched', onDispatched)
    s.on('incident:recalled', bump)
    s.on('corridor:stats', bump)
    setSocket(s)
    return () => {
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
    if (!token || !selectedId) {
      setNearby([])
      return
    }
    fetchJson<NearbyVehicle[]>(`/incidents/${selectedId}/nearby-vehicles`, token)
      .then(setNearby)
      .catch(() => setNearby([]))
  }, [token, selectedId])

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
      ['dispatched', 'recalled', 'confirmed_real'].includes(incident.status) ||
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

  const confirmRealIncident = async (incident: Incident) => {
    if (!token || dispatchingByIncidentId[incident.id]) return
    setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: true }))
    setError(null)
    setErrorHint(null)
    try {
      await patchJson(`/incidents/${incident.id}/status`, token, { status: 'confirmed_real' })
      if (corridorId) await refreshLists(corridorId, token)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed confirming incident')
    } finally {
      setDispatchingByIncidentId((prev) => ({ ...prev, [incident.id]: false }))
    }
  }

  const recallIncident = async (incident: Incident) => {
    if (!token || dispatchingByIncidentId[incident.id]) return
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
          {incidents.map((i) => (
            <div
              key={i.id}
              role="button"
              tabIndex={0}
              className={`inc-card ${selectedId === i.id ? 'active' : ''}`}
              onClick={() => {
                setSelectedId(i.id)
                setIsDetailOpen(true)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelectedId(i.id)
                  setIsDetailOpen(true)
                }
              }}
              style={{ borderLeftColor: severityColor[i.severity] ?? '#64748b' }}
            >
              <div className="row">
                <strong>{i.incident_type}</strong>
                <div className="chip-row">
                  {isNewIncident(i.created_at) && <span className="new-pill">NEW</span>}
                  <span className="pill" style={{ background: severityColor[i.severity] }}>
                    {i.severity}
                  </span>
                </div>
              </div>
              <div className="meta">
                KM {i.km_marker ?? '—'} ·{' '}
                <span className={`trust-label ${trustBand(i.trust_score).className}`}>
                  {trustBand(i.trust_score).className === 'trust-low'
                    ? '🔴'
                    : trustBand(i.trust_score).className === 'trust-mid'
                      ? '🟡'
                      : '🟢'}{' '}
                  {trustBand(i.trust_score).label}
                </span>
              </div>
              <div className="meta">
                Report {(i.public_report_id ?? i.id).slice(0, 8)} · {relativeReportedTime(i.created_at)}
              </div>
              <div className="trust-bar">
                <span style={{ width: `${i.trust_score}%` }} />
              </div>
              <div className="meta">{statusLabel(i.status)}</div>
              {assignedVehicleByIncidentId[i.id] && (
                <div className="meta">
                  Assigned: {vehicleLabelById[assignedVehicleByIncidentId[i.id].vehicle_id] ?? assignedVehicleByIncidentId[i.id].label}
                </div>
              )}
              {i.status === 'recalled' ? (
                <p className="recall-msg">Ambulance recalled — hoax confirmed</p>
              ) : i.status === 'confirmed_real' ? (
                <p className="confirm-msg">Incident verified as real ✓</p>
              ) : i.status === 'dispatched' ? (
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
          ))}
        </aside>

        <section className="map-panel">
          <h3>Map</h3>
          <p className="hint">Live location map for selected incident.</p>
          {selected && (
            <div className="map-placeholder">
              {(() => {
                const lat = incidentDetail?.latitude ?? selected.latitude
                const lng = incidentDetail?.longitude ?? selected.longitude
                if (lat == null || lng == null) {
                  return (
                    <>
                      <div>Lat —</div>
                      <div>Lng —</div>
                    </>
                  )
                }
                return (
                  <>
                    <MapContainer
                      className="leaflet-map"
                      center={[lat, lng]}
                      zoom={13}
                      scrollWheelZoom
                    >
                      <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      />
                      <CircleMarker
                        center={[lat, lng]}
                        radius={10}
                        pathOptions={{ color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.7 }}
                      >
                        <Popup>{selected.incident_type}</Popup>
                      </CircleMarker>
                      <RecenterMap latitude={lat} longitude={lng} />
                    </MapContainer>
                    <div>Lat {lat}</div>
                    <div>Lng {lng}</div>
                    <a
                      className="link"
                      href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in OSM
                    </a>
                  </>
                )
              })()}
            </div>
          )}
        </section>

        <aside className="detail">
          {!selected && <p>Select an incident.</p>}
          {selected && (
            <>
              <h3>Incident detail</h3>
              <dl className="kv">
                <dt>Type</dt>
                <dd>{selected.incident_type}</dd>
                <dt>Severity</dt>
                <dd>{selected.severity}</dd>
                <dt>KM</dt>
                <dd>{selected.km_marker ?? '—'}</dd>
                <dt>Trust</dt>
                <dd>
                  {selected.trust_score} — {selected.trust_recommendation ?? '—'}
                </dd>
                <dt>Reporter</dt>
                <dd>{selected.reporter_type}</dd>
                <dt>Status</dt>
                <dd>{statusLabel(selected.status)}</dd>
                <dt>Injured</dt>
                <dd>{incidentDetail?.injured_count ?? selected.injured_count}</dd>
                {incidentDetail?.public_report_id && (
                  <>
                    <dt>Public report ID</dt>
                    <dd>{incidentDetail.public_report_id}</dd>
                  </>
                )}
                <dt>Notes</dt>
                <dd className="notes-dd">
                  {incidentDetail?.notes?.trim()
                    ? incidentDetail.notes
                    : '—'}
                </dd>
              </dl>

              {incidentDetail && incidentDetail.timeline.length > 0 && (
                <div className="timeline">
                  <h4>Recent timeline</h4>
                  <ul>
                    {incidentDetail.timeline.slice(-5).map((ev) => (
                      <li key={ev.id}>
                        <span className="tl-type">{ev.event_type}</span>
                        <time>{new Date(ev.created_at).toLocaleString()}</time>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <h4>Nearest ambulances</h4>
              <ul className="vehicle-list">
                {nearby.map((v) => (
                  <li key={v.vehicle_id}>
                    {v.label} — {Math.round(v.distance_meters)} m
                    {v.eta_minutes != null ? ` · ~${v.eta_minutes} min` : ''}
                    <span className={`eta-badge ${v.eta_source === 'route' ? 'route' : 'fallback'}`}>
                      {v.eta_source === 'route' ? 'ETA: route' : 'ETA: fallback'}
                    </span>
                  </li>
                ))}
              </ul>
              {selected.status === 'recalled' ? (
                <p className="recall-msg">Ambulance recalled — hoax confirmed</p>
              ) : selected.status === 'confirmed_real' ? (
                <p className="confirm-msg">Incident verified as real ✓</p>
              ) : selected.status === 'dispatched' ? (
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
            </>
          )}
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
              <dt>Trust score</dt>
              <dd>{selected.trust_score}</dd>
              <dt>Trust recommendation</dt>
              <dd>{selected.trust_recommendation ?? '—'}</dd>
              <dt>Latitude</dt>
              <dd>{incidentDetail?.latitude ?? selected.latitude ?? '—'}</dd>
              <dt>Longitude</dt>
              <dd>{incidentDetail?.longitude ?? selected.longitude ?? '—'}</dd>
              <dt>Public report ID</dt>
              <dd>{incidentDetail?.public_report_id ?? '—'}</dd>
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
