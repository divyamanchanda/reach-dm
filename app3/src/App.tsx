import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'
import { API, patchJson, postJson, login, fetchJson, type User } from './api'
import {
  enqueuePendingAction,
  loadCurrentSnapshot,
  loadPendingActions,
  loadRecentAssignments,
  recordRecentAssignment,
  removePendingAction,
  saveCurrentSnapshot,
  toDriverSnapshot,
  type DriverSyncStep,
} from './driverOfflineCache'
import { useDriverNetwork } from './useDriverNetwork'
import {
  clearBroadcastLog,
  loadBroadcastLog,
  mergeBroadcastIntoLog,
  parseBroadcastPayload,
  playDriverBroadcastAlert,
  type DriverBroadcastPayload,
} from './broadcastUtils'

type DriverStep = 'accept' | 'en_route' | 'arrived' | 'clear'

type MyVehicle = {
  id: string
  corridor_id: string
  corridor_name: string
  label: string
  status: string
  vehicle_type: string
}

type IncidentDetail = {
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

type HistoryRow = {
  id: string
  incident_type: string
  status: string
  created_at: string
}

function currentStepForStatus(status: string | undefined | null): DriverStep | null {
  if (status == null || String(status).trim() === '') return null
  const s = String(status).toLowerCase()
  if (s === 'closed' || s === 'cancelled' || s === 'recalled' || s === 'archived') return null
  if (s === 'accepted') return 'en_route'
  if (s === 'en_route') return 'arrived'
  if (s === 'arrived' || s === 'on_scene') return 'clear'
  return 'accept'
}

function hasActiveDriverAssignment(inc: IncidentDetail | null): boolean {
  if (!inc) return false
  return currentStepForStatus(inc.status) != null
}

function incidentStatusAfterStep(step: DriverStep): string {
  switch (step) {
    case 'accept':
      return 'accepted'
    case 'en_route':
      return 'en_route'
    case 'arrived':
      return 'arrived'
    case 'clear':
      return 'closed'
    default:
      return 'open'
  }
}

function vehicleStatusAfterStep(step: DriverStep): string {
  switch (step) {
    case 'accept':
    case 'en_route':
      return 'en_route'
    case 'arrived':
      return 'on_scene'
    case 'clear':
      return 'available'
    default:
      return 'en_route'
  }
}

function primaryActionLabel(step: DriverStep): string {
  switch (step) {
    case 'accept':
      return 'ACCEPT'
    case 'en_route':
      return 'EN ROUTE'
    case 'arrived':
      return "I'VE ARRIVED"
    case 'clear':
      return 'INCIDENT CLEARED'
    default:
      return 'CONTINUE'
  }
}

const NH48_KM_LENGTH = 312

/** Approximate KM along NH48 from coordinates (projection onto Bengaluru–Chennai segment). */
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

function googleMapsDirectionsUrl(lat: number, lng: number): string {
  const d = `${lat},${lng}`
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(d)}`
}

function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true
  const m = e instanceof Error ? e.message : String(e)
  return /failed to fetch|networkerror|load failed|network request failed|aborted|fetch/i.test(m)
}

function normalizeIncidentFromApi(raw: unknown): IncidentDetail | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string') return null
  const km = o.km_marker
  const lat = o.latitude
  const lng = o.longitude
  return {
    id: o.id,
    corridor_id: String(o.corridor_id ?? ''),
    incident_type: String(o.incident_type ?? ''),
    severity: String(o.severity ?? ''),
    km_marker: typeof km === 'number' && Number.isFinite(km) ? km : km != null ? Number(km) : null,
    latitude: typeof lat === 'number' && Number.isFinite(lat) ? lat : lat != null ? Number(lat) : null,
    longitude: typeof lng === 'number' && Number.isFinite(lng) ? lng : lng != null ? Number(lng) : null,
    trust_score: typeof o.trust_score === 'number' ? o.trust_score : Number(o.trust_score) || 0,
    status: String(o.status ?? ''),
    created_at: String(o.created_at ?? ''),
    notes: o.notes == null || o.notes === '' ? null : String(o.notes),
  }
}

async function performDriverStepApi(
  step: DriverSyncStep,
  vehicleId: string,
  incidentId: string,
  token: string,
): Promise<void> {
  if (step === 'accept') {
    await patchJson(`/vehicles/${vehicleId}/status`, token, { status: 'en_route' })
    await patchJson(`/incidents/${incidentId}/status`, token, { status: 'accepted' })
  } else if (step === 'en_route') {
    await patchJson(`/vehicles/${vehicleId}/status`, token, { status: 'en_route' })
    await patchJson(`/incidents/${incidentId}/status`, token, { status: 'en_route' })
  } else if (step === 'arrived') {
    await patchJson(`/vehicles/${vehicleId}/status`, token, { status: 'on_scene' })
    await patchJson(`/incidents/${incidentId}/status`, token, { status: 'arrived' })
  } else {
    await patchJson(`/incidents/${incidentId}/status`, token, { status: 'closed' })
    await patchJson(`/vehicles/${vehicleId}/status`, token, { status: 'available' })
  }
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('reach3_token'))
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem('reach3_user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as User
    } catch {
      return null
    }
  })
  const [phone, setPhone] = useState('+919876543211')
  const [password, setPassword] = useState('reach2026')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [vehicle, setVehicle] = useState<MyVehicle | null>(null)
  const [vehicleLoadError, setVehicleLoadError] = useState<string | null>(null)
  const [incident, setIncident] = useState<IncidentDetail | null>(null)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [hoaxFullScreen, setHoaxFullScreen] = useState(false)
  const [busy, setBusy] = useState(false)
  /** GPS fix quality for UI: active = recent successful read; weak = had fix then lost; no_signal = none / unsupported */
  const [gpsFixState, setGpsFixState] = useState<'active' | 'weak' | 'no_signal'>('no_signal')
  const [driverKmNH48, setDriverKmNH48] = useState<number | null>(null)
  const [awaitingNextCall, setAwaitingNextCall] = useState(false)
  const [broadcastPanel, setBroadcastPanel] = useState<DriverBroadcastPayload | null>(null)
  const [broadcastHistory, setBroadcastHistory] = useState<DriverBroadcastPayload[]>([])
  const [lastFetchFailed, setLastFetchFailed] = useState(false)
  const [syncBanner, setSyncBanner] = useState<string | null>(null)
  const [pendingVersion, setPendingVersion] = useState(0)
  const [recentSnaps, setRecentSnaps] = useState<ReturnType<typeof loadRecentAssignments>>([])
  const hadLocationSuccess = useRef(false)
  const incidentRef = useRef<IncidentDetail | null>(null)

  const { isOffline } = useDriverNetwork(lastFetchFailed)

  useEffect(() => {
    incidentRef.current = incident
  }, [incident])

  useEffect(() => {
    if (incident) setAwaitingNextCall(false)
  }, [incident])

  useEffect(() => {
    if (!user?.id) {
      setBroadcastHistory([])
      return
    }
    setBroadcastHistory(loadBroadcastLog(user.id))
  }, [user?.id])

  const loadIncidentFromServer = useCallback(async (): Promise<IncidentDetail | null> => {
    if (!token || !vehicle) return null
    try {
      const rows = await fetchJson<unknown[]>(`/vehicles/${vehicle.id}/incidents`, token)
      setLastFetchFailed(false)
      const raw = Array.isArray(rows) && rows[0] != null ? rows[0] : null
      const top = raw ? normalizeIncidentFromApi(raw) : null
      if (!top) {
        setIncident(null)
        setHoaxFullScreen(false)
        saveCurrentSnapshot(vehicle.id, null)
        return null
      }
      if (top.status === 'recalled') {
        setIncident(null)
        setHoaxFullScreen(true)
        saveCurrentSnapshot(vehicle.id, null)
        return null
      }
      setHoaxFullScreen(false)
      setIncident(top)
      const snap = toDriverSnapshot(top)
      saveCurrentSnapshot(vehicle.id, snap)
      recordRecentAssignment(vehicle.id, snap)
      setRecentSnaps(loadRecentAssignments(vehicle.id))
      return top
    } catch {
      setLastFetchFailed(true)
      const cached = loadCurrentSnapshot(vehicle.id)
      if (cached) {
        setIncident({
          id: cached.id,
          corridor_id: cached.corridor_id,
          incident_type: cached.incident_type,
          severity: cached.severity,
          km_marker: cached.km_marker,
          latitude: cached.latitude,
          longitude: cached.longitude,
          trust_score: cached.trust_score,
          status: cached.status,
          created_at: cached.created_at,
          notes: cached.notes,
        })
        setHoaxFullScreen(false)
      }
      return null
    }
  }, [token, vehicle])

  const refreshIncident = useCallback(async () => {
    try {
      return await loadIncidentFromServer()
    } catch {
      return null
    }
  }, [loadIncidentFromServer])

  const loadHistory = useCallback(async () => {
    if (!token || !vehicle) return
    try {
      const rows = await fetchJson<HistoryRow[]>(`/vehicles/${vehicle.id}/incidents/history?limit=5`, token)
      setHistory(Array.isArray(rows) ? rows : [])
      setLastFetchFailed(false)
    } catch {
      setLastFetchFailed(true)
      setHistory([])
    }
  }, [token, vehicle])

  useEffect(() => {
    if (!token) {
      setVehicle(null)
      setVehicleLoadError(null)
      setIncident(null)
      setHistory([])
      setHoaxFullScreen(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const mine = await fetchJson<MyVehicle[]>('/vehicles/mine', token)
        if (cancelled) return
        if (mine.length === 0) {
          setVehicle(null)
          setVehicleLoadError('No vehicle assigned. Contact dispatch.')
          return
        }
        const chosen = [...mine].sort((a, b) => a.label.localeCompare(b.label))[0]
        setVehicle(chosen)
        setVehicleLoadError(null)
      } catch (e: unknown) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : 'Could not load vehicle'
        setVehicle(null)
        setVehicleLoadError(/403|forbidden/i.test(msg) ? 'Driver login required.' : msg)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (!token || !vehicle) return
    const snap = loadCurrentSnapshot(vehicle.id)
    setRecentSnaps(loadRecentAssignments(vehicle.id))
    if (snap) {
      setIncident({
        id: snap.id,
        corridor_id: snap.corridor_id,
        incident_type: snap.incident_type,
        severity: snap.severity,
        km_marker: snap.km_marker,
        latitude: snap.latitude,
        longitude: snap.longitude,
        trust_score: snap.trust_score,
        status: snap.status,
        created_at: snap.created_at,
        notes: snap.notes,
      })
      setHoaxFullScreen(false)
    }
    void loadIncidentFromServer()
    void loadHistory()
    const id = window.setInterval(() => {
      void refreshIncident()
      void loadHistory()
    }, 5000)
    return () => window.clearInterval(id)
  }, [token, vehicle, loadIncidentFromServer, refreshIncident, loadHistory])

  useEffect(() => {
    if (!token || !vehicle) return
    const s = io(API, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
    })
    s.on('connect', () => s.emit('subscribe_corridor', { corridor_id: vehicle.corridor_id }))
    const bump = () => {
      void refreshIncident()
      void loadHistory()
    }
    s.on('incident:dispatched', bump)
    s.on('incident:updated', bump)
    s.on('incident:recalled', bump)
    s.on('admin_broadcast', (payload: unknown) => {
      const item = parseBroadcastPayload(payload)
      if (!item || !user?.id) return
      setBroadcastHistory((prev) => mergeBroadcastIntoLog(user.id, item, prev))
      setBroadcastPanel(item)
      if (hasActiveDriverAssignment(incidentRef.current)) {
        playDriverBroadcastAlert()
      }
    })
    return () => {
      s.emit('unsubscribe_corridor', { corridor_id: vehicle.corridor_id })
      s.disconnect()
    }
  }, [token, vehicle, user?.id, refreshIncident, loadHistory])

  useEffect(() => {
    const bump = () => setPendingVersion((v) => v + 1)
    window.addEventListener('online', bump)
    return () => window.removeEventListener('online', bump)
  }, [])

  useEffect(() => {
    if (!token || !vehicle || isOffline) return
    const pending = loadPendingActions(vehicle.id)
    if (pending.length === 0) return
    let cancelled = false
    ;(async () => {
      const list = [...pending]
      let synced = 0
      for (const p of list) {
        if (cancelled) return
        try {
          await performDriverStepApi(p.step, vehicle.id, p.incidentId, token)
          removePendingAction(vehicle.id, p.id)
          synced += 1
        } catch (e) {
          if (isNetworkError(e)) break
          removePendingAction(vehicle.id, p.id)
        }
      }
      if (synced > 0) {
        setSyncBanner('✅ Status synced')
        setPendingVersion((v) => v + 1)
        window.setTimeout(() => setSyncBanner(null), 8000)
        await loadIncidentFromServer()
        await loadHistory()
        setRecentSnaps(loadRecentAssignments(vehicle.id))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, vehicle, isOffline, pendingVersion, loadIncidentFromServer, loadHistory])

  useEffect(() => {
    if (!token || !vehicle?.id) return
    if (!navigator.geolocation) {
      setGpsFixState('no_signal')
      setDriverKmNH48(null)
      return
    }

    const postLocation = (lat: number, lng: number) => {
      void patchJson(`/vehicles/${vehicle.id}/location`, token, { latitude: lat, longitude: lng }).catch(() => {})
    }

    const tick = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          hadLocationSuccess.current = true
          const lat = pos.coords.latitude
          const lng = pos.coords.longitude
          setGpsFixState('active')
          setDriverKmNH48(kmAlongNh48FromLatLng(lat, lng))
          postLocation(lat, lng)
        },
        () => {
          if (hadLocationSuccess.current) {
            setGpsFixState('weak')
          } else {
            setGpsFixState('no_signal')
            setDriverKmNH48(null)
          }
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 12_000 },
      )
    }

    tick()
    const interval = window.setInterval(tick, 30_000)
    return () => window.clearInterval(interval)
  }, [token, vehicle])

  const driverLine = useMemo(() => user?.full_name?.trim() || user?.phone || 'Driver', [user])

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginError(null)
    try {
      const res = await login(phone, password)
      localStorage.setItem('reach3_token', res.access_token)
      localStorage.setItem('reach3_user', JSON.stringify(res.user))
      setToken(res.access_token)
      setUser(res.user)
    } catch (err: unknown) {
      setLoginError(err instanceof Error ? err.message : 'Sign-in failed')
    }
  }

  const logout = () => {
    localStorage.removeItem('reach3_token')
    localStorage.removeItem('reach3_user')
    setToken(null)
    setUser(null)
    setVehicle(null)
    setIncident(null)
    setHistory([])
    setHoaxFullScreen(false)
    setAwaitingNextCall(false)
    setBroadcastPanel(null)
    if (user?.id) clearBroadcastLog(user.id)
    setBroadcastHistory([])
    hadLocationSuccess.current = false
    setGpsFixState('no_signal')
    setDriverKmNH48(null)
  }

  const dismissHoax = () => {
    setHoaxFullScreen(false)
    void refreshIncident()
  }

  const acknowledgeReadyForNextCall = () => {
    setAwaitingNextCall(false)
    setActionError(null)
    void loadIncidentFromServer()
    void loadHistory()
  }

  const cannotRespond = async () => {
    if (!token || !vehicle || !incident || busy || isOffline) return
    setBusy(true)
    setActionError(null)
    try {
      await postJson(`/incidents/${incident.id}/decline`, token, {})
      await loadIncidentFromServer()
      await loadHistory()
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const runStep = async (step: DriverStep) => {
    if (!token || !vehicle || !incident || busy) return
    if (isOffline && (step === 'arrived' || step === 'clear')) return
    setBusy(true)
    setActionError(null)
    const vid = vehicle.id
    const iid = incident.id
    const prevIncident = incident
    const prevVehicle = vehicle

    setIncident({ ...incident, status: incidentStatusAfterStep(step) })
    setVehicle({ ...vehicle, status: vehicleStatusAfterStep(step) })

    try {
      await performDriverStepApi(step, vid, iid, token)
      if (step === 'clear') setAwaitingNextCall(true)
      try {
        await loadIncidentFromServer()
        await loadHistory()
      } catch (reErr: unknown) {
        const reMsg = reErr instanceof Error ? reErr.message : String(reErr)
        setActionError(`Saved. Reload issue: ${reMsg}`)
      }
    } catch (e: unknown) {
      if (isNetworkError(e)) {
        enqueuePendingAction(vehicle.id, { vehicleId: vehicle.id, incidentId: iid, step })
        setPendingVersion((v) => v + 1)
        setActionError('Will sync when signal returns')
        if (step === 'clear') setAwaitingNextCall(true)
        const snap = toDriverSnapshot({
          ...incident,
          status: incidentStatusAfterStep(step),
          notes: incident.notes,
        })
        saveCurrentSnapshot(vehicle.id, snap)
        recordRecentAssignment(vehicle.id, snap)
        setRecentSnaps(loadRecentAssignments(vehicle.id))
      } else {
        setIncident(prevIncident)
        setVehicle(prevVehicle)
        if (step === 'clear') setAwaitingNextCall(false)
        setActionError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  const openNavigate = () => {
    if (!incident?.latitude || incident?.longitude == null) return
    window.open(googleMapsDirectionsUrl(incident.latitude, incident.longitude), '_blank', 'noopener,noreferrer')
  }

  if (hoaxFullScreen) {
    return (
      <div className="drv-standdown" role="alert">
        <div className="drv-standdown-inner">
          <p className="drv-standdown-title">STAND DOWN — HOAX REPORTED. Return to base.</p>
          <button type="button" className="drv-btn drv-btn-standdown" onClick={dismissHoax}>
            Acknowledge
          </button>
        </div>
      </div>
    )
  }

  if (!token || !user) {
    return (
      <div className="drv-app drv-login">
        <h1 className="drv-h1">REACH Driver</h1>
        <form className="drv-form" onSubmit={(e) => void submitLogin(e)}>
          <label className="drv-label">
            Phone
            <input
              className="drv-input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="username"
              inputMode="tel"
            />
          </label>
          <label className="drv-label">
            Password
            <input
              className="drv-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {loginError && <p className="drv-err">{loginError}</p>}
          <button type="submit" className="drv-btn drv-btn-primary drv-btn-block">
            LOGIN
          </button>
        </form>
      </div>
    )
  }

  const nextStep = incident ? currentStepForStatus(incident.status) : null
  const canNavigate =
    incident != null && incident.latitude != null && incident.longitude != null && Number.isFinite(incident.latitude) && Number.isFinite(incident.longitude)

  const kmForOfflineMsg =
    incident?.km_marker != null && Number.isFinite(Number(incident.km_marker)) ? String(incident.km_marker) : '—'

  const historyRows: HistoryRow[] =
    history.length > 0
      ? history
      : recentSnaps.map((s) => ({
          id: s.id,
          incident_type: s.incident_type,
          status: s.status,
          created_at: s.created_at,
        }))

  const internetOnline = !isOffline
  const showDualOfflineBanner = isOffline && gpsFixState !== 'active'
  const showDriverKmLine = gpsFixState === 'active' && driverKmNH48 != null && Number.isFinite(driverKmNH48)

  const dismissBroadcastPanel = () => setBroadcastPanel(null)

  return (
    <div className="drv-app">
      {broadcastPanel ? (
        <div className="drv-bc-overlay" role="presentation">
          <div className="drv-bc-backdrop" aria-hidden />
          <div
            className="drv-bc-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="drv-bc-heading"
          >
            <p id="drv-bc-heading" className="drv-bc-heading">
              📢 Message from Dispatch Control
            </p>
            {broadcastPanel.priority ? (
              <p
                className={`drv-bc-priority ${broadcastPanel.priority === 'urgent' ? 'drv-bc-priority--urgent' : 'drv-bc-priority--info'}`}
              >
                {broadcastPanel.priority === 'urgent' ? '🔴 Urgent' : '🟡 Info'}
              </p>
            ) : null}
            <p className="drv-bc-sender">
              Sent by: <strong>{broadcastPanel.sender_name}</strong> at{' '}
              {new Date(broadcastPanel.created_at).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </p>
            <p className="drv-bc-body">{broadcastPanel.message}</p>
            <button type="button" className="drv-btn drv-bc-gotit" onClick={dismissBroadcastPanel}>
              Got it ✓
            </button>
          </div>
        </div>
      ) : null}

      {syncBanner ? (
        <div className="drv-sync-toast" role="status">
          {syncBanner}
        </div>
      ) : null}

      {showDualOfflineBanner ? (
        <div className="drv-dual-offline-banner" role="alert">
          ⚠️ No internet + No GPS — operating in offline mode
        </div>
      ) : null}

      <header className="drv-topbar">
        <div className="drv-topbar-main">
          <p className="drv-name">{driverLine}</p>
          {vehicle && <p className="drv-ambulance-id">{vehicle.label}</p>}
          {showDriverKmLine && driverKmNH48 != null ? (
            <p className="drv-topbar-km" role="status">
              📍 KM {Math.round(driverKmNH48)} · NH48
            </p>
          ) : null}
        </div>
        <div className="drv-topbar-pills" aria-live="polite">
          <span
            className={`drv-status-pill drv-status-pill--net ${internetOnline ? 'drv-status-pill--ok' : 'drv-status-pill--bad'}`}
          >
            {internetOnline ? '📶 Internet: On' : '📶 Offline'}
          </span>
          <span
            className={`drv-status-pill drv-status-pill--gps ${
              gpsFixState === 'active' ? 'drv-status-pill--ok' : 'drv-status-pill--warn'
            }`}
          >
            {gpsFixState === 'active'
              ? '📍 GPS: Active'
              : gpsFixState === 'weak'
                ? '📍 GPS: Weak'
                : '📍 GPS: No signal'}
          </span>
        </div>
      </header>

      {vehicleLoadError && <p className="drv-banner-warn">{vehicleLoadError}</p>}

      {vehicle && !vehicleLoadError && (
        <main className="drv-main">
          <section className="drv-section" aria-labelledby="assign-heading">
            <h2 id="assign-heading" className="drv-section-title">
              Current assignment
            </h2>
            {incident ? (
              <div className="drv-assignment">
                {isOffline ? (
                  <p className="drv-offline-banner" role="alert">
                    📵 No signal — showing last known assignment. Navigate to KM {kmForOfflineMsg}
                  </p>
                ) : null}
                <p className="drv-incident-type">{incident.incident_type}</p>
                <div className="drv-meta-row">
                  <span className="drv-km-label">KM</span>
                  <span className="drv-km-value">{incident.km_marker ?? '—'}</span>
                </div>
                <p
                  className={`drv-sev drv-sev-${['critical', 'major', 'minor'].includes(incident.severity.toLowerCase()) ? incident.severity.toLowerCase() : 'major'}`}
                >
                  {incident.severity}
                </p>
                {incident.notes ? (
                  <p className="drv-notes">
                    <span className="drv-notes-label">Notes</span>
                    {incident.notes}
                  </p>
                ) : null}

                {canNavigate ? (
                  <button type="button" className="drv-btn drv-btn-navigate drv-btn-block" onClick={openNavigate}>
                    NAVIGATE
                  </button>
                ) : (
                  <p className="drv-nav-hint">No map coordinates for this incident — use KM marker.</p>
                )}

                {nextStep ? (
                  <div className="drv-actions">
                    {isOffline && (nextStep === 'arrived' || nextStep === 'clear') ? (
                      <p className="drv-offline-sync-hint">Will sync when signal returns</p>
                    ) : null}
                    <button
                      type="button"
                      className={`drv-btn drv-btn-block drv-btn-step drv-step-${nextStep}`}
                      data-step={nextStep}
                      disabled={busy || (isOffline && (nextStep === 'arrived' || nextStep === 'clear'))}
                      onClick={() => void runStep(nextStep)}
                    >
                      {primaryActionLabel(nextStep)}
                    </button>
                    {nextStep === 'accept' ? (
                      <button
                        type="button"
                        className="drv-btn drv-btn-block drv-btn-decline"
                        disabled={busy || isOffline}
                        onClick={() => void cannotRespond()}
                      >
                        CANNOT RESPOND
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="drv-subdued">Incident cleared.</p>
                )}
                {actionError && <p className="drv-err">{actionError}</p>}
              </div>
            ) : awaitingNextCall ? (
              <div className="drv-cleared-block">
                <p className="drv-subdued">Last call cleared.</p>
                <button type="button" className="drv-btn drv-btn-primary drv-btn-block" onClick={acknowledgeReadyForNextCall}>
                  READY FOR NEXT CALL
                </button>
              </div>
            ) : (
              <div className="drv-standby" aria-live="polite">
                <span className="drv-pulse-dot" aria-hidden />
                <p className="drv-standby-text">Standby — Ready for next call</p>
              </div>
            )}
          </section>

          <section className="drv-section drv-history" aria-labelledby="hist-heading">
            <h2 id="hist-heading" className="drv-section-title">
              Incident history
            </h2>
            {historyRows.length === 0 ? (
              <p className="drv-subdued">No history yet.</p>
            ) : (
              <div className="drv-table-wrap">
                <table className="drv-table">
                  <thead>
                    <tr>
                      <th scope="col">Type</th>
                      <th scope="col">Date</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRows.map((h) => (
                      <tr key={h.id}>
                        <td>{h.incident_type}</td>
                        <td>{new Date(h.created_at).toLocaleString()}</td>
                        <td>
                          <span className="drv-status-pill">{h.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="drv-section drv-bc-archive" aria-labelledby="bc-archive-heading">
            <h2 id="bc-archive-heading" className="drv-section-title">
              Messages
            </h2>
            {broadcastHistory.length === 0 ? (
              <p className="drv-subdued">No broadcast messages yet.</p>
            ) : (
              <ul className="drv-bc-archive-list">
                {broadcastHistory.map((b) => (
                  <li key={b.id} className="drv-bc-archive-item">
                    <div className="drv-bc-archive-meta">
                      <time dateTime={b.created_at}>
                        {new Date(b.created_at).toLocaleString(undefined, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </time>
                      {b.priority ? (
                        <span className={b.priority === 'urgent' ? 'drv-bc-pill-urgent' : 'drv-bc-pill-info'}>
                          {b.priority === 'urgent' ? 'Urgent' : 'Info'}
                        </span>
                      ) : null}
                    </div>
                    <p className="drv-bc-archive-sender">From {b.sender_name}</p>
                    <p className="drv-bc-archive-msg">{b.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      )}

      <footer className="drv-footer">
        <button type="button" className="drv-btn drv-btn-ghost drv-btn-block" onClick={logout}>
          Log out
        </button>
      </footer>
    </div>
  )
}
