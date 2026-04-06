import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { deleteJson, fetchJson, patchJson, postJson } from './api'

const NH48_KM = 312
const SEG_KM = 20
const N_SEG = Math.ceil(NH48_KM / SEG_KM)
const HW_PAD = 52
const HW_W = 1000

export type AdminAnalytics = {
  avg_response_time_minutes: number | null
  response_time_last_20: { incident_id: string; reported_at: string; response_minutes: number }[]
  heatmap_buckets: { segment_start_km: number; incident_count: number }[]
  vehicle_dispatch_counts: { vehicle_label: string; dispatch_count: number }[]
  active_drivers: {
    driver_name: string
    phone: string
    vehicle_label: string
    vehicle_status: string
    last_gps_at: string | null
    on_active_call: boolean
  }[]
}

export type SpeedZoneRow = {
  id: string
  corridor_id: string
  start_km: number
  end_km: number
  speed_limit_kph: number
  created_at: string
}

type CorridorRow = { id: string; name: string }

function heatColor(ratio: number): string {
  const t = Math.min(1, Math.max(0, ratio))
  const h = 58 - t * 52
  const l = 88 - t * 58
  return `hsl(${h} 90% ${l}%)`
}

function IncidentHeatmap({ buckets }: { buckets: { segment_start_km: number; incident_count: number }[] }) {
  const countBySeg = useMemo(() => {
    const m = new Map<number, number>()
    for (const b of buckets) m.set(b.segment_start_km, b.incident_count)
    return m
  }, [buckets])
  const maxC = useMemo(() => Math.max(1, ...buckets.map((b) => b.incident_count), 1), [buckets])
  const barW = (HW_W - 2 * HW_PAD) / N_SEG
  return (
    <svg className="analytics-heatmap-svg" viewBox={`0 0 ${HW_W} 88`} role="img" aria-label="Incident heatmap by 20 km">
      <text x={HW_PAD} y={16} fill="#94a3b8" fontSize={12} fontWeight={600}>
        0 km
      </text>
      <text x={HW_W - HW_PAD} y={16} textAnchor="end" fill="#94a3b8" fontSize={12} fontWeight={600}>
        {NH48_KM} km
      </text>
      {Array.from({ length: N_SEG }, (_, i) => {
        const startKm = i * SEG_KM
        const cnt = countBySeg.get(startKm) ?? 0
        const r = cnt / maxC
        const x = HW_PAD + i * barW
        return (
          <g key={startKm}>
            <rect
              x={x + 1}
              y={24}
              width={barW - 2}
              height={44}
              rx={4}
              fill={heatColor(r)}
              stroke="#1e293b"
              strokeWidth={1}
            />
            <text x={x + barW / 2} y={82} textAnchor="middle" fill="#cbd5e1" fontSize={9}>
              {cnt > 0 ? cnt : ''}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function ResponseTrendChart({ points }: { points: { reported_at: string; response_minutes: number }[] }) {
  const sorted = useMemo(
    () => [...points].sort((a, b) => +new Date(a.reported_at) - +new Date(b.reported_at)),
    [points],
  )
  const W = 420
  const H = 120
  const pad = 16
  const maxY = Math.max(1, ...sorted.map((p) => p.response_minutes), 1)
  const pts = sorted.map((p, i) => {
    const x = pad + (sorted.length <= 1 ? (W - 2 * pad) / 2 : (i / (sorted.length - 1)) * (W - 2 * pad))
    const y = H - pad - (p.response_minutes / maxY) * (H - 2 * pad)
    return `${x},${y}`
  })
  const line = pts.join(' ')
  return (
    <svg width={W} height={H} className="analytics-trend-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Response time trend">
      <polyline
        fill="none"
        stroke="#38bdf8"
        strokeWidth={2}
        points={line}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {sorted.map((p, i) => {
        const x = pad + (sorted.length <= 1 ? (W - 2 * pad) / 2 : (i / (sorted.length - 1)) * (W - 2 * pad))
        const y = H - pad - (p.response_minutes / maxY) * (H - 2 * pad)
        return <circle key={p.incident_id} cx={x} cy={y} r={4} fill="#0ea5e9" stroke="#0f172a" strokeWidth={1} />
      })}
    </svg>
  )
}

function VehicleUtilizationBars({
  rows,
}: {
  rows: { vehicle_label: string; dispatch_count: number }[]
}) {
  const max = Math.max(1, ...rows.map((r) => r.dispatch_count))
  return (
    <div className="analytics-bars">
      {rows.map((r) => (
        <div key={r.vehicle_label} className="analytics-bar-row">
          <span className="analytics-bar-label">{r.vehicle_label}</span>
          <div className="analytics-bar-track">
            <div className="analytics-bar-fill" style={{ width: `${(r.dispatch_count / max) * 100}%` }} />
          </div>
          <span className="analytics-bar-num">{r.dispatch_count}</span>
        </div>
      ))}
      {rows.length === 0 && <p className="muted">No dispatch data yet.</p>}
    </div>
  )
}

export function AnalyticsPage({ token, onError }: { token: string; onError: (msg: string | null) => void }) {
  const [data, setData] = useState<AdminAnalytics | null>(null)
  const load = useCallback(async () => {
    try {
      setData(await fetchJson<AdminAnalytics>('/admin/analytics', token))
      onError(null)
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : 'Failed to load analytics')
    }
  }, [token, onError])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="analytics-page">
      <h2>Analytics</h2>
      <p className="muted intro">Operations metrics derived from incidents, dispatches, and live vehicles.</p>
      {!data ? (
        <p>Loading…</p>
      ) : (
        <div className="analytics-grid">
          <section className="analytics-card">
            <h3>Response time</h3>
            <p className="muted small">Average minutes from incident reported to first dispatch</p>
            <div className="analytics-big-num">
              {data.avg_response_time_minutes != null ? data.avg_response_time_minutes.toFixed(1) : '—'}
              <span className="unit">min</span>
            </div>
            <div className="analytics-sub">
              <h4>Last 20 dispatched (trend)</h4>
              {data.response_time_last_20.length > 0 ? (
                <ResponseTrendChart points={data.response_time_last_20} />
              ) : (
                <p className="muted">Not enough data.</p>
              )}
            </div>
          </section>

          <section className="analytics-card">
            <h3>Incident heatmap</h3>
            <p className="muted small">Count per {SEG_KM} km segment (light → dark = more incidents)</p>
            <IncidentHeatmap buckets={data.heatmap_buckets} />
          </section>

          <section className="analytics-card">
            <h3>Vehicle utilization</h3>
            <p className="muted small">Total dispatches per ambulance</p>
            <VehicleUtilizationBars rows={data.vehicle_dispatch_counts} />
          </section>

          <section className="analytics-card analytics-card-wide">
            <h3>Active duty</h3>
            <p className="muted small">Drivers with assigned vehicles and last GPS update</p>
            <div className="table-wrap">
              <table className="analytics-duty-table">
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th>Phone</th>
                    <th>Vehicle</th>
                    <th>Status</th>
                    <th>On call</th>
                    <th>Last GPS</th>
                  </tr>
                </thead>
                <tbody>
                  {data.active_drivers.map((d) => (
                    <tr key={`${d.phone}-${d.vehicle_label}`}>
                      <td>{d.driver_name}</td>
                      <td>{d.phone}</td>
                      <td>{d.vehicle_label}</td>
                      <td>{d.vehicle_status}</td>
                      <td>{d.on_active_call ? 'Yes' : '—'}</td>
                      <td>{d.last_gps_at ? new Date(d.last_gps_at).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.active_drivers.length === 0 && <p className="muted">No drivers with assigned vehicles.</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export function BroadcastPage({
  token,
  onError,
}: {
  token: string
  onError: (msg: string | null) => void
}) {
  const [msg, setMsg] = useState('')
  const [sending, setSending] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!msg.trim()) return
    setSending(true)
    onError(null)
    try {
      await postJson('/admin/broadcast', token, { message: msg.trim() })
      setMsg('')
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Broadcast failed')
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="broadcast-page">
      <h2>Broadcast</h2>
      <p className="muted intro">Send a message to all connected driver apps (Socket.IO). Drivers see a blue banner.</p>
      <form className="form-panel broadcast-form" onSubmit={(e) => void submit(e)}>
        <label>
          Message
          <textarea
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            rows={4}
            placeholder="Type announcement for all drivers…"
            required
          />
        </label>
        <button type="submit" disabled={sending || !msg.trim()}>
          {sending ? 'Sending…' : 'Send to All Drivers'}
        </button>
      </form>
    </div>
  )
}

export function SpeedZonesPage({
  token,
  corridors,
  onError,
}: {
  token: string
  corridors: CorridorRow[]
  onError: (msg: string | null) => void
}) {
  const [zones, setZones] = useState<SpeedZoneRow[]>([])
  const [loading, setLoading] = useState(true)
  const [cid, setCid] = useState('')
  const [startKm, setStartKm] = useState('0')
  const [endKm, setEndKm] = useState('20')
  const [limitKph, setLimitKph] = useState('100')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [editLimit, setEditLimit] = useState('')

  const load = useCallback(async () => {
    onError(null)
    setLoading(true)
    try {
      setZones(await fetchJson<SpeedZoneRow[]>('/admin/speed-zones', token))
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : 'Failed to load zones')
    } finally {
      setLoading(false)
    }
  }, [token, onError])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!cid && corridors[0]?.id) setCid(corridors[0].id)
  }, [corridors, cid])

  const addZone = async (e: FormEvent) => {
    e.preventDefault()
    if (!cid) return
    onError(null)
    try {
      await postJson('/admin/speed-zones', token, {
        corridor_id: cid,
        start_km: Number(startKm),
        end_km: Number(endKm),
        speed_limit_kph: Number(limitKph) || 100,
      })
      await load()
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Failed to add zone')
    }
  }

  const saveEdit = async (id: string) => {
    onError(null)
    try {
      await patchJson(`/admin/speed-zones/${id}`, token, {
        start_km: editStart === '' ? undefined : Number(editStart),
        end_km: editEnd === '' ? undefined : Number(editEnd),
        speed_limit_kph: editLimit === '' ? undefined : Number(editLimit),
      })
      setEditingId(null)
      await load()
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Failed to update')
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this speed zone?')) return
    onError(null)
    try {
      await deleteJson(`/admin/speed-zones/${id}`, token)
      await load()
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  return (
    <div className="speed-zones-page">
      <h2>Speed zones</h2>
      <p className="muted intro">Corridor segments with speed limits (default 100 km/h). Stored in the database.</p>
      <form className="form-panel" onSubmit={(e) => void addZone(e)}>
        <h3>Add zone</h3>
        <div className="form-row">
          <label>
            Corridor
            <select value={cid} onChange={(e) => setCid(e.target.value)} required>
              {corridors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row grid-3">
          <label>
            Start KM
            <input type="number" step="0.1" value={startKm} onChange={(e) => setStartKm(e.target.value)} required />
          </label>
          <label>
            End KM
            <input type="number" step="0.1" value={endKm} onChange={(e) => setEndKm(e.target.value)} required />
          </label>
          <label>
            Limit (km/h)
            <input type="number" value={limitKph} onChange={(e) => setLimitKph(e.target.value)} min={1} max={200} />
          </label>
        </div>
        <button type="submit">Add zone</button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Corridor</th>
                <th>Start KM</th>
                <th>End KM</th>
                <th>Limit km/h</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {zones.map((z) => {
                const cname = corridors.find((c) => c.id === z.corridor_id)?.name ?? z.corridor_id.slice(0, 8)
                const isEd = editingId === z.id
                return (
                  <tr key={z.id}>
                    <td>{cname}</td>
                    <td>
                      {isEd ? (
                        <input value={editStart} onChange={(e) => setEditStart(e.target.value)} type="number" step="0.1" />
                      ) : (
                        z.start_km
                      )}
                    </td>
                    <td>
                      {isEd ? (
                        <input value={editEnd} onChange={(e) => setEditEnd(e.target.value)} type="number" step="0.1" />
                      ) : (
                        z.end_km
                      )}
                    </td>
                    <td>
                      {isEd ? (
                        <input value={editLimit} onChange={(e) => setEditLimit(e.target.value)} type="number" min={1} max={200} />
                      ) : (
                        z.speed_limit_kph
                      )}
                    </td>
                    <td className="cell-actions">
                      {isEd ? (
                        <>
                          <button type="button" onClick={() => void saveEdit(z.id)}>
                            Save
                          </button>
                          <button type="button" onClick={() => setEditingId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(z.id)
                              setEditStart(String(z.start_km))
                              setEditEnd(String(z.end_km))
                              setEditLimit(String(z.speed_limit_kph))
                            }}
                          >
                            Edit
                          </button>
                          <button type="button" className="btn-danger" onClick={() => void remove(z.id)}>
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
