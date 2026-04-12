/** m/s² — sudden impact on any axis */
export const CRASH_ACCEL_THRESHOLD_MS2 = 25

export const CRASH_COUNTDOWN_SEC = 15

export const CRASH_COOLDOWN_MS = 90_000

export const CRASH_DETECTION_STORAGE_KEY = 'reach_sos_crash_detection_v1'

export function readCrashDetectionEnabled(): boolean {
  const v = localStorage.getItem(CRASH_DETECTION_STORAGE_KEY)
  if (v === '0') return false
  return true
}

export function writeCrashDetectionEnabled(on: boolean): void {
  localStorage.setItem(CRASH_DETECTION_STORAGE_KEY, on ? '1' : '0')
}

/** Peak absolute acceleration on x/y/z (prefers user acceleration without gravity). */
export function peakAccelerationMs2(e: DeviceMotionEvent): number {
  const a = e.acceleration
  if (a && a.x != null && a.y != null && a.z != null) {
    return Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z))
  }
  const g = e.accelerationIncludingGravity
  if (g && g.x != null && g.y != null && g.z != null) {
    return Math.max(Math.abs(g.x), Math.abs(g.y), Math.abs(g.z))
  }
  return 0
}

/**
 * iOS 13+ requires a user gesture; Android/desktop often grant without.
 * Returns true if motion events may be used (granted or no permission API).
 */
export async function requestDeviceMotionPermission(): Promise<boolean> {
  if (typeof DeviceMotionEvent === 'undefined') return false
  const ctor = DeviceMotionEvent as unknown as {
    requestPermission?: () => Promise<PermissionState>
  }
  if (typeof ctor.requestPermission === 'function') {
    try {
      const r = await ctor.requestPermission()
      return r === 'granted'
    } catch {
      return false
    }
  }
  return true
}

export function deviceMotionSupported(): boolean {
  return typeof window !== 'undefined' && 'DeviceMotionEvent' in window
}
