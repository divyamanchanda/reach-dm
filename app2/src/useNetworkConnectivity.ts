import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from './api'

/** navigator.onLine plus periodic GET /health — both must pass for "connected". */
export function useNetworkConnectivity() {
  const [navigatorOnline, setNavigatorOnline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine,
  )
  const [probeOk, setProbeOk] = useState(true)

  const runProbe = useCallback(async (): Promise<boolean> => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setProbeOk(false)
      return false
    }
    const ctrl = new AbortController()
    const t = window.setTimeout(() => ctrl.abort(), 6000)
    try {
      const r = await fetch(apiUrl('/health'), {
        method: 'GET',
        cache: 'no-store',
        signal: ctrl.signal,
      })
      const ok = r.ok
      setProbeOk(ok)
      return ok
    } catch {
      setProbeOk(false)
      return false
    } finally {
      window.clearTimeout(t)
    }
  }, [])

  useEffect(() => {
    const onOnline = () => {
      setNavigatorOnline(true)
      void runProbe()
    }
    const onOffline = () => {
      setNavigatorOnline(false)
      setProbeOk(false)
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    void runProbe()
    const id = window.setInterval(() => {
      void runProbe()
    }, 12_000)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.clearInterval(id)
    }
  }, [runProbe])

  const isConnected = navigatorOnline && probeOk
  return { isConnected, navigatorOnline, probeOk, recheck: runProbe }
}
