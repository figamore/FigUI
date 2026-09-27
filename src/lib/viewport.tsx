import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/** Short landscape viewports (7–8" tablets, browser chrome, split-screen). */
export const COMPACT_LANDSCAPE_MAX_HEIGHT = 640

export interface ViewportMetrics {
  innerWidth: number
  innerHeight: number
  visualViewportWidth: number | null
  visualViewportHeight: number | null
  devicePixelRatio: number
  isPortrait: boolean
  isLandscape: boolean
  isCompactLandscape: boolean
}

function readViewportMetrics(): ViewportMetrics {
  const innerWidth = typeof window === 'undefined' ? 1270 : window.innerWidth
  const innerHeight = typeof window === 'undefined' ? 800 : window.innerHeight
  const vv = typeof window === 'undefined' ? null : window.visualViewport
  const layoutHeight = vv?.height ?? innerHeight
  const isPortrait = typeof window === 'undefined'
    ? false
    : window.matchMedia('(orientation: portrait)').matches
  const isLandscape = !isPortrait

  return {
    innerWidth,
    innerHeight,
    visualViewportWidth: vv?.width ?? null,
    visualViewportHeight: vv?.height ?? null,
    devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    isPortrait,
    isLandscape,
    isCompactLandscape: isLandscape && layoutHeight < COMPACT_LANDSCAPE_MAX_HEIGHT,
  }
}

let pending = false
const listeners = new Set<() => void>()

function scheduleViewportUpdate() {
  if (pending || typeof window === 'undefined') return
  pending = true
  requestAnimationFrame(() => {
    pending = false
    listeners.forEach(listener => listener())
  })
}

function subscribeViewport(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('resize', scheduleViewportUpdate)
    window.addEventListener('orientationchange', scheduleViewportUpdate)
    window.visualViewport?.addEventListener('resize', scheduleViewportUpdate)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('resize', scheduleViewportUpdate)
      window.removeEventListener('orientationchange', scheduleViewportUpdate)
      window.visualViewport?.removeEventListener('resize', scheduleViewportUpdate)
    }
  }
}

const ViewportContext = createContext<ViewportMetrics | null>(null)

export function ViewportProvider({ children }: { children: ReactNode }) {
  const [metrics, setMetrics] = useState(readViewportMetrics)

  useEffect(() => {
    const update = () => setMetrics(readViewportMetrics())
    update()
    return subscribeViewport(update)
  }, [])

  return (
    <ViewportContext.Provider value={metrics}>
      {children}
    </ViewportContext.Provider>
  )
}

export function useViewportMetrics(): ViewportMetrics {
  const ctx = useContext(ViewportContext)
  if (!ctx) {
    throw new Error('useViewportMetrics must be used within ViewportProvider')
  }
  return ctx
}

export function useIsPortrait(): boolean {
  return useViewportMetrics().isPortrait
}

export function useIsCompactLandscape(): boolean {
  return useViewportMetrics().isCompactLandscape
}
