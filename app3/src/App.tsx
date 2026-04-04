import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'
import { API, patchJson, login, fetchJson, type User } from './api'

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
  if (s === 'closed' || s === 'cancelled' || s === 'recalled') return null
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

const STEP_LABEL: Record<DriverStep, string> = {
  accept: 'ACCEPT',
  en_route: 'EN ROUTE',
  arrived: 'ARRIVED',
  clear: 'CLEAR',
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
  const hadLocationSuccess = useRef(false)

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
      const rows = await fetchJson<HistoryRow[]>(`/vehicles/${vehicle.id}/incidents/history?limit=10`, token)
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
    hadLocationSuccess.current = false
    setGpsOk(true)
  }

  const dismissHoax = () => {
    setHoaxFullScreen(false)
    void refreshIncident()
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

  if (hoaxFullScreen) {
    return (
      <div className="sun-standdown" role="alert">
        <div className="sun-standdown-inner">
          <p className="sun-standdown-title">STAND DOWN — HOAX REPORTED. Return to base.</p>
          <button type="button" className="sun-standdown-btn" onClick={dismissHoax}>
            Acknowledge
          </button>
        </div>
      </div>
    )
  }

  if (!token || !user) {
    return (
      <div className="sun-app sun-login">
        <h1 className="sun-h1">REACH Driver</h1>
        <form className="sun-form" onSubmit={(e) => void submitLogin(e)}>
          <label className="sun-label">
            Phone
            <input
              className="sun-input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="username"
              inputMode="tel"
            />
          </label>
          <label className="sun-label">
            Password
            <input
              className="sun-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {loginError && <p className="sun-err">{loginError}</p>}
          <button type="submit" className="sun-btn sun-btn-login">
            LOGIN
          </button>
        </form>
      </div>
    )
  }

  const nextStep = incident ? currentStepForStatus(incident.status) : null

  return (
    <div className="sun-app">
      <div className={`sun-gps ${gpsOk ? 'sun-gps-on' : 'sun-gps-lost'}`} role="status">
        {gpsOk ? 'GPS ON' : 'GPS LOST'}
      </div>

      <header className="sun-header">
        <p className="sun-driver">{driverLine}</p>
        {vehicle && <p className="sun-vehicle">{vehicle.label}</p>}
      </header>

      {vehicleLoadError && <p className="sun-banner-warn">{vehicleLoadError}</p>}

      {vehicle && !vehicleLoadError && (
        <main className="sun-main">
          <section className="sun-section" aria-labelledby="assign-heading">
            <h2 id="assign-heading" className="sun-section-title">
              CURRENT ASSIGNMENT
            </h2>
            {incident ? (
              <>
                <p className="sun-type">{incident.incident_type.toUpperCase()}</p>
                <p
                  className={`sun-sev sun-sev-${['critical', 'major', 'minor'].includes(incident.severity.toLowerCase()) ? incident.severity.toLowerCase() : 'major'}`}
                >
                  {incident.severity.toUpperCase()}
                </p>
                <p className="sun-km">
                  KM <strong>{incident.km_marker ?? '—'}</strong>
                </p>
                {nextStep ? (
                  <button
                    type="button"
                    className="sun-action"
                    data-step={nextStep}
                    disabled={busy}
                    onClick={() => void runStep(nextStep)}
                  >
                    {STEP_LABEL[nextStep]}
                  </button>
                ) : (
                  <p className="sun-cleared">Incident cleared.</p>
                )}
                {actionError && <p className="sun-err">{actionError}</p>}
              </>
            ) : (
              <p className="sun-standby">STANDING BY</p>
            )}
          </section>

          <section className="sun-section sun-history" aria-labelledby="hist-heading">
            <h2 id="hist-heading" className="sun-section-title">
              INCIDENT HISTORY
            </h2>
            {history.length === 0 ? (
              <p className="sun-hist-empty">No history yet.</p>
            ) : (
              <ul className="sun-hist-list">
                {history.map((h) => (
                  <li key={h.id} className="sun-hist-row">
                    <span className="sun-hist-type">{h.incident_type}</span>
                    <span className="sun-hist-date">{new Date(h.created_at).toLocaleString()}</span>
                    <span className="sun-hist-st">{h.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>
      )}

      <footer className="sun-footer">
        <button type="button" className="sun-logout" onClick={logout}>
          Log out
        </button>
      </footer>
    </div>
  )
}
