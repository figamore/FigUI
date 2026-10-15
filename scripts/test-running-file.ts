import assert from 'node:assert/strict'

// The viewer's imports touch these when they load.
const storage = { getItem: () => null, setItem() {}, removeItem() {} }
Object.assign(globalThis, {
  localStorage: storage,
  window: Object.assign(new EventTarget(), { location: { host: 'fluidnc.local', pathname: '/' } }),
  document: Object.assign(new EventTarget(), {
    documentElement: { classList: { add() {}, remove() {} } },
  }),
})

const { isRunningLoadedFile, runningFilePath } = await import('../src/components/GCodeViewer')

{
  // Only the file FluidNC reports running counts as the loaded preview's job.
  assert.equal(isRunningLoadedFile('/sd/F-Cu-Lazer.nc', '/sd/F-Cu-Lazer.nc', 'F-Cu-Lazer.nc'), true)
  assert.equal(isRunningLoadedFile('/sd/f-cu-lazer.nc', null, 'F-Cu-Lazer.nc'), true)
  assert.equal(isRunningLoadedFile('/sd/jobs/Maske.nc', 'jobs\\Maske.nc', null), true)
  assert.equal(isRunningLoadedFile('/sd/Maske-Lazer.nc', '/sd/F-Cu-Lazer.nc', 'F-Cu-Lazer.nc'), false)
  assert.equal(isRunningLoadedFile('/sd/Maske-Lazer.nc', null, null), false)
}

{
  // The Load button after a job from another device loads the file it ran.
  assert.equal(runningFilePath('/sd/jobs/Maske.nc'), '/sd/jobs/Maske.nc')
  assert.equal(runningFilePath('/localfs/a.nc'), '/localfs/a.nc')
  assert.equal(runningFilePath('Maske.nc'), '/sd/Maske.nc', 'a bare name is on the SD card')
  assert.equal(runningFilePath('/jobs/Maske.nc'), '/sd/jobs/Maske.nc')
}

console.log('Running file tests passed')
