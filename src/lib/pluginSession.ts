import { useMachineStore } from '../store'
import { onLine, onSoftReset } from './ws'
import { getBase } from './http'

/** Volatile plugin state, scoped to this controller connection, never disk. */
export function createPluginSessionStore(getController: () => string = () => '') {
  const values = new Map<string, unknown>()
  const recovery = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  let generation = 0
  let controller = getController()
  let reason = 'initial'
  const store = {
    read(id: string) {
      if (getController() !== controller) store.invalidate('controller')
      return { generation, reason, data: values.get(id) ?? null, recovery: recovery.get(id) ?? null }
    },
    write(id: string, expected: number, data: unknown) {
      store.read(id) // Detect a controller switch before accepting a late write.
      if (expected !== generation) throw new Error('Controller session changed')
      recovery.delete(id)
      if (data == null) values.delete(id)
      else values.set(id, data)
    },
    invalidate(cause = 'reset') {
      const current = getController()
      reason = current !== controller ? 'controller' : cause
      controller = current
      if (reason === 'connection') {
        // Keep calibration available for explicit verification, never active
        // motion authorization. Repeated reconnect attempts retain this copy.
        values.forEach((value, id) => recovery.set(id, value))
      } else recovery.clear()
      generation++
      values.clear()
      listeners.forEach(listener => listener())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return store
}

export const pluginSession = createPluginSessionStore(getBase)
// Keep watching while plugin frames are closed: a reference must never survive
// a reset, firmware homing or alarm. Reconnects archive a recovery candidate.
// Another client's ordinary
// jogging changes reported positions, not the joint-to-machine calibration.
useMachineStore.subscribe((state, previous) => {
  if (state.controllerResetPending && !previous.controllerResetPending)
    pluginSession.invalidate('reset')
  else if (state.status.state !== previous.status.state && ['Home', 'Alarm'].includes(state.status.state))
    pluginSession.invalidate(state.status.state === 'Home' ? 'homing' : 'alarm')
  else if (state.connected !== previous.connected)
    pluginSession.invalidate('connection')
})
onSoftReset(() => pluginSession.invalidate())
onLine(line => {
  if (/^(?:Grbl\b|FluidNC\b|ALARM:)/i.test(line)) pluginSession.invalidate()
})
