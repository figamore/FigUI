import { readFileSync } from 'node:fs'

/** Language names are displayed in their own language in the installed UI. */
export function readLanguages() {
  const data = JSON.parse(readFileSync(new URL('../locales/languages.json', import.meta.url), 'utf8'))
  if (!Array.isArray(data)) throw new Error('Invalid language registry')
  const seen = new Set()
  for (const item of data) {
    if (!item || typeof item.code !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item.code) ||
      typeof item.name !== 'string' || !item.name.trim() || !['ltr', 'rtl'].includes(item.direction) ||
      typeof item.enabled !== 'boolean' || seen.has(item.code)) throw new Error('Invalid or duplicate language registry entry')
    seen.add(item.code)
  }
  if (data[0]?.code !== 'en' || !data[0].enabled || data[0].direction !== 'ltr') throw new Error('English must be the first enabled language')
  return data
}

export function enabledLanguages() {
  return readLanguages().filter(language => language.enabled)
}
