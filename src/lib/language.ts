import { uiText as __uiText } from './i18n'

export interface UiLanguageInfo { code: string; name: string }
export type UiLanguage = string

// Vite supplies only release-enabled languages. The fallback is for test and
// non-Vite consumers; disabled languages are never offered to users.
export const SUPPORTED_LANGUAGES: readonly UiLanguageInfo[] = typeof __FIGUI_LANGUAGES__ === 'undefined'
  ? [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }]
  : __FIGUI_LANGUAGES__

export const UI_LANGUAGE: UiLanguage = SUPPORTED_LANGUAGES.find(language => language.code === import.meta.env.VITE_FIGUI_LOCALE)?.code ?? 'en'
export const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(SUPPORTED_LANGUAGES.map(language => [language.code, language.name]))

/** Only allow known languages and numeric release versions in download paths. */
export function firmwareUrl(version: string, language: UiLanguage): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(__uiText("lib.language.coverage.1", "Invalid release version"))
  if (!SUPPORTED_LANGUAGES.some(item => item.code === language)) throw new Error(__uiText("lib.language.unsupported.1", "Unsupported language"))
  const name = language === 'en' ? 'index.html.gz' : `index.${language}.html.gz`
  return `https://figamore.github.io/FigUI/firmware/v${version}/${name}`
}
