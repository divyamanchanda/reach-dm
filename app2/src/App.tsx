import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { apiUrl, uploadPublicPhoto } from './api'
import {
  CRASH_COUNTDOWN_SEC,
  readCrashDetectionEnabled,
  writeCrashDetectionEnabled,
} from './crashDetection'
import {
  enqueuePending,
  loadPending,
  QUEUE_MAX_AGE_MS,
  savePending,
  type PendingSosPayload,
} from './sosOfflineQueue'
import { useCrashDetection } from './useCrashDetection'
import { useNetworkConnectivity } from './useNetworkConnectivity'

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

const HAZARD_OPTIONS = [
  { id: 'fire_smoke', label: '🔥 Fire/smoke' },
  { id: 'fuel_spill', label: '💧 Fuel spill' },
  { id: 'live_wire', label: '⚡ Live wire down' },
  { id: 'lane_blocked', label: '🚧 Lane blocked' },
  { id: 'none_visible', label: 'None visible' },
] as const

type Phase = 'landing' | 'form' | 'done' | 'offline_saved'
type LocState = 'pending' | 'ok' | 'fail'

/** Full-width tap targets — large label text; selected = red highlight + check (not checkbox UI). */
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
    <div className="sos-hw-list" role="radiogroup" aria-label="Choose highway">
      {corridors.map((c) => {
        const selected = selectedId === c.id
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`sos-hw-btn ${selected ? 'sos-hw-btn--selected' : ''}`}
            disabled={disabled}
            onClick={() => onSelect(c.id)}
          >
            <span className="sos-hw-btn-label">{c.name}</span>
            {selected ? (
              <span className="sos-hw-btn-check" aria-hidden="true">
                ✓
              </span>
            ) : (
              <span className="sos-hw-btn-spacer" aria-hidden="true" />
            )}
          </button>
        )
      })}
    </div>
  )
}

function HighwayDetectedLine({ name }: { name: string }) {
  return (
    <p className="sos-hw-detected">
      <span className="sos-hw-detected-prefix">Highway:</span> {name}
    </p>
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
  const [injuredCount, setInjuredCount] = useState(0)
  const [skippedMilestone, setSkippedMilestone] = useState(false)
  const [direction, setDirection] = useState<'towards_chennai' | 'towards_bengaluru' | null>(null)
  const [hazards, setHazards] = useState<string[]>([])
  const [vehiclesInvolved, setVehiclesInvolved] = useState(1)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null)

  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null)
  const [locState, setLocState] = useState<LocState>('pending')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PublicResponse | null>(null)
  const [deliveredBanner, setDeliveredBanner] = useState<string | null>(null)
  const [queueVersion, setQueueVersion] = useState(0)

  const [crashDetectionEnabled, setCrashDetectionEnabled] = useState(() => readCrashDetectionEnabled())
  const [crashModalOpen, setCrashModalOpen] = useState(false)
  const [crashCountdown, setCrashCountdown] = useState(CRASH_COUNTDOWN_SEC)
  const [crashBusy, setCrashBusy] = useState(false)
  const crashAutoSentRef = useRef(false)
  const crashSendingRef = useRef(false)

  const { isConnected } = useNetworkConnectivity()

  const openCrashModal = useCallback(() => {
    crashAutoSentRef.current = false
    setCrashCountdown(CRASH_COUNTDOWN_SEC)
    setCrashModalOpen(true)
  }, [])

  const { permissionUi, isListening, requestPermissionFromGesture } = useCrashDetection({
    enabled: crashDetectionEnabled,
    suspended: crashModalOpen,
    onImpact: openCrashModal,
  })

  const pendingCount = useMemo(() => {
    const now = Date.now()
    return loadPending().filter((p) => now - p.queuedAt <= QUEUE_MAX_AGE_MS).length
  }, [queueVersion, isConnected])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.includes('reach_sos')) setQueueVersion((v) => v + 1)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    if (!isConnected) return
    let cancelled = false

    const flushQueue = async () => {
      const now = Date.now()
      let items = loadPending().filter((p) => now - p.queuedAt <= QUEUE_MAX_AGE_MS)
      savePending(items)
      if (items.length === 0) return

      const remaining: typeof items = []
      let lastOk: PublicResponse | null = null
      let sent = 0

      for (const item of items) {
        if (cancelled) return
        try {
          const r = await fetch(apiUrl(`/corridors/${item.corridorId}/incidents/public`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item.body),
          })
          if (r.ok) {
            lastOk = (await r.json()) as PublicResponse
            sent += 1
          } else {
            remaining.push(item)
          }
        } catch {
          remaining.push(item)
        }
      }

      savePending(remaining)
      setQueueVersion((v) => v + 1)

      if (sent === 0) return

      setDeliveredBanner(
        sent === 1 ? '✅ Your report was sent successfully' : '✅ Your reports were sent successfully',
      )
      window.setTimeout(() => setDeliveredBanner(null), 12_000)

      if (remaining.length > 0) return

      if (sent === 1 && lastOk) {
        setResult(lastOk)
        setPhase('done')
      } else if (sent > 1) {
        setPhase('landing')
      }
    }

    void flushQueue()
    const id = window.setInterval(() => void flushQueue(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [isConnected])

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
    setInjuredCount(0)
    setSkippedMilestone(false)
    setDirection(null)
    setHazards([])
    setVehiclesInvolved(1)
    setPhotoFile(null)
    setPhotoPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
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
  const soleCorridor = corridors.length === 1 ? corridors[0] : null
  const soleHighwayResolved =
    Boolean(soleCorridor && corridorId === soleCorridor.id && !corridorsLoading)
  const needsHighwayWhenGps =
    phase === 'form' &&
    locState === 'ok' &&
    !corridorFromUrl &&
    !DEFAULT_CORRIDOR &&
    corridors.length > 1
  const showManualLocation = phase === 'form' && locState === 'fail'
  const showMultiHighwayPicker =
    !corridorsLoading && corridors.length > 1 && (showManualLocation || needsHighwayWhenGps)

  const kmNum = kmMarker.trim() === '' ? null : Number(kmMarker.trim())
  const kmValid = kmNum != null && Number.isFinite(kmNum)
  const showManualExtras =
    phase === 'form' && showManualLocation && (kmValid || skippedMilestone)

  const toggleHazard = (id: string) => {
    if (id === 'none_visible') {
      setHazards(['none_visible'])
      return
    }
    setHazards((prev) => {
      const base = prev.filter((x) => x !== 'none_visible')
      if (base.includes(id)) return base.filter((x) => x !== id)
      return [...base, id]
    })
  }

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

    if (!isConnected && photoFile) {
      setError('Connect to the internet to send a photo with your report.')
      return
    }

    const injured = Math.max(0, Math.min(99, Math.floor(Number(injuredCount)) || 0))
    const vehicles = Math.max(0, Math.min(99, Math.floor(Number(vehiclesInvolved)) || 1))

    let photo_url: string | undefined
    if (photoFile) {
      try {
        photo_url = await uploadPublicPhoto(photoFile)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Photo upload failed')
        return
      }
    }

    const payloadBody: PendingSosPayload = {
      incident_type: incidentType,
      severity,
      injured_count: injured,
      vehicles_involved: showManualExtras ? vehicles : 1,
      hazards: showManualExtras ? [...hazards] : [],
      notes: notes.trim() || undefined,
      latitude: gpsOk ? geo!.lat : undefined,
      longitude: gpsOk ? geo!.lng : undefined,
    }
    if (showManualExtras && direction) {
      payloadBody.direction = direction
    }
    if (kmValid) {
      payloadBody.km_marker = kmNum!
    }
    if (photo_url) {
      payloadBody.photo_url = photo_url
    }

    if (!isConnected) {
      setBusy(true)
      try {
        enqueuePending(effectiveCorridor, payloadBody)
        setQueueVersion((v) => v + 1)
        setPhase('offline_saved')
      } finally {
        setBusy(false)
      }
      return
    }

    setBusy(true)
    try {
      const r = await fetch(apiUrl(`/corridors/${effectiveCorridor}/incidents/public`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadBody),
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

  const sendAutoCrashSos = useCallback(async () => {
    if (crashSendingRef.current) return
    crashSendingRef.current = true
    setCrashModalOpen(false)
    setCrashBusy(true)
    setError(null)
    try {
      const pos = await new Promise<GeolocationPosition | null>((resolve) => {
        if (!navigator.geolocation) {
          resolve(null)
          return
        }
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(p),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 18_000, maximumAge: 0 },
        )
      })
      const lat = pos?.coords.latitude
      const lng = pos?.coords.longitude
      const gpsOk = lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)

      const { rows } = await fetchCorridorOptions()
      const effectiveCorridor =
        corridorFromUrl ||
        DEFAULT_CORRIDOR ||
        (rows.length === 1 ? rows[0].id : '') ||
        rows[0]?.id ||
        ''

      if (!effectiveCorridor) {
        setError('Could not determine highway for auto SOS. Enable location and try a manual report.')
        setPhase('landing')
        return
      }

      const payloadBody: PendingSosPayload = {
        incident_type: 'accident',
        severity: 'critical',
        injured_count: 0,
        vehicles_involved: 1,
        hazards: [],
        notes: 'Auto-detected crash — no user response',
        latitude: gpsOk ? lat : undefined,
        longitude: gpsOk ? lng : undefined,
      }

      if (!isConnected) {
        enqueuePending(effectiveCorridor, payloadBody)
        setQueueVersion((v) => v + 1)
        setPhase('offline_saved')
        return
      }

      const r = await fetch(apiUrl(`/corridors/${effectiveCorridor}/incidents/public`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadBody),
      })
      if (!r.ok) {
        const t = await r.text()
        throw new Error(t || 'Could not send report')
      }
      const data = (await r.json()) as PublicResponse
      setResult(data)
      setPhase('done')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Auto SOS failed')
      setPhase('landing')
    } finally {
      setCrashBusy(false)
      crashSendingRef.current = false
    }
  }, [corridorFromUrl, isConnected])

  useEffect(() => {
    if (!crashModalOpen) return
    if (crashCountdown <= 0) {
      if (!crashAutoSentRef.current) {
        crashAutoSentRef.current = true
        void sendAutoCrashSos()
      }
      return
    }
    const t = window.setTimeout(() => setCrashCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [crashModalOpen, crashCountdown, sendAutoCrashSos])

  const cancelCrashModal = () => {
    crashAutoSentRef.current = true
    setCrashModalOpen(false)
  }

  const confirmSendCrashSosNow = () => {
    crashAutoSentRef.current = true
    void sendAutoCrashSos()
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
    <div className={`sos-app ${deliveredBanner ? 'sos-app--delivered' : ''}`}>
      <div
        className={`sos-net-banner ${isConnected ? 'sos-net-banner--ok' : 'sos-net-banner--bad'}`}
        role="status"
        aria-live="polite"
      >
        {isConnected
          ? '🟢 Connected — SOS will send instantly'
          : '🔴 Offline — app works; reports save and send when you get signal'}
      </div>
      {deliveredBanner ? (
        <div className="sos-delivered-banner" role="status">
          {deliveredBanner}
        </div>
      ) : null}
      {phase === 'landing' && (
        <div className="sos-landing">
          {crashDetectionEnabled && permissionUi === 'needs_gesture' ? (
            <div className="sos-motion-prompt">
              <p className="sos-motion-prompt-text">Crash detection needs motion sensor access.</p>
              <button type="button" className="sos-motion-prompt-btn" onClick={() => void requestPermissionFromGesture()}>
                Enable motion sensors
              </button>
            </div>
          ) : null}
          <button type="button" className="sos-mega" onClick={beginReport}>
            <span className="sos-mega-label">Emergency on highway?</span>
            <span className="sos-mega-action">Tap to report</span>
          </button>
          <details className="sos-settings">
            <summary className="sos-settings-summary">Settings</summary>
            <label className="sos-settings-row">
              <input
                type="checkbox"
                checked={crashDetectionEnabled}
                onChange={(e) => {
                  const on = e.target.checked
                  writeCrashDetectionEnabled(on)
                  setCrashDetectionEnabled(on)
                }}
              />
              <span>Crash detection (accelerometer)</span>
            </label>
            {permissionUi === 'denied' ? (
              <p className="sos-settings-hint">Motion permission denied — enable it in browser settings to use crash detection.</p>
            ) : null}
            {permissionUi === 'unsupported' ? (
              <p className="sos-settings-hint">Motion sensors not available in this browser.</p>
            ) : null}
          </details>
        </div>
      )}

      {phase === 'form' && (
        <form className="sos-form" onSubmit={submit}>
          {crashDetectionEnabled && permissionUi === 'needs_gesture' ? (
            <div className="sos-motion-prompt sos-motion-prompt--inline">
              <p className="sos-motion-prompt-text">Enable motion sensors for crash detection.</p>
              <button type="button" className="sos-motion-prompt-btn" onClick={() => void requestPermissionFromGesture()}>
                Enable motion sensors
              </button>
            </div>
          ) : null}
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
            <label className="sos-injured-label" htmlFor="sos-injured">
              People injured <span className="optional">(estimate)</span>
            </label>
            <input
              id="sos-injured"
              type="number"
              className="sos-injured-input"
              min={0}
              max={99}
              value={injuredCount}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isNaN(n)) {
                  setInjuredCount(0)
                  return
                }
                setInjuredCount(Math.max(0, Math.min(99, Math.floor(n))))
              }}
              inputMode="numeric"
            />
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
              <>
                <p className="loc-ok" role="status">
                  <span className="loc-check" aria-hidden="true">
                    ✓
                  </span>
                  Location captured
                </p>
                {soleHighwayResolved && soleCorridor ? (
                  <HighwayDetectedLine name={soleCorridor.name} />
                ) : null}
              </>
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
                {soleHighwayResolved && soleCorridor ? (
                  <HighwayDetectedLine name={soleCorridor.name} />
                ) : null}
                {showMultiHighwayPicker ? (
                  <>
                    <p className="sos-hw-prompt">Highway — tap the one you are on</p>
                    <HighwayButtonList
                      corridors={corridors}
                      selectedId={corridorId}
                      onSelect={setCorridorId}
                      disabled={corridorsLoading}
                    />
                  </>
                ) : null}
                <label className="sos-km-label">
                  <span className="sos-km-label-text">Nearest milestone stone (optional)</span>
                  <span className="sos-km-hint">If you can&apos;t see one, skip this</span>
                  <input
                    type="number"
                    className="sos-km-input"
                    value={kmMarker}
                    onChange={(e) => {
                      setKmMarker(e.target.value)
                      setSkippedMilestone(false)
                    }}
                    placeholder="e.g. 142"
                    min={0}
                    step="any"
                    inputMode="decimal"
                  />
                </label>
                <button
                  type="button"
                  className="sos-skip-milestone"
                  onClick={() => {
                    setSkippedMilestone(true)
                    setKmMarker('')
                  }}
                >
                  Can&apos;t see a milestone — skip
                </button>
                {showManualExtras ? (
                  <div className="sos-manual-extras">
                    <div className="sos-subsection">
                      <p className="sos-field-label" id="sos-dir-label">
                        Which direction were you heading?
                      </p>
                      <div className="sos-dir-row" role="group" aria-labelledby="sos-dir-label">
                        <button
                          type="button"
                          className={`sos-dir-btn ${direction === 'towards_chennai' ? 'sos-dir-btn--selected' : ''}`}
                          onClick={() => setDirection('towards_chennai')}
                        >
                          ⬆️ Towards Chennai
                        </button>
                        <button
                          type="button"
                          className={`sos-dir-btn ${direction === 'towards_bengaluru' ? 'sos-dir-btn--selected' : ''}`}
                          onClick={() => setDirection('towards_bengaluru')}
                        >
                          ⬇️ Towards Bengaluru
                        </button>
                      </div>
                    </div>
                    <div className="sos-subsection">
                      <p className="sos-field-label" id="sos-hazards-label">
                        Any hazards visible? (select all that apply)
                      </p>
                      <div className="sos-hazard-list" role="group" aria-labelledby="sos-hazards-label">
                        {HAZARD_OPTIONS.map((h) => (
                          <label key={h.id} className="sos-hazard-item">
                            <input
                              type="checkbox"
                              checked={hazards.includes(h.id)}
                              onChange={() => toggleHazard(h.id)}
                            />
                            <span>{h.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="sos-subsection">
                      <p className="sos-field-label">Photo of the scene (optional but very helpful)</p>
                      <p className="sos-km-hint">A photo helps dispatchers verify and prioritize</p>
                      <label className="sos-photo-upload">
                        <input
                          type="file"
                          accept="image/*"
                          className="sos-photo-input"
                          onChange={(e) => {
                            const f = e.target.files?.[0]
                            if (!f || !f.type.startsWith('image/')) return
                            setPhotoFile(f)
                            setPhotoPreviewUrl((prev) => {
                              if (prev) URL.revokeObjectURL(prev)
                              return URL.createObjectURL(f)
                            })
                          }}
                        />
                        <span className="sos-photo-upload-btn">📷 Add photo</span>
                      </label>
                      {photoPreviewUrl ? (
                        <div className="sos-photo-preview-wrap">
                          <img src={photoPreviewUrl} alt="" className="sos-photo-preview" />
                          <button
                            type="button"
                            className="sos-photo-remove"
                            onClick={() => {
                              setPhotoFile(null)
                              setPhotoPreviewUrl((prev) => {
                                if (prev) URL.revokeObjectURL(prev)
                                return null
                              })
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <div className="sos-subsection">
                      <label className="sos-injured-label" htmlFor="sos-vehicles">
                        Vehicles involved
                      </label>
                      <input
                        id="sos-vehicles"
                        type="number"
                        className="sos-injured-input"
                        min={0}
                        max={99}
                        value={vehiclesInvolved}
                        onChange={(e) => {
                          const n = Number(e.target.value)
                          if (Number.isNaN(n)) {
                            setVehiclesInvolved(1)
                            return
                          }
                          setVehiclesInvolved(Math.max(0, Math.min(99, Math.floor(n))))
                        }}
                        inputMode="numeric"
                      />
                    </div>
                  </div>
                ) : null}
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
                {showMultiHighwayPicker ? (
                  <>
                    <p className="sos-hw-prompt">Which highway are you on? Tap yours below.</p>
                    <HighwayButtonList
                      corridors={corridors}
                      selectedId={corridorId}
                      onSelect={setCorridorId}
                      disabled={corridorsLoading}
                    />
                  </>
                ) : null}
              </>
            )}
            {locState === 'ok' ? (
              <label className="sos-km-label sos-km-label--spaced">
                <span className="sos-km-label-text">Nearest milestone stone (optional)</span>
                <span className="sos-km-hint">If you can&apos;t see one, skip this</span>
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
            ) : null}
          </div>

          {error && <p className="sos-err">{error}</p>}

          <button
            type="submit"
            className="sos-submit"
            disabled={busy}
            aria-describedby={pendingCount > 0 ? 'sos-pending-reports-badge' : undefined}
          >
            <span className="sos-submit-label">{busy ? 'Sending…' : 'Submit emergency report'}</span>
            {pendingCount > 0 ? (
              <span
                id="sos-pending-reports-badge"
                className="sos-submit-pending-badge"
                role="status"
                title={`${pendingCount} report(s) queued — will send when online`}
              >
                <span className="sos-submit-pending-reports">Pending reports</span>
                <span className="sos-submit-pending-num">{pendingCount}</span>
              </span>
            ) : null}
          </button>
          <details className="sos-settings sos-settings--form">
            <summary className="sos-settings-summary">Settings</summary>
            <label className="sos-settings-row">
              <input
                type="checkbox"
                checked={crashDetectionEnabled}
                onChange={(e) => {
                  const on = e.target.checked
                  writeCrashDetectionEnabled(on)
                  setCrashDetectionEnabled(on)
                }}
              />
              <span>Crash detection (accelerometer)</span>
            </label>
          </details>
        </form>
      )}

      {phase === 'offline_saved' && (
        <div className="sos-offline-saved">
          <p className="sos-offline-saved-lead" role="status">
            📦 Report saved on your device. It will send automatically when you get signal.
          </p>
          <p className="sos-offline-saved-pending">
            {pendingCount} report{pendingCount === 1 ? '' : 's'} pending
          </p>
          <button type="button" className="sos-secondary" onClick={resetToLanding}>
            Back to home
          </button>
        </div>
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

      {crashDetectionEnabled && permissionUi === 'granted' && isListening ? (
        <div className="sos-crash-indicator" role="status">
          Crash detection: ON
        </div>
      ) : null}

      {crashModalOpen ? (
        <div className="sos-crash-overlay" role="alertdialog" aria-modal="true" aria-labelledby="sos-crash-title">
          <div className="sos-crash-card">
            <h2 id="sos-crash-title" className="sos-crash-title">
              🚨 Crash detected — are you OK?
            </h2>
            <p className="sos-crash-countdown">
              Sending SOS in <strong>{crashCountdown}</strong>s if no response
            </p>
            <div className="sos-crash-actions">
              <button type="button" className="sos-crash-btn sos-crash-btn--ok" disabled={crashBusy} onClick={cancelCrashModal}>
                I&apos;M OK — Cancel
              </button>
              <button
                type="button"
                className="sos-crash-btn sos-crash-btn--sos"
                disabled={crashBusy}
                onClick={confirmSendCrashSosNow}
              >
                {crashBusy ? 'Sending…' : 'SEND SOS NOW'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
