import { controllerPathsMatch } from './controllerFiles'

export function supportsSingleBlock(version: string | undefined) {
  const match = version?.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?=$|[^\d])/i)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major > 4 || (major === 4 && (minor > 1 || (minor === 1 && patch >= 1)))
}

export interface PendingBlock {
  path: string
  line: number
  preview: string
}

export function parseStepReport(raw: string): PendingBlock | null {
  const match = raw.match(/^\[MSG:INFO:\s*Step (.+?):(\d+)(?: (.*))?\]$/)
  if (!match) return null
  const line = Number(match[2])
  if (!Number.isSafeInteger(line) || line < 1) return null
  return { path: match[1], line, preview: match[3] ?? '' }
}

export function pendingBlockMatchesSource(block: PendingBlock, loadedPath: string | null) {
  return !!loadedPath && controllerPathsMatch(block.path, loadedPath)
}
