import { useMachineStore } from '../store'
import { onLine, onSoftReset } from './ws'
import { getBase } from './http'

/** Volatile plugin state, scoped to this controller connection, never disk. */
export function createPluginSessionStore(getController: () => string = () => '') {
  const sessions = new Map<string, { data: unknown; recovery: unknown }>()
  const listeners = new Set<() => void>()
  let generation = 0
  let controller = getController()
  let reason = 'initial'
  const store = {
    read(id: string) {
      if (getController() !== controller) store.invalidate('controller')
      const session = sessions.get(id)
      return { generation, reason, data: session?.data ?? null, recovery: session?.recovery ?? null }
    },
    write(id: string, expected: number, data: unknown) {
      store.read(id) // Detect a controller switch before accepting a late write.
      if (expected !== generation) throw new Error('Controller session changed')
      if (data == null) sessions.delete(id)
      else sessions.set(id, { data, recovery: null })
    },
    invalidate(cause = 'reset') {
      const current = getController()
      reason = current !== controller ? 'controller' : cause
      controller = current
      if (reason === 'connection') {
        // Keep calibration available for explicit verification, never active
        // motion authorization. Repeated reconnect attempts retain this copy.
        for (const session of sessions.values()) {
          session.recovery = session.data ?? session.recovery
          session.data = null
        }
      } else sessions.clear()
      generation++
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
