import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CRASH_ACCEL_THRESHOLD_MS2,
  CRASH_COOLDOWN_MS,
  deviceMotionSupported,
  peakAccelerationMs2,
  requestDeviceMotionPermission,
} from './crashDetection'

const MOTION_GRANTED_SESSION_KEY = 'reach_sos_motion_granted_v1'

export type MotionPermissionUi = 'unknown' | 'needs_gesture' | 'granted' | 'denied' | 'unsupported'

type Options = {
  enabled: boolean
  /** While true, impact events are ignored (e.g. crash confirmation UI open). */
  suspended: boolean
  onImpact: () => void
}

export function useCrashDetection({ enabled, suspended, onImpact }: Options): {
  permissionUi: MotionPermissionUi
  isListening: boolean
  requestPermissionFromGesture: () => Promise<void>
} {
  const [permissionUi, setPermissionUi] = useState<MotionPermissionUi>('unknown')
  const [isListening, setIsListening] = useState(false)
  const lastImpactAt = useRef(0)
  const suspendedRef = useRef(suspended)
  const onImpactRef = useRef(onImpact)

  useEffect(() => {
    suspendedRef.current = suspended
  }, [suspended])

  useEffect(() => {
    onImpactRef.current = onImpact
  }, [onImpact])

  useEffect(() => {
    if (!enabled) {
      setIsListening(false)
      return
    }
    if (!deviceMotionSupported()) {
      setPermissionUi('unsupported')
      setIsListening(false)
      return
    }
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(MOTION_GRANTED_SESSION_KEY) === '1') {
      setPermissionUi('granted')
      return
    }
    const ctor = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<PermissionState> }
    if (typeof ctor.requestPermission === 'function') {
      setPermissionUi('needs_gesture')
    } else {
      setPermissionUi('granted')
      try {
        sessionStorage.setItem(MOTION_GRANTED_SESSION_KEY, '1')
      } catch {
        /* ignore */
      }
    }
  }, [enabled])

  const onMotion = useCallback((e: DeviceMotionEvent) => {
    if (suspendedRef.current) return
    const now = Date.now()
    if (now - lastImpactAt.current < CRASH_COOLDOWN_MS) return
    const peak = peakAccelerationMs2(e)
    if (peak < CRASH_ACCEL_THRESHOLD_MS2) return
    lastImpactAt.current = now
    onImpactRef.current()
  }, [])

  useEffect(() => {
    if (!enabled || permissionUi !== 'granted') {
      setIsListening(false)
      return
    }
    if (suspended) {
      setIsListening(false)
      return
    }
    window.addEventListener('devicemotion', onMotion, { capture: true, passive: true })
    setIsListening(true)
    return () => {
      window.removeEventListener('devicemotion', onMotion, { capture: true })
      setIsListening(false)
    }
  }, [enabled, permissionUi, suspended, onMotion])

  const requestPermissionFromGesture = useCallback(async () => {
    const ok = await requestDeviceMotionPermission()
    if (ok) {
      try {
        sessionStorage.setItem(MOTION_GRANTED_SESSION_KEY, '1')
      } catch {
        /* ignore */
      }
    }
    setPermissionUi(ok ? 'granted' : 'denied')
  }, [])

  return { permissionUi, isListening, requestPermissionFromGesture }
}
