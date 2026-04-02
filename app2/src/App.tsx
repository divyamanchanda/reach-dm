import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { apiUrl } from './api'

const DEFAULT_CORRIDOR = import.meta.env.VITE_CORRIDOR_ID || ''

type CorridorOption = { id: string; name: string }

type PublicResponse = {
  incident_id: string
  public_report_id: string
  trust_score: number
  trust_recommendation: string | null
  nearest_ambulance_eta_minutes: number | null
}

const INCIDENT_TYPES = [
  { value: 'accident', label: 'Accident' },
  { value: 'fire', label: 'Fire' },
  { value: 'breakdown', label: 'Breakdown' },
  { value: 'medical_emergency', label: 'Medical Emergency' },
  { value: 'obstacle_on_road', label: 'Obstacle on road' },
] as const

const SEVERITIES = [
  { value: 'critical', label: 'Critical', tone: 'critical' as const },
  { value: 'major', label: 'Major', tone: 'major' as const },
  { value: 'minor', label: 'Minor', tone: 'minor' as const },
]

type Phase = 'landing' | 'form' | 'done'
type LocState = 'pending' | 'ok' | 'fail'

export default function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const corridorFromUrl = params.get('corridor') || ''

  const [phase, setPhase] = useState<Phase>('landing')
  const [corridorId, setCorridorId] = useState(corridorFromUrl || DEFAULT_CORRIDOR)
  const [corridors, setCorridors] = useState<CorridorOption[]>([])
  const [corridorsError, setCorridorsError] = useState<string | null>(null)

  const [incidentType, setIncidentType] = useState<string>(INCIDENT_TYPES[0].value)
  const [severity, setSeverity] = useState<string>('major')
  const [notes, setNotes] = useState('')
  const [kmMarker, setKmMarker] = useState('')

  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null)
  const [locState, setLocState] = useState<LocState>('pending')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PublicResponse | null>(null)

  const startGps = useCallback(() => {
    setGeo(null)
    setLocState('pending')
    if (!navigator.geolocation) {
      setLocState('fail')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setLocState('ok')
      },
      () => setLocState('fail'),
      { enableHighAccuracy: true, timeout: 22000, maximumAge: 0 },
    )
  }, [])

  const beginReport = useCallback(() => {
    setError(null)
    setResult(null)
    setNotes('')
    setKmMarker('')
    setIncidentType(INCIDENT_TYPES[0].value)
    setSeverity('major')
    setCorridorId(corridorFromUrl || DEFAULT_CORRIDOR)
    setPhase('form')
    startGps()
  }, [corridorFromUrl, startGps])

  useEffect(() => {
    if (phase !== 'form') return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(apiUrl('/corridors/public'))
        if (!r.ok) throw new Error('Could not load highways')
        const rows = (await r.json()) as { id: string; name: string }[]
        if (cancelled) return
        setCorridors(rows.map((x) => ({ id: x.id, name: x.name })))
        setCorridorsError(null)
      } catch (e) {
        if (!cancelled) {
          setCorridors([])
          setCorridorsError(e instanceof Error ? e.message : 'Could not load highways')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [phase])

  useEffect(() => {
    if (phase !== 'form') return
    if (corridorId) return
    if (corridors.length !== 1) return
    setCorridorId(corridors[0].id)
  }, [phase, corridorId, corridors])

  const gpsOk = locState === 'ok' && geo != null
  const needsHighwayWhenGps =
    phase === 'form' && locState === 'ok' && !corridorFromUrl && !DEFAULT_CORRIDOR && corridors.length > 1 && !corridorId
  const showManualLocation = phase === 'form' && locState === 'fail'

  const kmNum = kmMarker.trim() === '' ? null : Number(kmMarker.trim())
  const kmValid = kmNum != null && Number.isFinite(kmNum)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const effectiveCorridor =
      corridorId ||
      (corridors.length === 1 ? corridors[0].id : '') ||
      corridorFromUrl ||
      DEFAULT_CORRIDOR

    if (!effectiveCorridor) {
      setError('Choose the highway you are on.')
      return
    }

    if (showManualLocation || needsHighwayWhenGps) {
      if (!corridorId && corridors.length > 1) {
        setError('Choose your highway from the list.')
        return
      }
    }

    if (showManualLocation) {
      if (!kmValid) {
        setError('Enter the number on the nearest green milestone stone.')
        return
      }
    }

    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        incident_type: incidentType,
        severity,
        injured_count: 0,
        notes: notes.trim() || undefined,
        latitude: gpsOk ? geo!.lat : undefined,
        longitude: gpsOk ? geo!.lng : undefined,
      }
      if (showManualLocation && kmValid) {
        payload.km_marker = kmNum
      }

      const r = await fetch(apiUrl(`/corridors/${effectiveCorridor}/incidents/public`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!r.ok) {
        const t = await r.text()
        throw new Error(t || 'Could not send report')
      }

      const data = (await r.json()) as PublicResponse
      setResult(data)
      setPhase('done')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const reportCode = result?.public_report_id ?? ''
  const showReachId = reportCode ? `REACH-${reportCode}` : ''

  const resetToLanding = () => {
    setPhase('landing')
    setResult(null)
    setError(null)
    setGeo(null)
    setLocState('pending')
    setCorridorId(corridorFromUrl || DEFAULT_CORRIDOR)
  }

  return (
    <div className="sos-app">
      {phase === 'landing' && (
        <div className="sos-landing">
          <button type="button" className="sos-mega" onClick={beginReport}>
            <span className="sos-mega-label">Emergency on highway?</span>
            <span className="sos-mega-action">Tap to report</span>
          </button>
        </div>
      )}

      {phase === 'form' && (
        <form className="sos-form" onSubmit={submit}>
          <div className="sos-section">
            <h2 className="sos-heading">What happened?</h2>
            <div className="sos-chip-grid" role="group" aria-label="Incident type">
              {INCIDENT_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={`sos-chip type-chip ${incidentType === t.value ? 'selected' : ''}`}
                  onClick={() => setIncidentType(t.value)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="sos-section">
            <h2 className="sos-heading">How serious?</h2>
            <div className="sos-sev-row" role="group" aria-label="Severity">
              {SEVERITIES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className={`sos-sev sos-sev-${s.tone} ${severity === s.value ? 'selected' : ''}`}
                  onClick={() => setSeverity(s.value)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="sos-section">
            <label className="sos-notes-label">
              Anything else? <span className="optional">(optional)</span>
              <textarea
                className="sos-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="e.g. lane blocked, smoke visible…"
                autoComplete="off"
              />
            </label>
          </div>

          <div className="sos-section sos-location-card">
            <h2 className="sos-heading">Location</h2>
            {locState === 'pending' && (
              <p className="loc-pending" role="status">
                <span className="loc-dot" aria-hidden="true" />
                Finding your location…
              </p>
            )}
            {locState === 'ok' && (
              <p className="loc-ok" role="status">
                <span className="loc-check" aria-hidden="true">
                  ✓
                </span>
                Location captured
              </p>
            )}
            {locState === 'fail' && (
              <div className="loc-fallback">
                <p className="loc-bad" role="status">
                  Location not found
                </p>
                {corridorsError && <p className="sos-warn">{corridorsError}</p>}
                <label className="sos-select-label">
                  Highway
                  <select
                    className="sos-select"
                    value={corridorId}
                    onChange={(e) => setCorridorId(e.target.value)}
                    required={showManualLocation}
                  >
                    <option value="">Select highway…</option>
                    {corridors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="sos-km-label">
                  What number is on the nearest green milestone stone?
                  <input
                    type="number"
                    className="sos-km-input"
                    value={kmMarker}
                    onChange={(e) => setKmMarker(e.target.value)}
                    placeholder="e.g. 142"
                    min={0}
                    step="any"
                    inputMode="decimal"
                  />
                </label>
              </div>
            )}
            {needsHighwayWhenGps && (
              <label className="sos-select-label sos-select-tight">
                Which highway are you on?
                <select
                  className="sos-select"
                  value={corridorId}
                  onChange={(e) => setCorridorId(e.target.value)}
                  required
                >
                  <option value="">Select highway…</option>
                  {corridors.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {error && <p className="sos-err">{error}</p>}

          <button
            type="submit"
            className="sos-submit"
            disabled={busy || locState === 'pending'}
          >
            {busy ? 'Sending…' : locState === 'pending' ? 'Getting location…' : 'Submit emergency report'}
          </button>
        </form>
      )}

      {phase === 'done' && result && (
        <div className="sos-done">
          <p className="sos-reach-id">{showReachId}</p>
          <p className="sos-reassure">Help is on the way</p>
          <button type="button" className="sos-secondary" onClick={resetToLanding}>
            Report another emergency
          </button>
          <p className="sos-legal">False reporting is a criminal offence</p>
        </div>
      )}
    </div>
  )
}
