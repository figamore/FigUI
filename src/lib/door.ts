import { uiText as __uiText } from './i18n'
import type { DoorPhase, MachineStatus } from '../types'

const DOOR_PHASES: Record<string, DoorPhase> = { '0': 'ready', '1': 'open', '2': 'parking', '3': 'restoring' }

/** FluidNC/Grbl Door substate: 0 closed and ready, 1 open, 2 parking, 3 restoring. */
export function parseDoorPhase(substate: string | undefined): DoorPhase | undefined {
  return substate == null ? undefined : DOOR_PHASES[substate]
}

/** In Door state, cycle start is only accepted at Door:0. */
export function isDoorBlocked(status: Pick<MachineStatus, 'state' | 'doorPhase'>) {
  return status.state === 'Door' && status.doorPhase !== 'ready'
}

export function doorPhaseText(phase: DoorPhase | undefined) {
  switch (phase) {
    case 'ready': return __uiText("lib.door.ready.1", "Door closed — ready to resume")
    case 'parking': return __uiText("lib.door.parking.1", "Parking…")
    case 'restoring': return __uiText("lib.door.restoring.1", "Resuming…")
    default: return __uiText("lib.door.open.1", "Door open — close it to resume")
  }
}
