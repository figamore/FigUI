// Decimal fields are typed as text with inputMode="decimal": a type="number"
// input in a page whose lang is "en" reads a comma as a group separator, so
// "0,5" typed on a Turkish or German keyboard arrived as 5.

const DECIMAL_RE = /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i

/** Parses a user-typed decimal that may use a comma or a dot. Empty or malformed input gives null. */
export function parseDecimalInput(text: string): number | null {
  const trimmed = text.trim()
  if (!DECIMAL_RE.test(trimmed)) return null
  const value = Number(trimmed.replace(',', '.'))
  return Number.isFinite(value) ? value : null
}
