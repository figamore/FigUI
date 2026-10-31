// The safety door pauses a running job like a feed hold.
export const isJobActiveState = (state: string) => state === 'Run' || state === 'Hold' || state === 'Door'

/**
 * Whether a controller job seen before a dropped connection is still the one
 * running: the machine is in a job state and, if a file was running, runs the
 * same file (another device may have started a different job meanwhile).
 */
export function jobContinues(state: string, sdFilename: string | undefined, sdFilenameBefore: string | null) {
  return isJobActiveState(state)
    && (!sdFilenameBefore || (!!sdFilename && isRunningFile(sdFilename, runningFilePath(sdFilenameBefore))))
}

export function controllerFilesystem(path: string): 'sd' | 'local' {
  return /^\/sd(?:\/|$)/i.test(path) ? 'sd' : 'local'
}

export function controllerRunCommand(path: string): string {
  return `$${controllerFilesystem(path) === 'sd' ? 'SD' : 'LocalFS'}/Run=${path}`
}

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/^\/+/, '')
    .replace(/^(?:sd|localfs|spiffs|littlefs)\//i, '')
    .replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function controllerPathsMatch(runningPath: string, loadedPath: string): boolean {
  return controllerFilesystem(runningPath) === controllerFilesystem(loadedPath)
    && normalizePath(runningPath) === normalizePath(loadedPath)
}

/** Config macros share the SD: status field with files, but have no file to load. */
export function isConfigMacro(sdFilename: string): boolean {
  return /^(?:after_homing|after_reset|after_unlock|startup_line[01]|macro[0-3])$/i.test(sdFilename)
}

/**
 * The loadable path of the file a status report's SD: field names. FluidNC
 * reports it with its /sd or /localfs mount; a bare name is on the SD card.
 */
export function runningFilePath(sdFilename: string) {
  const path = sdFilename.replace(/\\/g, '/')
  return /^\/(?:sd|localfs)\//i.test(path) ? path : `/sd/${path.replace(/^\/+/, '')}`
}

/** Whether the running file a status report names is the file at path: same filesystem and full path. */
export function isRunningFile(sdFilename: string, path: string | null | undefined) {
  return !isConfigMacro(sdFilename) && !!path && controllerPathsMatch(runningFilePath(sdFilename), path)
}
