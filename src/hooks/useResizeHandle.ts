import { useCallback, useRef } from 'react'

export function useResizeHandle(
  direction: 'horizontal' | 'vertical',
  onDelta: (delta: number) => void,
  onDragStart?: () => void,
  onDragEnd?: () => void,
) {
  const onDeltaRef = useRef(onDelta)
  onDeltaRef.current = onDelta
  const onDragStartRef = useRef(onDragStart)
  onDragStartRef.current = onDragStart
  const onDragEndRef = useRef(onDragEnd)
  onDragEndRef.current = onDragEnd

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    let lastPos = direction === 'horizontal' ? e.clientX : e.clientY
    onDragStartRef.current?.()

    const onMove = (e: MouseEvent) => {
      const pos = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = pos - lastPos
      lastPos = pos
      if (delta !== 0) onDeltaRef.current(delta)
    }

    const onUp = () => {
      onDragEndRef.current?.()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [direction])

  const touchActiveRef = useRef(false)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // A second finger on the handle must not add a second set of listeners.
    if (touchActiveRef.current) return
    touchActiveRef.current = true
    let lastPos = direction === 'horizontal' ? e.touches[0].clientX : e.touches[0].clientY
    onDragStartRef.current?.()

    const onMove = (e: TouchEvent) => {
      e.preventDefault()
      const pos = direction === 'horizontal' ? e.touches[0].clientX : e.touches[0].clientY
      const delta = pos - lastPos
      lastPos = pos
      if (delta !== 0) onDeltaRef.current(delta)
    }

    // touchcancel (system back gesture, notification shade, call overlay) ends
    // the drag too; otherwise the non-passive touchmove listener would outlive
    // it and block scrolling on the next touch.
    const onEnd = () => {
      touchActiveRef.current = false
      onDragEndRef.current?.()
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }

    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
    window.addEventListener('touchcancel', onEnd)
  }, [direction])

  return { onMouseDown, onTouchStart }
}
