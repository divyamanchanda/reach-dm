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

type CorridorOption = { id: string; name: string }
type CorridorDetectResponse = {
  corridor_id: string
  corridor_name: string
  confidence: number
  method: 'gps_polyline' | 'km_range'
  matches?: { corridor_id: string; corridor_name: string }[]
}

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
  try {
    const r = await fetch(apiUrl('/public/corridors'))
    lastStatus = r.status
    if (r.ok) {
      const data = (await r.json()) as unknown
      if (Array.isArray(data)) {
        const rows: CorridorOption[] = []
        for (const x of data) {
          if (!x || typeof x !== 'object' || !('id' in x)) continue
          const id = String((x as { id: unknown }).id)
          const name = 'name' in x ? String((x as { name: unknown }).name) : id
          if (id) rows.push({ id, name })
        }
        if (rows.length) return { rows, error: null }
      }
    }
  } catch {
    /* fall through */
  }
  if (envRows?.length) return { rows: envRows, error: null }
  const hint =
    lastStatus === 404
      ? ' Update the REACH API so GET /api/public/corridors is available.'
      : ''
  return {
    rows: [],
    error: `Could not load highways.${hint} You can set VITE_PUBLIC_CORRIDORS_JSON as a temporary dev list.`,
  }
}

type PublicResponse = {
  incident_id: string
  public_report_id: string
  trust_score: number
  trust_recommendation: string | null
  nearest_ambulance_eta_minutes: number | null
}

const GPS_TIMEOUT_MS = 10_000
const HW_DETECT_FAIL_MSG = '\u26A0\uFE0F Could not detect highway — please select manually'

function getGpsPosition(timeoutMs: number): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null)
      return
    }
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, timeoutMs)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          resolve(null)
          return
        }
        resolve({ lat, lng })
      },
      () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        resolve(null)
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    )
  })
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

export default function App() {
  const [phase, setPhase] = useState<Phase>('landing')
  const [corridorId, setCorridorId] = useState('')
  const [corridors, setCorridors] = useState<CorridorOption[]>([])
  const [corridorsError, setCorridorsError] = useState<string | null>(null)
  const [corridorsLoading, setCorridorsLoading] = useState(false)
  const [corridorsRetryKey, setCorridorsRetryKey] = useState(0)
  const [highwaySearch, setHighwaySearch] = useState('')
  const [detectBusy, setDetectBusy] = useState(false)
  const [detectedCorridorName, setDetectedCorridorName] = useState<string | null>(null)
  const [detectMsg, setDetectMsg] = useState<string | null>(null)
  const [detectMultiMatches, setDetectMultiMatches] = useState<CorridorOption[]>([])
  /** True when /corridor/detect failed or returned no match — show manual corridor dropdown. */
  const [corridorAutodetectFailed, setCorridorAutodetectFailed] = useState(false)
  const gpsDetectKeyRef = useRef<string>('')

  const [incidentType, setIncidentType] = useState<string>(INCIDENT_TYPES[0].value)
  const [severity, setSeverity] = useState<string>('major')
  const [notes, setNotes] = useState('')
  const [kmMarker, setKmMarker] = useState('')
  const [injuredCount, setInjuredCount] = useState(0)
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
          const path = item.corridorId
            ? `/corridors/${item.corridorId}/incidents/public`
            : '/corridors/incidents/public'
          const r = await fetch(apiUrl(path), {
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
    void getGpsPosition(GPS_TIMEOUT_MS).then((pos) => {
      if (pos) {
        setGeo(pos)
        setLocState('ok')
      } else {
        setGeo(null)
        setLocState('fail')
      }
    })
  }, [])

  const beginReport = useCallback(() => {
    setError(null)
    setResult(null)
    setNotes('')
    setKmMarker('')
    setInjuredCount(0)
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
    setCorridorId('')
    setHighwaySearch('')
    setDetectedCorridorName(null)
    setDetectMsg(null)
    setDetectMultiMatches([])
    setCorridorAutodetectFailed(false)
    gpsDetectKeyRef.current = ''
    setPhase('form')
    startGps()
  }, [startGps])

  const gpsOk = locState === 'ok' && geo != null
  const gpsFailed = locState === 'fail'
  const kmNum = kmMarker.trim() === '' ? null : Number(kmMarker.trim())
  const kmValid = kmNum != null && Number.isFinite(kmNum)
  const filteredCorridors = corridors.filter((c) =>
    c.name.toLowerCase().includes(highwaySearch.trim().toLowerCase()),
  )

  const detectCorridor = useCallback(
    async (payload: { lat?: number; lng?: number; km_marker?: number; highway_hint?: string }) => {
      try {
        const r = await fetch(apiUrl('/corridor/detect'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!r.ok) return null
        return (await r.json()) as CorridorDetectResponse
      } catch {
        return null
      }
    },
    [],
  )

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
    if (phase !== 'form' || !gpsOk || !geo) return
    const k = `${geo.lat.toFixed(5)},${geo.lng.toFixed(5)}`
    if (gpsDetectKeyRef.current === k) return
    gpsDetectKeyRef.current = k
    let cancelled = false
    setDetectBusy(true)
    setDetectMsg(null)
    setCorridorAutodetectFailed(false)
    void detectCorridor({ lat: geo.lat, lng: geo.lng }).then((det) => {
      if (cancelled) return
      setDetectBusy(false)
      if (!det?.corridor_id || !det.corridor_name) {
        setCorridorAutodetectFailed(true)
        setCorridorId('')
        setDetectedCorridorName(null)
        setDetectMsg(HW_DETECT_FAIL_MSG)
        return
      }
      setCorridorAutodetectFailed(false)
      setCorridorId(det.corridor_id)
      setDetectedCorridorName(det.corridor_name)
      setDetectMsg(null)
    })
    return () => {
      cancelled = true
    }
  }, [phase, gpsOk, geo, detectCorridor])

  useEffect(() => {
    if (phase !== 'form' || !gpsFailed) return
    if (!kmValid || kmNum == null) {
      setDetectMultiMatches([])
      return
    }
    let cancelled = false
    setDetectBusy(true)
    setDetectMsg(null)
    setCorridorAutodetectFailed(false)
    void detectCorridor({ km_marker: kmNum, highway_hint: highwaySearch.trim() || undefined }).then((det) => {
      if (cancelled) return
      setDetectBusy(false)
      if (!det?.corridor_id || !det.corridor_name) {
        setCorridorAutodetectFailed(true)
        setCorridorId('')
        setDetectedCorridorName(null)
        setDetectMultiMatches([])
        setDetectMsg(HW_DETECT_FAIL_MSG)
        return
      }
      const multi = Array.isArray(det.matches)
        ? det.matches.map((m) => ({ id: m.corridor_id, name: m.corridor_name }))
        : []
      if (multi.length > 1) {
        setDetectMultiMatches(multi)
        setDetectedCorridorName(null)
        setCorridorId('')
        setCorridorAutodetectFailed(false)
        setDetectMsg('Which highway?')
      } else {
        setDetectMultiMatches([])
        setCorridorId(det.corridor_id)
        setDetectedCorridorName(det.corridor_name)
        setCorridorAutodetectFailed(false)
        setDetectMsg(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [phase, gpsFailed, kmValid, kmNum, highwaySearch, detectCorridor])

  useEffect(() => {
    if (!corridorId) return
    const fromAll = corridors.find((c) => c.id === corridorId)?.name
    const fromMatches = detectMultiMatches.find((c) => c.id === corridorId)?.name
    if (fromAll || fromMatches) setDetectedCorridorName(fromAll || fromMatches || null)
  }, [corridorId, corridors, detectMultiMatches])

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

    const effectiveCorridor = corridorId || ''

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
      vehicles_involved: vehicles,
      hazards: [...hazards],
      notes: notes.trim() || undefined,
      latitude: gpsOk ? geo!.lat : undefined,
      longitude: gpsOk ? geo!.lng : undefined,
    }
    if (direction) {
      payloadBody.direction = direction
    }
    if (kmValid) {
      payloadBody.km_marker = kmNum!
    }
    if (highwaySearch.trim()) {
      payloadBody.highway_hint = highwaySearch.trim()
    }
    if (photo_url) {
      payloadBody.photo_url = photo_url
    }

    if (!isConnected) {
      if (!effectiveCorridor) {
        setError('Select your highway before saving offline.')
        return
      }
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
      const path = effectiveCorridor ? `/corridors/${effectiveCorridor}/incidents/public` : '/corridors/incidents/public'
      const r = await fetch(apiUrl(path), {
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
      const coords = await getGpsPosition(GPS_TIMEOUT_MS)
      if (!coords) {
        setError('Could not get your location for auto SOS. Enable GPS and try a manual report.')
        setPhase('landing')
        return
      }

      const det = await detectCorridor({ lat: coords.lat, lng: coords.lng })
      const pathCorridor = det?.corridor_id ?? ''

      const payloadBody: PendingSosPayload = {
        incident_type: 'accident',
        severity: 'critical',
        injured_count: 0,
        vehicles_involved: 1,
        hazards: [],
        notes: 'Auto-detected crash — no user response',
        latitude: coords.lat,
        longitude: coords.lng,
      }

      if (!isConnected) {
        enqueuePending(pathCorridor, payloadBody)
        setQueueVersion((v) => v + 1)
        setPhase('offline_saved')
        return
      }

      const path = pathCorridor
        ? `/corridors/${pathCorridor}/incidents/public`
        : '/corridors/incidents/public'
      const r = await fetch(apiUrl(path), {
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
  }, [detectCorridor, isConnected])

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
    setCorridorId('')
    setCorridorAutodetectFailed(false)
    setDetectedCorridorName(null)
    setDetectMsg(null)
    setDetectMultiMatches([])
    gpsDetectKeyRef.current = ''
  }

  return (
    <div className={`sos-app ${deliveredBanner ? 'sos-app--delivered' : ''}`}>
      <div
        className={`sos-net-banner ${isConnected ? 'sos-net-banner--ok' : 'sos-net-banner--bad'}`}
        role="status"
        aria-live="polite"
      >
        {isConnected
          ? '🟢 Internet connected · SOS will send instantly'
          : '🔴 No internet · SMS fallback active'}
      </div>
      {deliveredBanner ? (
        <div className="sos-delivered-banner" role="status">
          {deliveredBanner}
        </div>
      ) : null}
      {phase === 'landing' && (
        <div className="sos-landing">
          <div className="sos-landing__main">
            {crashDetectionEnabled && permissionUi === 'needs_gesture' ? (
              <div className="sos-motion-prompt sos-motion-prompt--landing">
                <p className="sos-motion-prompt-text">Crash detection needs motion sensor access.</p>
                <button type="button" className="sos-motion-prompt-btn" onClick={() => void requestPermissionFromGesture()}>
                  Enable motion sensors
                </button>
              </div>
            ) : null}
            <div className="sos-landing__center">
              <button type="button" className="sos-mega" onClick={beginReport}>
                <span className="sos-mega-title">SOS</span>
                <span className="sos-mega-sub">Emergency on highway</span>
                <span className="sos-mega-hint">Tap to report</span>
              </button>
              <p className="sos-landing__reassure">Your report goes directly to emergency dispatch</p>
            </div>
          </div>
          <div className="sos-landing__bottom" role="contentinfo">
            <span className="sos-landing__crash-status">
              ● CRASH DETECTION: {crashDetectionEnabled ? 'ON' : 'OFF'}
            </span>
            <details className="sos-landing-settings">
              <summary className="sos-landing-settings-summary">⚙ Settings</summary>
              <div className="sos-landing-settings-body">
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
              </div>
            </details>
          </div>
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

          <div className="sos-section">
            <p className="sos-field-label">Add photo</p>
            <p className="sos-km-hint">Optional — helps dispatchers verify and prioritize</p>
            <label className="sos-photo-upload">
              <input
                type="file"
                accept="image/*"
                capture="environment"
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

          <div className="sos-section sos-location-card">
            <h2 className="sos-heading">Location</h2>
            {locState === 'pending' && (
              <p className="loc-pending" role="status">
                <span className="loc-dot" aria-hidden="true" />
                📍 Getting your location...
              </p>
            )}
            {locState === 'ok' && (
              <>
                <p className="loc-ok" role="status">
                  📍 GPS captured ✓
                </p>
                {detectBusy ? <p className="sos-warn">Detecting highway…</p> : null}
                {!detectBusy && !corridorAutodetectFailed && detectedCorridorName && corridorId ? (
                  <p className="loc-ok loc-ok--small" role="status">
                    Highway detected: {detectedCorridorName} ✓
                  </p>
                ) : null}
                {corridorAutodetectFailed ? (
                  <>
                    <p className="sos-warn" role="status">
                      {HW_DETECT_FAIL_MSG}
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
                    {!corridorsLoading && corridors.length > 0 ? (
                      <label className="sos-select-label">
                        <span className="sos-km-label-text">Select highway manually</span>
                        <select
                          className="sos-km-input sos-select-tight"
                          value={corridorId}
                          onChange={(e) => {
                            const id = e.target.value
                            setCorridorId(id)
                            setDetectedCorridorName(corridors.find((c) => c.id === id)?.name || null)
                          }}
                        >
                          <option value="">Choose highway</option>
                          {corridors.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
            {locState === 'fail' && (
              <div className="loc-fallback">
                <p className="loc-bad" role="status">
                  GPS not available
                </p>
                {detectBusy ? <p className="sos-warn">Detecting highway…</p> : null}
                {detectMsg && detectMsg !== HW_DETECT_FAIL_MSG ? (
                  <p className="loc-ok loc-ok--small">{detectMsg}</p>
                ) : null}
                {corridorAutodetectFailed ? (
                  <>
                    <p className="sos-warn" role="status">
                      {HW_DETECT_FAIL_MSG}
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
                    {!corridorsLoading && corridors.length > 0 ? (
                      <label className="sos-select-label">
                        <span className="sos-km-label-text">Select highway manually</span>
                        <select
                          className="sos-km-input sos-select-tight"
                          value={corridorId}
                          onChange={(e) => {
                            const id = e.target.value
                            setCorridorId(id)
                            setDetectedCorridorName(corridors.find((c) => c.id === id)?.name || null)
                          }}
                        >
                          <option value="">Choose highway</option>
                          {corridors.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </>
                ) : null}
                <label className="sos-km-label">
                  <span className="sos-km-label-text">Milestone number (optional)</span>
                  <span className="sos-km-hint">If you can see a green milestone stone, enter the number</span>
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
                {detectMultiMatches.length > 1 ? (
                  <>
                    <p className="sos-hw-prompt">Which highway?</p>
                    <HighwayButtonList
                      corridors={detectMultiMatches}
                      selectedId={corridorId}
                      onSelect={setCorridorId}
                      disabled={corridorsLoading}
                    />
                    <button
                      type="button"
                      className="sos-retry-hw"
                      onClick={() => {
                        setCorridorId('')
                        setDetectMultiMatches([])
                        setDetectedCorridorName(null)
                        setDetectMsg('Not sure — search your highway below.')
                      }}
                    >
                      Not sure
                    </button>
                  </>
                ) : null}
                {!kmValid ? (
                  <>
                    <label className="sos-km-label">
                      <span className="sos-km-label-text">Which highway are you on?</span>
                      <input
                        type="text"
                        className="sos-km-input"
                        value={highwaySearch}
                        onChange={(e) => setHighwaySearch(e.target.value)}
                        placeholder="Highway name or number"
                        autoComplete="off"
                      />
                    </label>
                    {filteredCorridors.length > 0 ? (
                      <HighwayButtonList
                        corridors={filteredCorridors}
                        selectedId={corridorId}
                        onSelect={setCorridorId}
                        disabled={corridorsLoading}
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
            )}
            {corridorId && detectedCorridorName ? (
              <p className="loc-ok loc-ok--small" role="status">
                Highway selected: {detectedCorridorName}
              </p>
            ) : null}
          </div>

          <div className="sos-section">
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

          <div className="sos-section">
            <p className="sos-field-label" id="sos-hazards-label">
              Any hazards visible?
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
                title={
                  isConnected
                    ? `${pendingCount} report(s) queued — will send when online`
                    : `${pendingCount} report(s) saved — will send via API when internet returns (SMS fallback active)`
                }
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
            📦 No internet — SMS fallback active. Report saved on your device; it will send via API when you are back online.
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

      {phase !== 'landing' && crashDetectionEnabled && permissionUi === 'granted' && isListening ? (
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
