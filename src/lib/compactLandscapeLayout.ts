import { useViewportMetrics, type ViewportMetrics } from './viewport'

/** Share of layout viewport height for the Position + Jog band. */
export const COMPACT_LANDSCAPE_TOP_ROW_RATIO = 0.55

export const COMPACT_LANDSCAPE_TOP_ROW_MIN_PX = 228

export const COMPACT_LANDSCAPE_TOP_ROW_MAX_PX = 360

/** Stacked G-code viewer; dvh accounts for browser chrome. */
export const COMPACT_LANDSCAPE_VIEWER_CLASS = 'h-[min(62dvh,28rem)]'

/** Min height for inline plugin panels below the top row. */
export const COMPACT_LANDSCAPE_PLUGIN_MIN_HEIGHT = 'min(50dvh, 24rem)'

export function layoutViewportHeight(metrics: ViewportMetrics): number {
  return metrics.visualViewportHeight ?? metrics.innerHeight
}

export function compactLandscapeTopRowHeightPx(metrics: ViewportMetrics): number {
  const h = layoutViewportHeight(metrics)
  return Math.min(
    Math.max(Math.round(h * COMPACT_LANDSCAPE_TOP_ROW_RATIO), COMPACT_LANDSCAPE_TOP_ROW_MIN_PX),
    COMPACT_LANDSCAPE_TOP_ROW_MAX_PX,
  )
}

export function useCompactLandscapeTopRowHeight(): number | undefined {
  const metrics = useViewportMetrics()
  if (!metrics.isCompactLandscape) return undefined
  return compactLandscapeTopRowHeightPx(metrics)
}
