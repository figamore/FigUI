import assert from 'node:assert/strict'
import { indexedDB, IDBObjectStore } from 'fake-indexeddb'
import type { MachineState } from '../src/types'

const storage = { getItem: () => null, setItem() {} }
Object.assign(globalThis, {
  indexedDB,
  localStorage: storage,
  sessionStorage: storage,
  window: new EventTarget(),
  document: { documentElement: { classList: { add() {}, remove() {} } } },
  Path2D: class { moveTo() {} lineTo() {} },
})

const { useMachineStore } = await import('../src/store')
const { useGCodeStore } = await import('../src/store/gcode')
const { setBase, deleteFile, deleteDir, renameFile, saveFileContent } = await import('../src/lib/http')
const { cachePreparedGCode, getCachedRunningGCode, invalidateCachedGCode } = await import('../src/lib/gcodeCache')
const controller = 'http://fluidnc.local'
const path = '/sd/folder/job.nc'
const source = 'G21 G90 G54\nG0 X0 Y0\nM3 S1000\nG1 X10 Y5 F600\nM30\n'
setBase(controller)

function status(state: MachineState, sdFilename?: string) {
  useMachineStore.setState({
    connected: true, statusReceived: true,
    status: { ...useMachineStore.getState().status, state, sdFilename, sdPercent: sdFilename ? 60.74 : undefined },
  })
}
const gcode = () => useGCodeStore.getState()
function run(pathname = path, state: MachineState = 'Run') { status(state, pathname) }
const savedFile = (pathname = path, text = source) => ({ path: pathname, fileName: 'job.nc', text, parseOptions: {} })

const originalFetch = globalThis.fetch
try {
  // Exercise the actual download, parsing, and persistence path while idle.
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push(url.pathname)
    if (url.pathname === '/command') {
      assert.equal(url.searchParams.get('plain'), '$#')
      return new Response('[G54:12,4,0]\n[G55:100,20,0]\nok\n')
    }
    assert.equal(url.pathname, path)
    assert.equal(init?.cache, 'no-store')
    return new Response(source)
  }
  status('Idle')
  useMachineStore.setState({ status: {
    ...useMachineStore.getState().status, wco: { x: 12, y: 4, z: 0 }, gcodeModes: { wcs: 'G54' },
  } })
  await gcode().loadFile(path)
  assert.deepEqual(requests, [path, '/command'])
  assert.equal(gcode().sourceText, source)
  assert(gcode().is3DReady)
  const originalGeometry = Array.from(gcode().model!.segments.px)
  assert.equal(gcode().restoredFromCache, false)
  gcode().startTrackedJob('controller')
  await cachePreparedGCode(controller, savedFile('/sd/selected-after-start.nc'))
  gcode().cancelTrackedJob('controller')

  // Reset all viewer state to emulate reload. During restoration, ANY HTTP
  // request (including $# for offsets) fails this test.
  let forbiddenRequests = 0
  globalThis.fetch = async () => {
    forbiddenRequests++
    throw new Error('Restoring a running job must not issue HTTP requests')
  }
  for (const state of ['Run', 'Hold', 'Door', 'Idle'] as MachineState[]) {
    gcode().clear()
    run(path, state)
    useMachineStore.setState({ status: { ...useMachineStore.getState().status, wco: { x: 999, y: 999, z: 0 } } })
    await gcode().restoreRunningFile(path)
    assert.equal(gcode().sourceText, source, `${state}: saved source must be restored`)
    assert.equal(gcode().loadedPath, path)
    assert.equal(gcode().restoredFromCache, true)
    assert(gcode().paths2D && gcode().is3DReady)
    assert.deepEqual(Array.from(gcode().model!.segments.px), originalGeometry, 'use the saved work offsets')
    assert.equal(useMachineStore.getState().status.sdPercent, 60.74)
    assert.equal(gcode().pendingPath, null, 'a cached restore must not offer Start without preview')
    assert.equal(gcode().trackedJob, null, 'a restore must not start or claim a job')
    const model = gcode().model
    await gcode().loadFile('/sd/other.nc')
    await gcode().loadFromText('G0 X100', 'other.nc')
    assert.equal(gcode().model, model, 'regular file loads must remain blocked while a controller job is active')
    assert.equal(gcode().cancelAndStartJob(path), false)
  }

  // The running file survives preparing another file afterward. Full paths,
  // filesystem identity, and controller origin prevent false matches.
  await cachePreparedGCode(controller, savedFile('/sd/other.nc', 'G0 X42'))
  assert.equal((await getCachedRunningGCode(controller, path))?.text, source)
  for (const mismatch of ['/sd/other-folder/job.nc', '/littlefs/folder/job.nc']) {
    gcode().clear()
    run(mismatch)
    await gcode().restoreRunningFile(mismatch)
    assert.equal(gcode().model, null)
  }
  gcode().clear()
  run()
  setBase('http://another-controller.local')
  await gcode().restoreRunningFile(path)
  assert.equal(gcode().model, null)
  setBase(controller)
  useMachineStore.setState({ statusReceived: false })
  await gcode().restoreRunningFile(path)
  assert.equal(gcode().model, null, 'cached state cannot substitute for a fresh status report')

  // Local filesystem mount aliases are equivalent; local filenames retain
  // case, and SD filenames follow the card's case-insensitive matching.
  await cachePreparedGCode(controller, savedFile('/Job.nc'))
  assert.equal((await getCachedRunningGCode(controller, '/littlefs/Job.nc'))?.path, '/Job.nc')
  assert.equal(await getCachedRunningGCode(controller, '/littlefs/job.nc'), null)
  await cachePreparedGCode(controller, savedFile('/sd/Case.NC'))
  assert.equal((await getCachedRunningGCode(controller, '/sd/case.nc'))?.path, '/sd/Case.NC')

  // A path change or newer viewer request while the DB read is pending must
  // invalidate the old restore, rather than displaying the wrong running file.
  await cachePreparedGCode(controller, savedFile())
  gcode().clear()
  run()
  const stale = gcode().restoreRunningFile(path)
  run('/sd/new-job.nc')
  await stale
  assert.equal(gcode().model, null)
  run()
  const cancelled = gcode().restoreRunningFile(path)
  gcode().clear()
  await cancelled
  assert.equal(gcode().model, null)
  const parsing = gcode().restoreRunningFile(path)
  const unsubscribe = useGCodeStore.subscribe(value => { if (value.loading) run('/sd/new-job.nc') })
  await parsing
  unsubscribe()
  assert.equal(gcode().model, null, 'job changes during parsing must cancel the restore')
  assert.equal(gcode().loading, false)
  assert.equal(forbiddenRequests, 0, 'running-job restores must never request controller resources')

  useGCodeStore.setState({ loadedPath: path, sourceText: null, model: null })
  run()
  await gcode().restoreRunningFile(path)
  assert.equal(gcode().model, null, 'Start without preview must be respected within the current session')
  gcode().clear()

  // Upload previews become persistent only after the controller upload succeeds.
  status('Idle')
  useMachineStore.setState({ connected: false })
  gcode().beginSdUpload('/sd/upload.nc')
  await gcode().loadFromText(source, 'upload.nc', '/sd/upload.nc')
  assert.equal(await getCachedRunningGCode(controller, '/sd/upload.nc'), null)
  await gcode().completeSdUpload('/sd/upload.nc')
  assert.equal((await getCachedRunningGCode(controller, '/sd/upload.nc'))?.text, source)
  gcode().beginSdUpload('/sd/failed-upload.nc')
  await gcode().loadFromText(source, 'failed-upload.nc', '/sd/failed-upload.nc')
  gcode().failSdUpload('/sd/failed-upload.nc')
  assert.equal(await getCachedRunningGCode(controller, '/sd/failed-upload.nc'), null)

  // Real mutation helpers invalidate both persisted slots before resolving.
  globalThis.fetch = async () => new Response('{"status":"ok"}')
  for (const mutate of [
    () => deleteFile('/sd/folder/', 'job.nc'),
    () => renameFile('/sd/folder/', 'job.nc', 'renamed.nc'),
    () => renameFile('/sd/', 'folder', 'renamed-folder'),
    () => deleteDir('/sd/', 'folder'),
  ]) {
    await cachePreparedGCode(controller, savedFile())
    await getCachedRunningGCode(controller, path)
    await mutate()
    assert.equal(await getCachedRunningGCode(controller, path), null)
  }
  class UploadRequest {
    static responseStatus = 200
    upload = {}
    status = UploadRequest.responseStatus
    responseText = '{"status":"ok"}'
    onload = () => {}
    open() {}
    send() { queueMicrotask(() => this.onload()) }
  }
  Object.assign(globalThis, { XMLHttpRequest: UploadRequest })
  await cachePreparedGCode(controller, savedFile())
  await saveFileContent('/sd/folder/', 'job.nc', 'G0 X99', 'sd')
  assert.equal(await getCachedRunningGCode(controller, path), null)
  await cachePreparedGCode(controller, savedFile())
  UploadRequest.responseStatus = 500
  await assert.rejects(saveFileContent('/sd/folder/', 'job.nc', 'G0 X99', 'sd'))
  assert.equal(await getCachedRunningGCode(controller, path), null, 'a failed replacement may have truncated the file')

  // Invalid stored data is ignored, and quota failure while promoting the
  // last job still permits reading an already saved preview.
  const put = IDBObjectStore.prototype.put
  await cachePreparedGCode(controller, savedFile())
  IDBObjectStore.prototype.put = function(...args) {
    const request = put.apply(this, args)
    this.transaction.abort()
    return request
  }
  assert.equal((await getCachedRunningGCode(controller, path))?.text, source)
  IDBObjectStore.prototype.put = put
  await cachePreparedGCode(controller, { ...savedFile('/sd/corrupt.nc'), parseOptions: { currentWco: { x: NaN, y: 0, z: 0 } } })
  assert.equal(await getCachedRunningGCode(controller, '/sd/corrupt.nc'), null)
  await invalidateCachedGCode(controller, '/sd/', true)
  assert.equal(await getCachedRunningGCode(controller, path), null)

  Object.assign(globalThis, { indexedDB: { open() { throw new DOMException('Unavailable', 'SecurityError') } } })
  assert.equal(await getCachedRunningGCode(controller, path), null)
  gcode().clear()
  await gcode().loadFromText(source, 'job.nc', path)
  assert(gcode().model, 'disabled storage must not prevent ordinary previews')
  Object.assign(globalThis, { indexedDB })
  gcode().clear()
  console.log('Persistent G-code cache, running-job restoration, and invalidation checks passed')
} finally {
  globalThis.fetch = originalFetch
}
