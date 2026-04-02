import { useCallback, useMemo, useState } from 'react'
import './App.css'
import { apiUrl } from './api'

const DEFAULT_CORRIDOR = import.meta.env.VITE_CORRIDOR_ID || ''

const RECOMMENDATION_LABEL: Record<string, string> = {
  patrol_verify_first: 'Patrol to verify first',
  dispatch_immediately: 'Dispatching help now',
  verify_then_dispatch: 'Verify details, then send help',
  monitor_only: 'Situation being monitored',
  dispatch_both: 'A patrol vehicle and ambulance are being dispatched to your location',
}

function friendlyRecommendation(code: string | null): string {
  if (!code) return '—'
  if (RECOMMENDATION_LABEL[code]) return RECOMMENDATION_LABEL[code]
  return code
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

type PublicResponse = {
  incident_id: string
  public_report_id: string
  trust_score: number
  trust_recommendation: string | null
  nearest_ambulance_eta_minutes: number | null
}

export default function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const initialCorridor = params.get('corridor') || DEFAULT_CORRIDOR

  const [corridorId, setCorridorId] = useState(initialCorridor)
  const [incidentType, setIncidentType] = useState('accident')
  const [severity, setSeverity] = useState('major')
  const [injured, setInjured] = useState(0)
  const [notes, setNotes] = useState('')
  const [kmMarker, setKmMarker] = useState('')
  const [landmark, setLandmark] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PublicResponse | null>(null)

  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null)
  const [geoStatus, setGeoStatus] = useState<string>('')

  const captureGps = useCallback(() => {
    setGeoStatus('Locating…')
    if (!navigator.geolocation) {
      setGeoStatus('Geolocation not available')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setGeoStatus('GPS captured')
      },
      () => setGeoStatus('Could not read GPS (optional)'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  }, [])

  const gpsAvailable = geo != null
  const gpsMissing = !gpsAvailable && geoStatus !== '' && geoStatus !== 'GPS captured'

  const kmMarkerNumber = kmMarker.trim() === '' ? null : Number(kmMarker.trim())
  const kmMarkerValid = kmMarkerNumber != null && Number.isFinite(kmMarkerNumber)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setResult(null)

    if (!corridorId) {
      setError('Missing corridor id. Open with ?corridor=<uuid> or set VITE_CORRIDOR_ID.')
      return
    }

    if (gpsMissing) {
      if (!kmMarkerValid) {
        setError('Nearest KM marker is required when GPS is unavailable.')
        return
      }
    }

    setBusy(true)
    try {
      const landmarkTrim = landmark.trim()
      const extraNotes = landmarkTrim ? `Nearest landmark or town: ${landmarkTrim}` : ''
      const composedNotes = [notes.trim(), extraNotes].filter(Boolean).join('\n')

      const r = await fetch(apiUrl(`/corridors/${corridorId}/incidents/public`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incident_type: incidentType,
          severity,
          injured_count: injured,
          notes: composedNotes || undefined,
          latitude: geo?.lat,
          longitude: geo?.lng,
          km_marker: gpsMissing ? kmMarkerNumber : null,
        }),
      })

      if (!r.ok) {
        const t = await r.text()
        throw new Error(t || 'Request failed')
      }

      setResult((await r.json()) as PublicResponse)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sos">
      <header>
        <h1>Emergency SOS</h1>
      </header>

      {result ? (
        <section className="card confirm">
          <h2>Report received</h2>
          <p>
            <strong>Report ID:</strong> REACH-{result.public_report_id.slice(0, 4)}
          </p>
          <p>{friendlyRecommendation(result.trust_recommendation)}</p>
          <button type="button" className="secondary" onClick={() => setResult(null)}>
            Report another
          </button>
          <p className="legal-note">False reporting is a criminal offence.</p>
        </section>
      ) : (
        <form className="card" onSubmit={submit}>
          <label className="corridor">
            Corridor ID
            <input
              value={corridorId}
              onChange={(e) => setCorridorId(e.target.value)}
              placeholder="UUID from QR / seed"
            />
          </label>

          <button type="button" className="sos-big" onClick={captureGps}>
            SOS — capture GPS
          </button>
          <p className="geo">{geoStatus}</p>

          {gpsMissing && corridorId && (
            <div className="gps-fallback">
              <label>
                Nearest KM marker stone (the green stone by the road)
                <div className="km-stone-row">
                  <div className="km-stone-preview" aria-hidden="true">
                    <span className="km-stone-label">KM</span>
                    <span className="km-stone-number">{kmMarker.trim() ? kmMarker : '—'}</span>
                  </div>
                  <input
                    type="number"
                    value={kmMarker}
                    onChange={(e) => setKmMarker(e.target.value)}
                    placeholder="e.g. 142"
                    required
                    min={0}
                    step={0.1}
                    inputMode="decimal"
                  />
                </div>
                <p className="km-helper">
                  Look for the green milestone stone on the roadside — it shows a number like 142.
                </p>
              </label>

              <label>
                Nearest landmark or town (optional)
                <input
                  type="text"
                  value={landmark}
                  onChange={(e) => setLandmark(e.target.value)}
                  placeholder="e.g. Krishnagiri"
                />
              </label>
            </div>
          )}

          <label>
            Type
            <select value={incidentType} onChange={(e) => setIncidentType(e.target.value)}>
              <option value="accident">Accident</option>
              <option value="fire">Fire</option>
              <option value="breakdown">Breakdown</option>
              <option value="medical">Medical</option>
              <option value="other">Other</option>
            </select>
          </label>

          <label>
            Severity
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="critical">Critical</option>
              <option value="major">Major</option>
              <option value="minor">Minor</option>
            </select>
          </label>

          <div className="counter">
            <span>Injured</span>
            <button type="button" onClick={() => setInjured((n) => Math.max(0, n - 1))}>
              −
            </button>
            <strong>{injured}</strong>
            <button type="button" onClick={() => setInjured((n) => n + 1)}>
              +
            </button>
          </div>

          <label>
            Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </label>

          {error && <p className="err">{error}</p>}

          <button type="submit" className="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Submit report'}
          </button>
        </form>
      )}
    </div>
  )
}
