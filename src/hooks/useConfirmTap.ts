import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Two-tap confirmation for destructive controls (abort, reset). The first tap
 * arms the control for `timeoutMs`; a second tap while armed runs the action.
 * Unlike window.confirm it never blocks the page, so streaming and status
 * handling keep running while the operator decides.
 */
export function useConfirmTap(timeoutMs = 3000) {
  const [armed, setArmed] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const disarm = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    setArmed(false)
  }, [])

  useEffect(() => disarm, [disarm])

  const tap = useCallback((action: () => void) => {
    if (timerRef.current) {
      disarm()
      action()
      return
    }
    setArmed(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setArmed(false)
    }, timeoutMs)
  }, [disarm, timeoutMs])

  return { armed, tap, disarm }
}
