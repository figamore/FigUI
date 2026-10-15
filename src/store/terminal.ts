import { create } from 'zustand'
import { onLine } from '../lib/ws'
import { classifyLine } from '../lib/parser'

const MAX_LINES = 1000
const MAX_HISTORY = 100

export type LineKind = ReturnType<typeof classifyLine>

export interface LogLine {
  id: number
  text: string
  kind: LineKind
}

interface TerminalStore {
  lines: LogLine[]
  history: string[]
  verbose: boolean
  autoScroll: boolean
  setVerbose: (v: boolean) => void
  setAutoScroll: (v: boolean) => void
  pushHistory: (cmd: string) => void
  appendLine: (text: string) => void
  clear: () => void
}

let lineId = 0
let lastStatusKey: string | null = null

function statusKey(line: string): string {
  const parts = line.slice(1, -1).split('|')
    .filter(p => !p.startsWith('WCO:') && !p.startsWith('Ov:') && !p.startsWith('A:'))
  return parts.join('|')
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  lines: [],
  history: [],
  verbose: false,
  autoScroll: true,

  setVerbose: (verbose) => set({ verbose }),
  setAutoScroll: (autoScroll) => set({ autoScroll }),

  pushHistory: (cmd) =>
    set(state => ({ history: [cmd, ...state.history.slice(0, MAX_HISTORY - 1)] })),

  appendLine: (text) => {
    const kind = classifyLine(text)
    if (!get().verbose && (kind === 'status' || kind === 'ok')) return
    if (kind === 'status') {
      const key = statusKey(text)
      if (key === lastStatusKey) return
      lastStatusKey = key
    }
    set(state => {
      const added: LogLine[] = []
      // The Grbl welcome banner means the controller just reset. Keep the lines
      // before it, since they often say why, and mark the reset with the time.
      if (text.startsWith('Grbl ') && state.lines.length > 0) {
        added.push({ id: lineId++, text: `--- Controller reset ${new Date().toLocaleTimeString()} ---`, kind: 'normal' })
      }
      added.push({ id: lineId++, text, kind })
      return { lines: [...state.lines, ...added].slice(-MAX_LINES) }
    })
  },

  clear: () => set({ lines: [] }),
}))

onLine((line) => useTerminalStore.getState().appendLine(line))
