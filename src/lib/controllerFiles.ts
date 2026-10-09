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
