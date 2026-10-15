import { sendRaw } from './ws'
import { fetchFileContent } from './http'
import { useTerminalStore } from '../store/terminal'
import type { Macro } from '../types'

export async function runMacro(macro: Macro): Promise<void> {
  let command = macro.command
  if (!command && macro.filename) {
    if (!macro.target) {
      reportMacro(macro, `no storage is set for ${macro.filename}`)
      return
    }
    try {
      const path = macro.target === 'SD' ? `/sd${macro.filename}` : macro.filename
      command = await fetchFileContent(path, macro.target === 'SD' ? 'sd' : 'local')
    } catch (e) {
      reportMacro(macro, `${macro.filename} could not be read (${e instanceof Error ? e.message : String(e)})`)
      return
    }
    if (!command.trim()) {
      reportMacro(macro, `${macro.filename} is empty`)
      return
    }
  }
  if (!command) return
  for (const line of command.split('\n').map(l => l.trim()).filter(Boolean)) {
    sendRaw(line)
  }
}

function reportMacro(macro: Macro, problem: string) {
  useTerminalStore.getState().appendLine(`[MSG:WARN: Macro "${macro.label || 'Unnamed'}" not run: ${problem}]`)
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
