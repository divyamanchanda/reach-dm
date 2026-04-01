import { useCallback, useEffect, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import './App.css'
import { apiUrl, fetchJson, login, patchJson, postJson, type User } from './api'

type Corridor = {
  id: string
  name: string
}

type Vehicle = {
  id: string
  label: string
  status: string
  vehicle_type: string
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
  injured_count: number
  created_at: string
}

type IncidentDetail = Incident & {
  notes: string | null
  timeline: { id: string; event_type: string; payload: Record<string, unknown> | null; created_at: string }[]
}

function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('reach3_token'))
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem('reach3_user')
    return raw ? JSON.parse(raw) : null
  })
  const [phone, setPhone] = useState('+919876543211')
  const [password, setPassword] = useState('reach2026')
  const [error, setError] = useState<string | null>(null)

  const [corridors, setCorridors] = useState<Corridor[]>([])
  const [corridorId, setCorridorId] = useState<string | null>(null)
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [vehicleId, setVehicleId] = useState<string | null>(() => localStorage.getItem('reach3_vehicle_id'))
  const [assignedIncident, setAssignedIncident] = useState<IncidentDetail | null>(null)
  const [standDownAlert, setStandDownAlert] = useState<string | null>(null)
  const [gpsState, setGpsState] = useState<string>('Idle')
  const [busy, setBusy] = useState(false)
  const [socket, setSocket] = useState<Socket | null>(null)

  const loadAssignedIncident = useCallback(
    async (cid: string, vid: string, t: string) => {
      const incidents = await fetchJson<Incident[]>(`/corridors/${cid}/incidents`, t)
      const details = await Promise.all(incidents.map((inc) => fetchJson<IncidentDetail>(`/incidents/${inc.id}`, t)))
      const mine = details
        .filter((inc) =>
          inc.timeline.some(
            (ev) =>
              ev.event_type === 'dispatched' &&
              ev.payload &&
              String(ev.payload.vehicle_id ?? '') === vid,
          ),
        )
        .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
      const recalled = mine.find((inc) => inc.status === 'recalled')
      if (recalled) {
        setStandDownAlert('STAND DOWN — Incident recalled as hoax. Return to base.')
        setAssignedIncident(null)
        return
      }
      setStandDownAlert(null)
      setAssignedIncident(mine[0] ?? null)
    },
    [],
  )

  useEffect(() => {
    if (!token) return
    fetchJson<Corridor[]>('/corridors', token)
      .then((items) => {
        setCorridors(items)
        setCorridorId((prev) => prev ?? items[0]?.id ?? null)
      })
      .catch((e) => setError(String(e)))
  }, [token])

  useEffect(() => {
    if (!token || !corridorId) return
    fetchJson<Vehicle[]>(`/corridors/${corridorId}/vehicles`, token)
      .then((items) => {
        const ambulances = items.filter((v) => v.vehicle_type === 'ambulance')
        setVehicles(ambulances)
        setVehicleId((prev) => prev ?? ambulances[0]?.id ?? null)
      })
      .catch((e) => setError(String(e)))
  }, [token, corridorId])

  useEffect(() => {
    if (!token || !corridorId || !vehicleId) return
    const s = io(import.meta.env.VITE_API_URL || 'http://localhost:8000', {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket', 'polling'],
    })
    s.on('connect', () => {
      s.emit('subscribe_corridor', { corridor_id: corridorId })
    })
    const bump = () => {
      fetchJson<Vehicle[]>(`/corridors/${corridorId}/vehicles`, token)
        .then((items) => setVehicles(items.filter((v) => v.vehicle_type === 'ambulance')))
        .catch(() => {})
      loadAssignedIncident(corridorId, vehicleId, token).catch(() => {})
    }
    s.on('incident:new', bump)
    s.on('incident:updated', bump)
    s.on('incident:dispatched', bump)
    s.on('incident:recalled', bump)
    s.on('vehicle:status', bump)
    s.on('vehicle:location', bump)
    setSocket(s)
    return () => {
      s.emit('unsubscribe_corridor', { corridor_id: corridorId })
      s.disconnect()
      setSocket(null)
    }
  }, [token, corridorId, vehicleId, loadAssignedIncident])

  useEffect(() => {
    if (!vehicleId) return
    localStorage.setItem('reach3_vehicle_id', vehicleId)
  }, [vehicleId])

  useEffect(() => {
    if (!token || !corridorId || !vehicleId) {
      setAssignedIncident(null)
      return
    }
    loadAssignedIncident(corridorId, vehicleId, token).catch((e) => setError(String(e)))
    const timer = window.setInterval(() => {
      loadAssignedIncident(corridorId, vehicleId, token).catch(() => {})
    }, 10000)
    return () => window.clearInterval(timer)
  }, [token, corridorId, vehicleId, loadAssignedIncident])

  useEffect(() => {
    if (!token || !vehicleId || !navigator.geolocation) return
    const sendLocation = () => {
      setGpsState('Requesting GPS...')
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            await patchJson(`/vehicles/${vehicleId}/location`, token, {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
            })
            setGpsState(`Last sent: ${new Date().toLocaleTimeString()}`)
          } catch {
            setGpsState('GPS send failed')
          }
        },
        () => setGpsState('GPS permission denied/unavailable'),
        { enableHighAccuracy: true, timeout: 8000 },
      )
    }
    sendLocation()
    const timer = window.setInterval(sendLocation, 10000)
    return () => window.clearInterval(timer)
  }, [token, vehicleId])

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      const res = await login(phone, password)
      localStorage.setItem('reach3_token', res.access_token)
      localStorage.setItem('reach3_user', JSON.stringify(res.user))
      setToken(res.access_token)
      setUser(res.user)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed')
    }
  }

  const logout = () => {
    localStorage.removeItem('reach3_token')
    localStorage.removeItem('reach3_user')
    setToken(null)
    setUser(null)
    socket?.disconnect()
  }

  const runStep = async (step: 'accept' | 'en_route' | 'arrived' | 'clear') => {
    if (!token || !vehicleId || !assignedIncident || busy) return
    setBusy(true)
    setError(null)
    try {
      if (step === 'accept') {
        await patchJson(`/vehicles/${vehicleId}/status`, token, { status: 'en_route' })
        await patchJson(`/incidents/${assignedIncident.id}/status`, token, { status: 'accepted' })
      } else if (step === 'en_route') {
        await patchJson(`/vehicles/${vehicleId}/status`, token, { status: 'en_route' })
        await patchJson(`/incidents/${assignedIncident.id}/status`, token, { status: 'en_route' })
      } else if (step === 'arrived') {
        await patchJson(`/vehicles/${vehicleId}/status`, token, { status: 'on_scene' })
        await patchJson(`/incidents/${assignedIncident.id}/status`, token, { status: 'on_scene' })
      } else {
        await patchJson(`/incidents/${assignedIncident.id}/status`, token, { status: 'closed' })
        await patchJson(`/vehicles/${vehicleId}/status`, token, { status: 'available' })
      }
      if (corridorId) await loadAssignedIncident(corridorId, vehicleId, token)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed updating status')
    } finally {
      setBusy(false)
    }
  }

  const verifyIncident = async (isReal: boolean) => {
    if (!token || !assignedIncident || busy) return
    setBusy(true)
    setError(null)
    try {
      if (isReal) {
        await postJson(`/incidents/${assignedIncident.id}/verify`, token, {
          trust_score: 80,
          status: 'confirmed_real',
        })
      } else {
        await postJson(`/incidents/${assignedIncident.id}/recall`, token, {})
      }
      if (corridorId && vehicleId) await loadAssignedIncident(corridorId, vehicleId, token)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to verify incident')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      {!token || !user ? (
        <main className="login">
          <form className="card" onSubmit={doLogin}>
            <h1>REACH Driver</h1>
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
            <button type="submit">Log in</button>
          </form>
        </main>
      ) : (
        <main className="app">
          <header className="top">
            <h1>Driver Console</h1>
            <button onClick={logout}>Log out</button>
          </header>
          <section className="card">
            <p className="muted">Signed in as {user.full_name ?? user.phone}</p>
            <label>
              Corridor
              <select value={corridorId ?? ''} onChange={(e) => setCorridorId(e.target.value)}>
                {corridors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Vehicle
              <select value={vehicleId ?? ''} onChange={(e) => setVehicleId(e.target.value)}>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} ({v.status})
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">GPS: {gpsState}</p>
          </section>

          <section className="card">
            <h2>Assigned Incident</h2>
            {standDownAlert && <div className="stand-down">{standDownAlert}</div>}
            {!assignedIncident && <p className="muted">No incident currently dispatched to this vehicle.</p>}
            {assignedIncident && (
              <>
                <p>
                  <strong>{assignedIncident.incident_type}</strong> ({assignedIncident.severity})
                </p>
                <p>Status: {assignedIncident.status}</p>
                <p>KM: {assignedIncident.km_marker ?? '—'}</p>
                <p>
                  Location: {assignedIncident.latitude ?? '—'}, {assignedIncident.longitude ?? '—'}
                </p>
                <p>Injured: {assignedIncident.injured_count}</p>
                <p>Notes: {assignedIncident.notes?.trim() ? assignedIncident.notes : '—'}</p>
                <h3>Verify Incident</h3>
                <div className="actions">
                  <button disabled={busy} onClick={() => void verifyIncident(true)}>
                    Confirmed Real ✓
                  </button>
                  <button className="danger-btn" disabled={busy} onClick={() => void verifyIncident(false)}>
                    Mark as Hoax ✗
                  </button>
                </div>
                <div className="actions">
                  <button disabled={busy} onClick={() => void runStep('accept')}>
                    Accept
                  </button>
                  <button disabled={busy} onClick={() => void runStep('en_route')}>
                    En Route
                  </button>
                  <button disabled={busy} onClick={() => void runStep('arrived')}>
                    Arrived
                  </button>
                  <button disabled={busy} onClick={() => void runStep('clear')}>
                    Clear
                  </button>
                </div>
              </>
            )}
            {error && <p className="err">{error}</p>}
          </section>
          <footer className="muted">API: {apiUrl('/health')}</footer>
        </main>
      )}
    </div>
  )
}

export default App
