/** Source-language fallback for tests and non-Vite consumers. Vite replaces
 * each explicitly keyed call with a single build-time locale string. */
export function uiText(_key: string, english: string): string {
  return english
}

/** Substitute named values after translation, allowing languages to reorder them. */
export function formatUi(message: string, values: Record<string, unknown>): string {
  return message.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  )
}

/** Select a locale-correct plural form. Vite replaces the English forms with
 * the selected language's forms at build time. */
export function uiPlural(_key: string, count: number, forms: Record<string, string>): string {
  const locale = typeof __FIGUI_LOCALE__ === 'undefined' ? 'en' : __FIGUI_LOCALE__
  const category = new Intl.PluralRules(locale).select(count)
  return formatUi(forms[category] ?? forms.other, { count })
}
