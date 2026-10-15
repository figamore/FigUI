export const GCODE_EXTENSIONS = [
  '.g',
  '.gc',
  '.gco',
  '.gcode',
  '.nc',
  '.ncc',
  '.ngc',
  '.tap',
  '.cnc',
  '.dnc',
  '.eia',
  '.iso',
  '.min',
  '.mpf',
  '.spf',
] as const

export const GCODE_EXTENSION_SET = new Set<string>(GCODE_EXTENSIONS)

export const GCODE_ACCEPT_ATTRIBUTE = GCODE_EXTENSIONS.join(',')

export function getFileExtension(name: string) {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

export function isGCodeFileName(name: string) {
  return GCODE_EXTENSION_SET.has(getFileExtension(name))
}

function normalizedCardPath(path: string) {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(?:sd|localfs)\//i, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * True when `path` on filesystem `fs` is the file a running job reads
 * (`runningPath` is the name from the status report's SD: field) or a folder
 * that holds it. FAT names are case-insensitive. A running name without a
 * folder is matched by its basename, so a same-named file in a subfolder is
 * also treated as busy.
 */
export function pathHoldsRunningFile(
  runningPath: string | null | undefined,
  fs: 'sd' | 'local',
  path: string,
) {
  if (!runningPath) return false
  const runningFs = /^\/*localfs\//i.test(runningPath.replace(/\\/g, '/')) ? 'local' : 'sd'
  if (runningFs !== fs) return false
  const running = normalizedCardPath(runningPath)
  const target = normalizedCardPath(path)
  if (!running || !target) return false
  if (!running.includes('/')) return target.slice(target.lastIndexOf('/') + 1) === running
  return running === target || running.startsWith(`${target}/`)
}
