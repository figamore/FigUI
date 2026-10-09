import { useMachineStore } from '../store'
import { useGCodeStore } from '../store/gcode'
import { useGCodeSenderStore } from '../store/gcodeSender'
import { useManualAtcStore } from '../store/manualAtc'
import { axisStepToCommand, axisValueToDisplay, isRotaryAxis } from './units'
import { getJogFeedMax, jogFeedKeyForAxis, loadPersistedJogFeed } from './jog'
import { isSocketOpen, sendRaw } from './ws'
import type { Units } from '../types'

export type AxisPositionAction = 'set' | 'go'
export type AxisPositionMode = 'WPos' | 'MPos'

export function parseAxisPosition(input: string): number | null {
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(input.trim())) return null
  const value = Number(input)
  return Number.isFinite(value) && Math.abs(value) < 1e21 ? value : null
}

export function buildAxisPositionCommand(
  action: AxisPositionAction, axis: string, mode: AxisPositionMode,
  input: string, units: Units, controllerUnits: string | undefined, feed: number,
): string | null {
  const value = parseAxisPosition(input)
  if (value === null || !/^[XYZABC]$/.test(axis)) return null
  let target = axisStepToCommand(value, axis, units)
  if (action === 'set') {
    if (mode !== 'WPos') return null
    if (!isRotaryAxis(axis) && controllerUnits !== 'G20' && controllerUnits !== 'G21') return null
    // G10 uses the controller's modal units. Preserve them instead of changing
    // a program's G20/G21 setting to match the display preference.
    target = axisValueToDisplay(target, axis, controllerUnits === 'G20' ? 'in' : 'mm')
  } else if (!Number.isFinite(feed) || feed <= 0) return null
  if (!Number.isFinite(target) || Math.abs(target) >= 1e21) return null
  const number = target.toFixed(6).replace(/\.?0+$/, '') || '0'
  return action === 'set' ? `G10 L20 P0 ${axis}${number}`
    : `$J=G90 G21 ${mode === 'MPos' ? 'G53 ' : ''}F${feed} ${axis}${number}`
}

export function sendAxisPosition(action: AxisPositionAction, axis: string, mode: AxisPositionMode, input: string, units: Units): boolean {
  const machine = useMachineStore.getState()
  const atc = useManualAtcStore.getState()
  if (!machine.connected || !machine.statusReceived || !isSocketOpen() || machine.status.state !== 'Idle'
    || machine.controllerResetPending || machine.status.sdFilename || useGCodeStore.getState().trackedJob
    || ['streaming', 'paused', 'draining'].includes(useGCodeSenderStore.getState().phase)
    || atc.phase !== 'idle' || !'XYZABC'.slice(0, machine.axes).includes(axis)) return false
  const [feedKey, fallback] = jogFeedKeyForAxis(axis)
  const savedFeed = loadPersistedJogFeed(feedKey, fallback)
  const maxFeed = getJogFeedMax(machine.controllerSettings, axis === 'Z' ? 'z' : isRotaryAxis(axis) ? 'abc' : 'xy', machine.axes)
  const feed = Math.min(savedFeed > 0 ? savedFeed : fallback, maxFeed ?? Infinity)
  const command = buildAxisPositionCommand(action, axis, mode, input, units, machine.status.gcodeModes?.units, feed)
  if (!command) return false
  const referenceZ = action === 'set' && axis === 'Z' && machine.controllerSettings.hasManualATC === true
  if (referenceZ && !atc.resetReference()) return false
  if (!sendRaw(command)) return false
  if (referenceZ) atc.completeReferenceSetup()
  return true
}
