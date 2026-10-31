import assert from 'node:assert/strict'
import { isConfigMacro, isRunningFile, runningFilePath } from '../src/lib/controllerFiles'

{
  // Config macros are reported in SD: too, but cannot be downloaded. Keep
  // actual files named after a macro (including extensionless ones) loadable.
  for (const name of ['after_homing', 'after_reset', 'after_unlock', 'startup_line0', 'startup_line1', 'Macro0', 'Macro1', 'Macro2', 'Macro3']) {
    assert.equal(isConfigMacro(name), true, name)
    assert.equal(isRunningFile(name, `/sd/${name}`), false, 'a config macro is not the loaded file')
    assert.equal(isConfigMacro(`/sd/${name}`), false, 'a mounted path is a real file')
    assert.equal(isConfigMacro(`/localfs/${name}`), false)
    assert.equal(isConfigMacro(`${name}.nc`), false)
  }
  assert.equal(isConfigMacro('jobs/after_homing'), false)
  assert.equal(isConfigMacro('Maske.nc'), false)
  assert.equal(isConfigMacro('extensionless'), false, 'do not require file extensions')
}

{
  // Only the file FluidNC reports running counts as the loaded preview's job:
  // filesystem and full path, not the name alone.
  assert.equal(isRunningFile('/sd/F-Cu-Lazer.nc', '/sd/F-Cu-Lazer.nc'), true)
  assert.equal(isRunningFile('/sd/f-cu-lazer.nc', '/sd/F-Cu-Lazer.nc'), true, 'FAT names are case-insensitive')
  assert.equal(isRunningFile('/sd/jobs/Maske.nc', '/sd/jobs/Maske.nc'), true)
  assert.equal(isRunningFile('/sd/Maske-Lazer.nc', '/sd/F-Cu-Lazer.nc'), false)
  assert.equal(isRunningFile('/sd/Maske-Lazer.nc', null), false, 'a preview with no controller path')
  assert.equal(isRunningFile('/sd/old/Maske.nc', '/sd/jobs/Maske.nc'), false, 'same name, other folder')
  assert.equal(isRunningFile('/sd/Maske.nc', '/sd/jobs/Maske.nc'), false, 'same name, other folder')
  assert.equal(isRunningFile('/localfs/Maske.nc', '/sd/Maske.nc'), false, 'same name, other filesystem')
  assert.equal(isRunningFile('/sd/Maske.nc', '/Maske.nc'), false, 'an internal-flash file is not the SD file')
  assert.equal(isRunningFile('/localfs/Maske.nc', '/Maske.nc'), true)
  assert.equal(isRunningFile('Maske.nc', '/sd/Maske.nc'), true, 'a bare name is on the SD card')
}

{
  // The Load button after a job from another device loads the file it ran.
  assert.equal(runningFilePath('/sd/jobs/Maske.nc'), '/sd/jobs/Maske.nc')
  assert.equal(runningFilePath('/localfs/a.nc'), '/localfs/a.nc')
  assert.equal(runningFilePath('Maske.nc'), '/sd/Maske.nc', 'a bare name is on the SD card')
  assert.equal(runningFilePath('/jobs/Maske.nc'), '/sd/jobs/Maske.nc')
}

console.log('Running file tests passed')
