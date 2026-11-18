// Alarm names as FluidNC prints them in "[MSG:INFO: ALARM: <name>]"
// (AlarmNames in FluidNC/src/Protocol.cpp). The name line arrives before
// "ALARM:<code>", so mapping it lets the UI show the translated message.
const FLUIDNC_ALARM_NAMES = [
  'hard limit', 'soft limit', 'abort cycle', 'probe fail initial', 'probe fail contact',
  'homing fail reset', 'homing fail door', 'homing fail pulloff', 'homing fail approach',
  'spindle control', 'input pin initially on', 'ambiguous switch', 'hard stop', 'unhomed',
  'init', 'expander reset', 'gcode error', 'probe hard limit',
]

export function alarmCodeFromName(name: string | undefined): number | undefined {
  const index = name ? FLUIDNC_ALARM_NAMES.indexOf(name.trim().toLowerCase()) : -1
  return index < 0 ? undefined : index + 1
}
