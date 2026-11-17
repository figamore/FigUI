import { uiText as __uiText, formatUi } from './i18n'
import { lineRefusalReason, sendRaw } from './ws'
import { fetchFileContent } from './http'
import { useTerminalStore } from '../store/terminal'
import type { Macro } from '../types'

/** Sends a line from a button or macro; a refused line is reported in the terminal. */
export function sendControlLine(cmd: string, label: string) {
  if (sendRaw(cmd)) return true
  useTerminalStore.getState().appendLine(formatUi(__uiText("lib.macros.not_sent.1", "[MSG:WARN: {label} not sent: {reason}]"), { label, reason: lineRefusalReason() }))
  return false
}

export async function runMacro(macro: Macro): Promise<void> {
  let command = macro.command
  if (!command && macro.filename) {
    if (!macro.target) {
      reportMacro(macro, formatUi(__uiText("lib.macros.no_storage.1", "no storage is set for {filename}"), { filename: macro.filename }))
      return
    }
    try {
      const path = macro.target === 'SD' ? `/sd${macro.filename}` : macro.filename
      command = await fetchFileContent(path, macro.target === 'SD' ? 'sd' : 'local')
    } catch (e) {
      reportMacro(macro, formatUi(__uiText("lib.macros.template_coverage.1", "{v0} could not be read ({v1})"), { v0: macro.filename, v1: e instanceof Error ? e.message : String(e) }))
      return
    }
    if (!command.trim()) {
      reportMacro(macro, formatUi(__uiText("lib.macros.empty.1", "{filename} is empty"), { filename: macro.filename }))
      return
    }
  }
  if (!command) return
  for (const line of command.split('\n').map(l => l.trim()).filter(Boolean)) {
    if (!sendControlLine(line, `Macro "${macro.label || __uiText("lib.macros.unnamed.1", "Unnamed")}"`)) return
  }
}

function reportMacro(macro: Macro, problem: string) {
  useTerminalStore.getState().appendLine(formatUi(__uiText("lib.macros.not_run.1", "[MSG:WARN: Macro \"{label}\" not run: {problem}]"), { label: macro.label || __uiText("lib.macros.unnamed.2", "Unnamed"), problem }))
}

export const MACRO_BTN_CLASS: Record<Macro['color'], string> = {
  default: 'btn-ghost',
  accent:  'btn-accent-soft',
  ok:      'btn-ok',
  warn:    'btn-warn',
  danger:  'btn-danger',
  info:    'btn-info',
  purple:  'btn-purple',
  teal:    'btn-teal',
}
