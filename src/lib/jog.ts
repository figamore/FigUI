import type { ControllerSettings } from '../types'

export function loadPersistedJogFeed(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

export function jogFeedKeyForAxis(axis: string) {
  if (axis === 'Z') return ['jog.zFeed', 200] as const
  if (axis === 'A' || axis === 'B' || axis === 'C') return ['jog.abcFeed', 500] as const
  return ['jog.xyFeed', 1000] as const
}

export function getJogFeedMax(settings: ControllerSettings, group: 'xy' | 'z' | 'abc', axes = 6): number | undefined {
  const rates = group === 'xy'
    ? [settings.maxRateX, settings.maxRateY]
    : group === 'z'
      ? [settings.maxRateZ]
      : [settings.maxRateA, settings.maxRateB, settings.maxRateC].slice(0, Math.max(0, axes - 3))
  const validRates = rates.filter((rate): rate is number => rate != null && Number.isFinite(rate) && rate > 0)
  return validRates.length > 0 ? Math.min(...validRates) : undefined
}

export function buildLimitedFeedPresets(presets: readonly number[], max?: number): number[] {
  if (max == null || !Number.isFinite(max) || max <= 0) return [...presets]

  const normalizedMax = Math.round(max * 1000) / 1000
  const limited = presets.filter(preset => preset <= normalizedMax)
  const next = limited.length > 0 ? [...limited] : [normalizedMax]
  if (!next.some(preset => Math.abs(preset - normalizedMax) < 0.001)) next.push(normalizedMax)
  return next
}
