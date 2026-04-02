import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { apiUrl } from './api'

const DEFAULT_CORRIDOR = String(import.meta.env.VITE_CORRIDOR_ID ?? '').trim()

type CorridorOption = { id: string; name: string }

function readCorridorsFromEnv(): CorridorOption[] | null {
  const raw = import.meta.env.VITE_PUBLIC_CORRIDORS_JSON as string | undefined
  if (!raw?.trim()) return null
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return null
    const out: CorridorOption[] = []
    for (const item of data) {
      if (!item || typeof item !== 'object') continue
      const id = 'id' in item ? String((item as { id: unknown }).id) : ''
      const name = 'name' in item ? String((item as { name: unknown }).name) : ''
      if (id) out.push({ id, name: name || id })
    }
    return out.length ? out : null
  } catch {
    return null
  }
}

async function fetchCorridorOptions(): Promise<{ rows: CorridorOption[]; error: string | null }> {
  const envRows = readCorridorsFromEnv()
  let lastStatus = 0
  for (const path of ['/public/corridors', '/corridors/public']) {
    try {
      const r = await fetch(apiUrl(path))
      lastStatus = r.status
      if (!r.ok) continue
      const data = (await r.json()) as unknown
      if (!Array.isArray(data)) continue
      const rows: CorridorOption[] = []
      for (const x of data) {
        if (!x || typeof x !== 'object' || !('id' in x)) continue
        const id = String((x as { id: unknown }).id)
        const name = 'name' in x ? String((x as { name: unknown }).name) : id
        if (id) rows.push({ id, name })
      }
      return { rows, error: rows.length ? null : 'No highways are available yet.' }
    } catch {
      continue
    }
  }
  if (envRows?.length) return { rows: envRows, error: null }
  const hint =
    lastStatus === 404
      ? ' Update the REACH API (deploy latest backend) so /api/public/corridors is available.'
      : ''
  return {
    rows: [],
    error: `Could not load highways.${hint} You can set VITE_PUBLIC_CORRIDORS_JSON on the web app as a temporary list.`,
  }
}

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

/** Full-width tap targets; native select controls are unreliable on many mobile browsers. */
function HighwayButtonList({
  corridors,
  selectedId,
  onSelect,
  disabled,
}: {
  corridors: CorridorOption[]
  selectedId: string
  onSelect: (id: string) => void
  disabled?: boolean
}) {
  if (!corridors.length) {
    return (
      <p className="sos-hw-empty">
        {disabled ? 'Loading highways…' : 'No highways returned. Use “Reload highway list” above.'}
      </p>
    )
  }
  return (
    <div className="sos-hw-list" role="group" aria-label="Choose highway">
      {corridors.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`sos-hw-item ${selectedId === c.id ? 'selected' : ''}`}
          disabled={disabled}
          onClick={() => onSelect(c.id)}
        >
          <span className="sos-hw-name">{c.name}</span>
          {selectedId === c.id ? (
            <span className="sos-hw-check" aria-hidden="true">
              ✓
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

export default function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const corridorFromUrl = (params.get('corridor') || '').trim()

  const [phase, setPhase] = useState<Phase>('landing')
  const [corridorId, setCorridorId] = useState(corridorFromUrl || DEFAULT_CORRIDOR)
  const [corridors, setCorridors] = useState<CorridorOption[]>([])
  const [corridorsError, setCorridorsError] = useState<string | null>(null)
  const [corridorsLoading, setCorridorsLoading] = useState(false)
  const [corridorsRetryKey, setCorridorsRetryKey] = useState(0)

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
    setCorridorsLoading(true)
    ;(async () => {
      const { rows, error } = await fetchCorridorOptions()
      if (cancelled) return
      setCorridors(rows)
      setCorridorsError(error)
      setCorridorsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [phase, corridorsRetryKey])

  useEffect(() => {
    if (phase !== 'form') return
    if (!corridors.length || !corridorId) return
    const ok = corridors.some((c) => c.id === corridorId)
    if (!ok) setCorridorId('')
  }, [phase, corridors, corridorId])

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
                {corridorsLoading && <p className="sos-warn">Loading highways…</p>}
                {corridorsError && !corridorsLoading && <p className="sos-warn">{corridorsError}</p>}
                {!corridorsLoading && (corridorsError || corridors.length === 0) && (
                  <button
                    type="button"
                    className="sos-retry-hw"
                    onClick={() => setCorridorsRetryKey((k) => k + 1)}
                  >
                    Reload highway list
                  </button>
                )}
                <p className="sos-hw-prompt">Highway — tap the one you are on</p>
                <HighwayButtonList
                  corridors={corridors}
                  selectedId={corridorId}
                  onSelect={setCorridorId}
                  disabled={corridorsLoading}
                />
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
              <>
                {corridorsLoading && <p className="sos-warn">Loading highways…</p>}
                {corridorsError && !corridorsLoading && <p className="sos-warn">{corridorsError}</p>}
                {!corridorsLoading && (corridorsError || corridors.length === 0) && (
                  <button
                    type="button"
                    className="sos-retry-hw"
                    onClick={() => setCorridorsRetryKey((k) => k + 1)}
                  >
                    Reload highway list
                  </button>
                )}
                <p className="sos-hw-prompt">Which highway are you on? Tap below.</p>
                <HighwayButtonList
                  corridors={corridors}
                  selectedId={corridorId}
                  onSelect={setCorridorId}
                  disabled={corridorsLoading}
                />
              </>
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
