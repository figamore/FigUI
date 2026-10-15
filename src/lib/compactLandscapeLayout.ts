import { useViewportMetrics, type ViewportMetrics } from './viewport'

/** Share of the visible viewport used by the Position + Jog band. */
const TOP_ROW_RATIO = 0.55
const TOP_ROW_MIN_PX = 228
const TOP_ROW_MAX_PX = 360

/** Tab workspace is taller than the remaining fold; the page scrolls to reach it. */
const TAB_CONTENT_RATIO = 0.85
const TAB_CONTENT_MIN_PX = 320
const TAB_CONTENT_MAX_PX = 560
/** Tab strip, panel border and page padding below the tab workspace. */
const TAB_PANEL_CHROME_PX = 72
const TAB_CONTENT_FLOOR_PX = 200

/** Visible height, which excludes browser chrome on mobile browsers. */
function layoutHeight(metrics: ViewportMetrics): number {
  return metrics.visualViewportHeight ?? metrics.innerHeight
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function useCompactLandscapeTopRowHeight(): number | undefined {
  const metrics = useViewportMetrics()
  if (!metrics.isCompactLandscape) return undefined
  return clamp(Math.round(layoutHeight(metrics) * TOP_ROW_RATIO), TOP_ROW_MIN_PX, TOP_ROW_MAX_PX)
}

export function useCompactLandscapeTabContentHeight(): number | undefined {
  const metrics = useViewportMetrics()
  if (!metrics.isCompactLandscape) return undefined
  const height = clamp(Math.round(layoutHeight(metrics) * TAB_CONTENT_RATIO), TAB_CONTENT_MIN_PX, TAB_CONTENT_MAX_PX)
  // A phone in landscape is shorter than the minimum, so the workspace would
  // not fit on one screen and its canvas, which does not scroll the page, could
  // fill the whole screen. innerHeight, unlike the visual viewport, does not
  // shrink when the on-screen keyboard opens.
  const fitsScreen = Math.max(metrics.innerHeight - TAB_PANEL_CHROME_PX, TAB_CONTENT_FLOOR_PX)
  return Math.min(height, fitsScreen)
}
