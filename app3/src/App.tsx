import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './App.css'
import { API, patchJson, login, fetchJson, type User } from './api'

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
  trust_recommendation: string | null
  status: string
  injured_count: number
  notes: string | null
  created_at: string
  timeline: { id: string; event_type: string; payload: Record<string, unknown> | null; created_at: string }[]
}

function trustLabel(score: number): string {
  if (score >= 72) return 'High confidence'
  if (score >= 45) return 'Partially verified'
  return 'Unverified'
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
  const [hoaxFullScreen, setHoaxFullScreen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [gpsLost, setGpsLost] = useState(false)
  const hadLocationSuccess = useRef(false)

  const refreshIncident = useCallback(async () => {
    if (!token || !vehicle) return
    try {
      const rows = await fetchJson<IncidentDetail[]>(`/vehicles/${vehicle.id}/incidents`, token)
      const top = rows[0] ?? null
      if (!top) {
        setIncident(null)
        setHoaxFullScreen(false)
        return
      }
      if (top.status === 'recalled') {
        setIncident(null)
        setHoaxFullScreen(true)
        return
      }
      setHoaxFullScreen(false)
      setIncident(top)
    } catch {
      /* keep previous incident; polling will retry */
    }
  }, [token, vehicle])

  useEffect(() => {
    if (!token) {
      setVehicle(null)
      setVehicleLoadError(null)
      setIncident(null)
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
          setVehicleLoadError(
            'No vehicle is assigned to your account. Ask dispatch to link your login to an ambulance.',
          )
          return
        }
        const chosen = [...mine].sort((a, b) => a.label.localeCompare(b.label))[0]
        setVehicle(chosen)
        setVehicleLoadError(null)
      } catch (e: unknown) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : 'Could not load vehicle'
        setVehicle(null)
        setVehicleLoadError(
          /403|forbidden/i.test(msg) ? 'Driver access only. Sign in with a driver account.' : msg,
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (!token || !vehicle) return
    void refreshIncident()
    const id = window.setInterval(() => void refreshIncident(), 5000)
    return () => window.clearInterval(id)
  }, [token, vehicle, refreshIncident])

  useEffect(() => {
    if (!token || !vehicle) return
    const s = io(API, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
    })
    s.on('connect', () => s.emit('subscribe_corridor', { corridor_id: vehicle.corridor_id }))
    const bump = () => void refreshIncident()
    s.on('incident:dispatched', bump)
    s.on('incident:updated', bump)
    s.on('incident:recalled', bump)
    return () => {
      s.emit('unsubscribe_corridor', { corridor_id: vehicle.corridor_id })
      s.disconnect()
    }
  }, [token, vehicle, refreshIncident])

  useEffect(() => {
    if (!token || !vehicle?.id) return
    if (!navigator.geolocation) {
      setGpsLost(true)
      return
    }

    const postLocation = (lat: number, lng: number) => {
      void patchJson(`/vehicles/${vehicle.id}/location`, token, { latitude: lat, longitude: lng }).catch(() => {
        /* network / server — not necessarily GPS drop */
      })
    }

    const tick = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          hadLocationSuccess.current = true
          setGpsLost(false)
          postLocation(pos.coords.latitude, pos.coords.longitude)
        },
        () => {
          if (hadLocationSuccess.current) setGpsLost(true)
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 12_000 },
      )
    }

    tick()
    const interval = window.setInterval(tick, 10_000)
    return () => window.clearInterval(interval)
  }, [token, vehicle])

  const driverDisplayName = useMemo(() => user?.full_name?.trim() || user?.phone || 'Driver', [user])

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
    setHoaxFullScreen(false)
    hadLocationSuccess.current = false
    setGpsLost(false)
  }

  const dismissHoaxOverlay = () => {
    setHoaxFullScreen(false)
    void refreshIncident()
  }

  const runStep = async (step: 'accept' | 'en_route' | 'arrived' | 'clear') => {
    if (!token || !vehicle || !incident || busy) return
    setBusy(true)
    setActionError(null)
    const vid = vehicle.id
    const iid = incident.id
    try {
      if (step === 'accept') {
        await patchJson(`/vehicles/${vid}/status`, token, { status: 'en_route' })
        await patchJson(`/incidents/${iid}/status`, token, { status: 'accepted' })
      } else if (step === 'en_route') {
        await patchJson(`/vehicles/${vid}/status`, token, { status: 'en_route' })
        await patchJson(`/incidents/${iid}/status`, token, { status: 'en_route' })
      } else if (step === 'arrived') {
        await patchJson(`/vehicles/${vid}/status`, token, { status: 'on_scene' })
        await patchJson(`/incidents/${iid}/status`, token, { status: 'on_scene' })
      } else {
        await patchJson(`/incidents/${iid}/status`, token, { status: 'closed' })
        await patchJson(`/vehicles/${vid}/status`, token, { status: 'available' })
      }
      await refreshIncident()
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  if (hoaxFullScreen) {
    return (
      <div className="dc-hoax-overlay" role="alert">
        <div className="dc-hoax-inner">
          <p className="dc-hoax-title">THIS IS A HOAX — Stand Down</p>
          <p className="dc-hoax-sub">Do not proceed to the scene. Return to base and await instructions.</p>
          <button type="button" className="dc-hoax-dismiss" onClick={dismissHoaxOverlay}>
            Acknowledge
          </button>
        </div>
      </div>
    )
  }

  if (!token || !user) {
    return (
      <div className="dc-app">
        <main className="dc-login">
          <h1 className="dc-brand">REACH Driver</h1>
          <form className="dc-card" onSubmit={(e) => void submitLogin(e)}>
            <label className="dc-field">
              <span>Phone</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="username" inputMode="tel" />
            </label>
            <label className="dc-field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            {loginError && <p className="dc-err">{loginError}</p>}
            <button type="submit" className="dc-btn dc-btn-primary">
              Sign in
            </button>
          </form>
        </main>
      </div>
    )
  }

  return (
    <div className="dc-app">
      <header className="dc-topbar">
        <div className="dc-topbar-text">
          <p className="dc-driver-name">{driverDisplayName}</p>
          {vehicle && (
            <>
              <p className="dc-meta">
                <span className="dc-meta-label">Vehicle</span> {vehicle.label}
              </p>
              <p className="dc-meta">
                <span className="dc-meta-label">Corridor</span> {vehicle.corridor_name}
              </p>
            </>
          )}
        </div>
        <button type="button" className="dc-btn-logout" onClick={logout}>
          Log out
        </button>
      </header>

      {gpsLost && (
        <div className="dc-gps-banner" role="status">
          GPS SIGNAL LOST
        </div>
      )}

      {vehicleLoadError && <p className="dc-banner dc-banner-warn">{vehicleLoadError}</p>}

      {vehicle && !vehicleLoadError && (
        <main className="dc-main">
          {incident ? (
            <article className="dc-incident-card">
              <h2 className="dc-incident-type">{incident.incident_type}</h2>
              <p className={`dc-sev dc-sev-${incident.severity}`}>{incident.severity}</p>
              <p className="dc-km">
                KM <strong>{incident.km_marker ?? '—'}</strong>
              </p>
              <p className="dc-trust">{trustLabel(incident.trust_score)}</p>
              {incident.notes?.trim() ? <p className="dc-notes">{incident.notes}</p> : null}

              <div className="dc-actions-row">
                <button type="button" className="dc-act" disabled={busy} onClick={() => void runStep('accept')}>
                  Accept
                </button>
                <button type="button" className="dc-act" disabled={busy} onClick={() => void runStep('en_route')}>
                  En Route
                </button>
                <button type="button" className="dc-act" disabled={busy} onClick={() => void runStep('arrived')}>
                  Arrived
                </button>
                <button type="button" className="dc-act" disabled={busy} onClick={() => void runStep('clear')}>
                  Clear
                </button>
              </div>
              {actionError && <p className="dc-err">{actionError}</p>}
            </article>
          ) : (
            <p className="dc-idle">Standing by — no incident assigned</p>
          )}
        </main>
      )}
    </div>
  )
}
