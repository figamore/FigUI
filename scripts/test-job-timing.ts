import assert from 'node:assert/strict'
import React from 'react'
import { parseGCode, type GCodeModel } from '../src/lib/gcode'
import { buildJobTimingEstimate, useJobRuntimeEstimate } from '../src/lib/jobRuntime'
import type { ControllerSettings, MachineStatus } from '../src/types'

const settings = { maxRateX: 3000, maxRateY: 3000, maxRateZ: 1000, accelX: 200, accelY: 200, accelZ: 100 } as ControllerSettings

{
  // FluidNC syncs the planner on every M4/M5, even in laser mode with no
  // spin-up delay, so the same path is slower with the laser switched per move.
  const moves: string[] = []
  const switched: string[] = []
  for (let i = 0; i < 20; i++) {
    const move = `G1 X${(i + 1) * 2} Y0 F3000`
    moves.push(move)
    switched.push('M4 S500', move, 'M5')
  }
  const steady = buildJobTimingEstimate(parseGCode(['G21 G90', 'M4 S500', ...moves, 'M5'].join('\n')), settings)
  const stopped = buildJobTimingEstimate(parseGCode(['G21 G90', ...switched].join('\n')), settings)
  assert.ok(steady && stopped)
  // 40 mm at 50 mm/s with 200 mm/s2: one ramp up and down for the steady path,
  // twenty for the switched one (each 2 mm move peaks near 20 mm/s).
  assert.ok(stopped.totalSeconds > steady.totalSeconds * 1.5, `${stopped.totalSeconds} vs ${steady.totalSeconds}`)
  near(stopped.totalSeconds, 20 * 2 * Math.sqrt(2 * 1 / 200), 'every switched move starts and ends at rest')
}

{
  // The runtime estimate times a G18 quarter arc as a quarter, like the same
  // arc in G17, not as the remaining three quarters.
  const settings = { maxRateX: 5000, maxRateY: 5000, maxRateZ: 5000, accelX: 500, accelY: 500, accelZ: 500 } as ControllerSettings
  const seconds = (text: string) => buildJobTimingEstimate(parseGCode(text), settings)?.totalSeconds ?? NaN
  const xz = seconds('G21 G90\nG0 X0 Y0 Z0\nG18 G2 X5 Z-5 I5 K0 F100')
  const xy = seconds('G21 G90\nG0 X0 Y0 Z0\nG17 G3 X5 Y-5 I5 J0 F100')
  near(xz, xy, 'G18 quarter arc seconds', 0.05)
  near(xy, (Math.PI * 5 / 2) / 100 * 60, 'G17 quarter arc seconds', 0.2)
}

// The hook runs as separate views would, with controlled time and hook state.
let now = 1_000_000
Date.now = () => now
const timers = new Map<number, () => void>()
let nextTimer = 1
Object.assign(globalThis, {
  window: {
    setInterval: (fn: () => void) => { timers.set(nextTimer, fn); return nextTimer++ },
    clearInterval: (id: number) => { timers.delete(id) },
  },
})
const advance = (ms: number) => {
  now += ms
  for (const tick of [...timers.values()]) tick()
}

type HookArgs = Parameters<typeof useJobRuntimeEstimate>

function view(args: () => HookArgs) {
  const slots: any[] = []
  let index = 0
  let effects: Array<() => void> = []
  const changed = (a: any[], b: any[]) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))
  const memo = (fn: () => any, deps: any[]) => {
    const i = index++
    if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: fn(), deps }
    return slots[i].value
  }
  const dispatcher = {
    useState(initial: any) {
      const i = index++
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[i].value, (next: any) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next }]
    },
    useRef: (initial: any) => memo(() => ({ current: initial }), []),
    useMemo: memo,
    useEffect(effect: () => (() => void) | void, deps: any[]) {
      const i = index++
      if (!slots[i] || changed(slots[i].deps, deps)) {
        const previous = slots[i]
        slots[i] = { deps }
        effects.push(() => {
          previous?.cleanup?.()
          slots[i].cleanup = effect()
        })
      }
    },
  }
  return () => {
    const current = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
    const previous = current.current
    current.current = dispatcher
    index = 0
    effects = []
    let result
    try { result = useJobRuntimeEstimate(...args()) } finally { current.current = previous }
    for (const effect of effects) effect()
    return result!
  }
}

const origin = { x: 0, y: 0, z: 0 }
const status = (patch: Partial<MachineStatus> = {}): MachineStatus => ({
  state: 'Run', wpos: origin, mpos: origin, wco: origin, feed: 600, spindle: 0,
  feedOverride: 100, rapidOverride: 100, spindleOverride: 100, pinState: '',
  sdFilename: '/sd/job.nc', sdPercent: 0, ...patch,
})

{
  const job: GCodeModel = parseGCode('G21 G90\nG1 X100 F600')
  const total = buildJobTimingEstimate(job, settings)!.totalSeconds
  let machine = status()
  const args = (): HookArgs => [machine, job, settings, '/sd/job.nc', 'job.nc']

  const control = view(args)
  control()
  advance(4000)
  near(control().elapsedSeconds!, 4, 'elapsed run time', 0.01)
  // A view that mounts mid-job (the phone Control tab mounts on every visit)
  // continues the job's clock instead of starting from zero.
  const viewer = view(args)
  near(viewer().elapsedSeconds!, 4, 'a view mounted mid-job continues the clock', 0.01)

  // An open safety door holds the job like a feed hold.
  machine = status({ state: 'Door' })
  control(); viewer()
  advance(3000)
  const door = control()
  assert.equal(door.source, 'estimated', 'an open door keeps the job')
  near(door.elapsedSeconds!, 4, 'an open door pauses the clock', 0.01)

  // The estimate is a lower bound; once it runs out the time left is unknown.
  machine = status()
  control(); viewer()
  advance(Math.ceil(total * 1000))
  const late = control()
  assert.equal(late.remainingSeconds, null, 'no remaining time once the estimate has run out')
  assert.equal(late.totalSeconds, null)
  assert.equal(late.progressPercent, 99, 'progress stays below 100 % until the job ends')

  // The job ends; the next run of the same file starts its own clock.
  machine = status({ state: 'Idle', sdFilename: undefined, sdPercent: undefined })
  assert.equal(control().source, 'none')
  viewer()
  machine = status()
  control()
  near(control().elapsedSeconds!, 0, 'the next run starts from zero', 0.01)
  machine = status({ state: 'Idle', sdFilename: undefined, sdPercent: undefined })
  control(); viewer()
}

{
  // A job without a matching preview (another device, the console) extrapolates
  // the SD file progress over the run time watched so far.
  let machine = status({ sdFilename: '/sd/other.nc', sdPercent: 10 })
  const sdView = view(() => [machine, null, settings, null, null])
  sdView()
  assert.equal(sdView().remainingSeconds, null, 'no rate before the file has moved')
  advance(10_000)
  machine = status({ sdFilename: '/sd/other.nc', sdPercent: 20 })
  const sd = sdView()
  assert.equal(sd.source, 'sd')
  assert.equal(sd.progressPercent, 20)
  near(sd.remainingSeconds!, 80, '10 % in 10 s leaves 80 s for the other 80 %', 0.01)
}

function near(actual: number, expected: number, message: string, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`)
}

console.log('Job timing tests passed')
