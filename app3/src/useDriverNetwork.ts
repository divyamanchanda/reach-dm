import { useEffect, useMemo, useState } from 'react'

export type DriverNetTier = 'connected' | 'weak' | 'offline'

type NetworkInformationLike = {
  effectiveType?: string
  downlink?: number
  saveData?: boolean
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

function readWeakConnection(): boolean {
  if (typeof navigator === 'undefined') return false
  const c = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
  if (!c) return false
  if (c.saveData) return true
  const et = c.effectiveType
  if (et === 'slow-2g' || et === '2g') return true
  if (typeof c.downlink === 'number' && c.downlink > 0 && c.downlink < 0.4) return true
  return false
}

/**
 * - offline: browser reports offline
 * - weak: online but slow radio / last server fetch failed (stale cache path)
 * - connected: good path
 */
export function useDriverNetwork(lastServerFetchFailed: boolean): {
  tier: DriverNetTier
  isOffline: boolean
  isWeakTier: boolean
} {
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )
  const [weakConn, setWeakConn] = useState(readWeakConnection)

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  useEffect(() => {
    const c = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
    if (!c?.addEventListener) return
    const bump = () => setWeakConn(readWeakConnection())
    c.addEventListener('change', bump)
    return () => c.removeEventListener?.('change', bump)
  }, [])

  const tier = useMemo((): DriverNetTier => {
    if (!online) return 'offline'
    if (lastServerFetchFailed || weakConn) return 'weak'
    return 'connected'
  }, [online, lastServerFetchFailed, weakConn])

  return {
    tier,
    isOffline: !online,
    isWeakTier: tier === 'weak',
  }
}
