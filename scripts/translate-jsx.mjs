import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enabledLanguages } from './languages.mjs'

export function parseCatalog(file, text) {
  const json = JSON.parse(text)
  const tree = ts.parseJsonText(`${file}.json`, text)
  const object = tree.statements[0]?.expression
  if (!object || !ts.isObjectLiteralExpression(object) || Array.isArray(json) || !json || typeof json !== 'object') throw new Error(`${file}: expected a JSON object`)
  const keys = new Set()
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) throw new Error(`${file}: invalid catalog entry`)
    const key = property.name.text
    if (keys.has(key)) throw new Error(`${file}: duplicate translation key ${key}`)
    keys.add(key)
    if (!/^[A-Za-z0-9_.]+$/.test(key) || typeof json[key] !== 'string' || !json[key].trim()) throw new Error(`${file}: invalid translation ${key}`)
  }
  return json
}

function readCatalog(file) {
  return parseCatalog(file, readFileSync(new URL(`../locales/${file}.json`, import.meta.url), 'utf8'))
}

/** Parse nested plural catalogs while rejecting duplicate keys and categories. */
export function parsePluralCatalog(file, text) {
  const catalog = JSON.parse(text)
  const tree = ts.parseJsonText(file, text)
  const root = tree.statements[0]?.expression
  if (!root || !ts.isObjectLiteralExpression(root) || !catalog || Array.isArray(catalog)) throw new Error(`${file}: invalid plural catalog`)
  const seen = new Set()
  for (const property of root.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isObjectLiteralExpression(property.initializer)) throw new Error(`${file}: invalid plural entry`)
    const key = property.name.text
    if (seen.has(key) || !/^[A-Za-z0-9_.]+$/.test(key)) throw new Error(`${file}: duplicate or invalid plural key ${key}`)
    seen.add(key)
    const categories = new Set()
    for (const item of property.initializer.properties) {
      if (!ts.isPropertyAssignment(item) || !ts.isStringLiteral(item.name) || !ts.isStringLiteral(item.initializer)) throw new Error(`${file}: invalid plural form ${key}`)
      const category = item.name.text
      if (categories.has(category) || !['zero', 'one', 'two', 'few', 'many', 'other'].includes(category) || !item.initializer.text.trim()) throw new Error(`${file}: duplicate or invalid plural form ${key}.${category}`)
      categories.add(category)
    }
  }
  return catalog
}

function readPluralCatalog(code) {
  const file = `plurals.${code}.json`
  return parsePluralCatalog(file, readFileSync(new URL(`../locales/${file}`, import.meta.url), 'utf8'))
}

function jsString(value) {
  // Safe even when Vite inlines the JavaScript inside an HTML script element.
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function placeholders(text) {
  return [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m => m[1]).sort().join(',')
}

export function validateCatalogs(english, translated) {
  for (const key of Object.keys(english)) {
    if (!Object.hasOwn(translated, key) || typeof translated[key] !== 'string' || !translated[key].trim()) throw new Error(`Missing translation: ${key}`)
    if (placeholders(english[key]) !== placeholders(translated[key])) throw new Error(`Translation placeholders differ: ${key}`)
  }
  for (const key of Object.keys(translated)) if (!Object.hasOwn(english, key)) throw new Error(`Unknown translation: ${key}`)
}

export function validatePluralCatalogs(english, translated, locale) {
  const required = new Intl.PluralRules(locale).resolvedOptions().pluralCategories
  for (const key of Object.keys(english)) {
    if (!Object.hasOwn(translated, key)) throw new Error(`Missing plural translation: ${key}`)
    const source = english[key]
    if (!source || typeof source.other !== 'string' || !source.other.trim()) throw new Error(`Missing English plural form: ${key}.other`)
    for (const category of required) {
      if (!Object.hasOwn(translated[key], category)) throw new Error(`Missing plural form: ${key}.${category}`)
    }
    for (const value of Object.values(translated[key])) {
      if (typeof value !== 'string' || !value.trim() || placeholders(source.other) !== placeholders(value)) throw new Error(`Invalid plural translation: ${key}`)
    }
  }
  for (const key of Object.keys(translated)) if (!Object.hasOwn(english, key)) throw new Error(`Unknown plural translation: ${key}`)
}

/** A key has exactly one source location; missing and stale entries fail builds. */
export function validateMessageUsage(english, root = fileURLToPath(new URL('../src/', import.meta.url)), pluralEnglish = {}) {
  const seen = new Map()
  const seenPlural = new Map()
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) { scan(file); continue }
      if (!/\.tsx?$/.test(file)) continue
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__uiText') {
          const [key, fallback] = node.arguments
          if (node.arguments.length !== 2 || !ts.isStringLiteral(key) || !ts.isStringLiteral(fallback)) throw new Error(`${file}: translation calls require literal key and English text`)
          if (!Object.hasOwn(english, key.text)) throw new Error(`${file}: unknown translation key ${key.text}`)
          if (english[key.text] !== fallback.text) throw new Error(`${file}: English text differs from catalog for ${key.text}`)
          if (seen.has(key.text)) throw new Error(`Translation key ${key.text} used twice: ${seen.get(key.text)} and ${file}`)
          seen.set(key.text, file)
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__uiPlural') {
          const [key, , fallback] = node.arguments
          if (node.arguments.length !== 3 || !ts.isStringLiteral(key) || !ts.isObjectLiteralExpression(fallback)) throw new Error(`${file}: plural calls require a literal key and English forms`)
          if (!Object.hasOwn(pluralEnglish, key.text)) throw new Error(`${file}: unknown plural key ${key.text}`)
          if (seenPlural.has(key.text)) throw new Error(`Plural key ${key.text} used twice`)
          const forms = {}
          for (const entry of fallback.properties) {
            if (!ts.isPropertyAssignment(entry) || !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) || !ts.isStringLiteral(entry.initializer)) throw new Error(`${file}: invalid English plural form`)
            if (Object.hasOwn(forms, entry.name.text)) throw new Error(`${file}: duplicate English plural form`)
            forms[entry.name.text] = entry.initializer.text
          }
          if (Object.keys(forms).length !== Object.keys(pluralEnglish[key.text]).length || Object.keys(forms).some(category => forms[category] !== pluralEnglish[key.text][category])) throw new Error(`${file}: English plural forms differ for ${key.text}`)
          seenPlural.set(key.text, file)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  scan(root)
  for (const key of Object.keys(english)) if (!seen.has(key)) throw new Error(`Unused translation key: ${key}`)
  for (const key of Object.keys(pluralEnglish)) if (!seenPlural.has(key)) throw new Error(`Unused plural key: ${key}`)
}

/** Only explicitly keyed calls are translated. Commands and arbitrary text are untouched. */
export function translateJsx(locale = 'en') {
  const languages = enabledLanguages()
  const language = languages.find(item => item.code === locale)
  if (!language) throw new Error(`Unsupported UI locale: ${locale}`)
  const english = readCatalog('en')
  const catalogs = Object.fromEntries(languages.map(item => [item.code, item.code === 'en' ? english : readCatalog(item.code)]))
  for (const catalog of Object.values(catalogs)) validateCatalogs(english, catalog)
  const pluralEnglish = readPluralCatalog('en')
  const plurals = Object.fromEntries(languages.map(item => [item.code, item.code === 'en' ? pluralEnglish : readPluralCatalog(item.code)]))
  for (const item of languages) validatePluralCatalogs(pluralEnglish, plurals[item.code], item.code)
  validateMessageUsage(english, undefined, pluralEnglish)
  const messages = catalogs[locale]
  return {
    name: 'figui-translate-jsx',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/src\/.*\.tsx?$/.test(id)) return null
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, id.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const edits = []
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__uiText') {
          const [key, fallback] = node.arguments
          if (node.arguments.length !== 2 || !ts.isStringLiteral(key) || !ts.isStringLiteral(fallback)) throw new Error(`${id}: translation calls require literal key and English text`)
          if (!Object.hasOwn(english, key.text)) throw new Error(`${id}: unknown translation key ${key.text}`)
          if (english[key.text] !== fallback.text) throw new Error(`${id}: English text differs from catalog for ${key.text}`)
          edits.push([node.getStart(source), node.end, jsString(messages[key.text])])
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__uiPlural') {
          const [key, , fallback] = node.arguments
          if (node.arguments.length !== 3 || !ts.isStringLiteral(key) || !fallback || !Object.hasOwn(plurals[locale], key.text)) throw new Error(`${id}: invalid plural key`)
          const forms = Object.entries(plurals[locale][key.text]).map(([category, value]) => `${JSON.stringify(category)}:${jsString(value)}`).join(',')
          edits.push([fallback.getStart(source), fallback.end, `{${forms}}`])
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      if (!edits.length) return null
      for (const [start, end, replacement] of edits.reverse()) code = code.slice(0, start) + replacement + code.slice(end)
      return { code, map: null }
    },
    transformIndexHtml(html) {
      return html.replace('<html lang="en">', `<html lang="${language.code}"${language.direction === 'rtl' ? ' dir="rtl"' : ''}>`)
    },
  }
}
