import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'
import { API, patchJson, postJson, login, fetchJson, type User } from './api'

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

function googleMapsDirectionsUrl(lat: number, lng: number): string {
  const d = `${lat},${lng}`
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(d)}`
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
  const [gpsOk, setGpsOk] = useState(true)
  const [awaitingNextCall, setAwaitingNextCall] = useState(false)
  const [broadcastMessage, setBroadcastMessage] = useState<string | null>(null)
  const hadLocationSuccess = useRef(false)

  useEffect(() => {
    if (incident) setAwaitingNextCall(false)
  }, [incident])

  const loadIncidentFromServer = useCallback(async (): Promise<IncidentDetail | null> => {
    if (!token || !vehicle) return null
    const rows = await fetchJson<IncidentDetail[]>(`/vehicles/${vehicle.id}/incidents`, token)
    const top = rows[0] ?? null
    if (!top) {
      setIncident(null)
      setHoaxFullScreen(false)
      return null
    }
    if (top.status === 'recalled') {
      setIncident(null)
      setHoaxFullScreen(true)
      return null
    }
    setHoaxFullScreen(false)
    setIncident(top)
    return top
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
    } catch {
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
    s.on('admin_broadcast', (payload: { message?: string }) => {
      if (payload && typeof payload.message === 'string' && payload.message.trim()) {
        setBroadcastMessage(payload.message.trim())
      }
    })
    return () => {
      s.emit('unsubscribe_corridor', { corridor_id: vehicle.corridor_id })
      s.disconnect()
    }
  }, [token, vehicle, refreshIncident, loadHistory])

  useEffect(() => {
    if (!token || !vehicle?.id) return
    if (!navigator.geolocation) {
      setGpsOk(false)
      return
    }

    const postLocation = (lat: number, lng: number) => {
      void patchJson(`/vehicles/${vehicle.id}/location`, token, { latitude: lat, longitude: lng }).catch(() => {})
    }

    const tick = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          hadLocationSuccess.current = true
          setGpsOk(true)
          postLocation(pos.coords.latitude, pos.coords.longitude)
        },
        () => {
          if (hadLocationSuccess.current) setGpsOk(false)
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 12_000 },
      )
    }

    tick()
    const interval = window.setInterval(tick, 10_000)
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
    setBroadcastMessage(null)
    hadLocationSuccess.current = false
    setGpsOk(true)
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
    if (!token || !vehicle || !incident || busy) return
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
    setBusy(true)
    setActionError(null)
    const vid = vehicle.id
    const iid = incident.id
    const prevIncident = incident
    const prevVehicle = vehicle

    setIncident({ ...incident, status: incidentStatusAfterStep(step) })
    setVehicle({ ...vehicle, status: vehicleStatusAfterStep(step) })

    try {
      if (step === 'accept') {
        await patchJson(`/vehicles/${vid}/status`, token, { status: 'en_route' })
        await patchJson(`/incidents/${iid}/status`, token, { status: 'accepted' })
      } else if (step === 'en_route') {
        await patchJson(`/vehicles/${vid}/status`, token, { status: 'en_route' })
        await patchJson(`/incidents/${iid}/status`, token, { status: 'en_route' })
      } else if (step === 'arrived') {
        await patchJson(`/vehicles/${vid}/status`, token, { status: 'on_scene' })
        await patchJson(`/incidents/${iid}/status`, token, { status: 'arrived' })
      } else {
        await patchJson(`/incidents/${iid}/status`, token, { status: 'closed' })
        await patchJson(`/vehicles/${vid}/status`, token, { status: 'available' })
        setAwaitingNextCall(true)
      }
      try {
        await loadIncidentFromServer()
        await loadHistory()
      } catch (reErr: unknown) {
        const reMsg = reErr instanceof Error ? reErr.message : String(reErr)
        setActionError(`Saved. Reload issue: ${reMsg}`)
      }
    } catch (e: unknown) {
      setIncident(prevIncident)
      setVehicle(prevVehicle)
      setActionError(e instanceof Error ? e.message : String(e))
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

  return (
    <div className="drv-app">
      {broadcastMessage ? (
        <div className="drv-broadcast" role="status">
          <p className="drv-broadcast-text">{broadcastMessage}</p>
          <button type="button" className="drv-btn drv-btn-broadcast-dismiss" onClick={() => setBroadcastMessage(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <header className="drv-topbar">
        <div className="drv-topbar-main">
          <p className="drv-name">{driverLine}</p>
          {vehicle && <p className="drv-ambulance-id">{vehicle.label}</p>}
        </div>
        <div className={`drv-gps-pill ${gpsOk ? 'drv-gps-on' : 'drv-gps-off'}`} role="status" aria-live="polite">
          {gpsOk ? 'GPS ON' : 'GPS OFF'}
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

                {canNavigate ? (
                  <button type="button" className="drv-btn drv-btn-navigate drv-btn-block" onClick={openNavigate}>
                    NAVIGATE
                  </button>
                ) : (
                  <p className="drv-nav-hint">No map coordinates for this incident — use KM marker.</p>
                )}

                {nextStep ? (
                  <div className="drv-actions">
                    <button
                      type="button"
                      className={`drv-btn drv-btn-block drv-btn-step drv-step-${nextStep}`}
                      data-step={nextStep}
                      disabled={busy}
                      onClick={() => void runStep(nextStep)}
                    >
                      {primaryActionLabel(nextStep)}
                    </button>
                    {nextStep === 'accept' ? (
                      <button type="button" className="drv-btn drv-btn-block drv-btn-decline" disabled={busy} onClick={() => void cannotRespond()}>
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
            {history.length === 0 ? (
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
                    {history.map((h) => (
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
