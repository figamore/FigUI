import { useMachineStore } from '../store'
import { sendCommand } from './http'
import { parseESP400Settings } from './parser'
import type { FluidNCSetting } from '../types'

let inFlight: Promise<FluidNCSetting[]> | null = null

export function updateControllerConfigSetting(settings: FluidNCSetting[], path: string, value: string): FluidNCSetting[] {
  const maxRateAxis = (settingPath: string) => {
    const normalized = settingPath.replace(/^\/+/, '').toLowerCase()
    return normalized.match(/^axes\/([xyzabc])\/max_rate_mm_per_min$/)?.[1]
      ?? normalized.match(/^grbl\/maxrate\/([xyzabc])$/)?.[1]
  }
  const axis = maxRateAxis(path)
  return settings.map(setting =>
    setting.P === path || (axis != null && maxRateAxis(setting.P) === axis)
      ? { ...setting, V: value }
      : setting,
  )
}

export async function loadControllerConfigSettings(force = false): Promise<FluidNCSetting[]> {
  const store = useMachineStore.getState()
  if (!force && store.controllerConfigSettings) return store.controllerConfigSettings
  if (inFlight) return inFlight

  store.setControllerConfigLoading(true)
  store.setControllerConfigError(null)

  inFlight = sendCommand('[ESP400]')
    .then(raw => {
      const settings = parseESP400Settings(raw)
      useMachineStore.getState().setControllerConfigSettings(settings)
      return settings
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : 'Failed to load settings'
      useMachineStore.getState().setControllerConfigError(message)
      throw error
    })
    .finally(() => {
      inFlight = null
      useMachineStore.getState().setControllerConfigLoading(false)
    })

  return inFlight
}

export function prefetchControllerConfigSettings() {
  loadControllerConfigSettings(false).catch(() => {})
}
