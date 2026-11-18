import ts from 'typescript'

const SEPARATOR = '\x01'

// Group text and class lists from the minified module while leaving the rest
// of the code together. LZMA can then find matches within each kind of text.
export function separateStringLiterals(source, css) {
  if (source.includes(SEPARATOR) || css.includes(SEPARATOR)) return null

  const module = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  const code = []
  const literals = []
  let offset = 0

  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
      const start = node.getStart(module) + 1
      const end = node.end - (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1)
      const literal = source.slice(start, end)
      if ((literal.length >= 6 && literal.includes(' ')) || /[^\x00-\x7f]{2}/.test(literal)) {
        code.push(source.slice(offset, start), SEPARATOR)
        literals.push(literal)
        offset = end
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(module)

  if (!literals.length) return null
  // The original string delimiters keep placeholders apart, so two adjacent
  // separators mark the start of the literal table.
  code.push(source.slice(offset), css, SEPARATOR, SEPARATOR, literals.join(SEPARATOR))
  return code.join('')
}

// Embedded in the browser loader, so it needs no bindings from this module.
export function restoreStringLiterals(payload) {
  const separator = '\x01'
  const boundary = payload.indexOf(separator + separator)
  if (boundary < 0) throw new Error('Missing packed string literals')
  const code = payload.slice(0, boundary).split(separator)
  const literals = payload.slice(boundary + 2).split(separator)
  if (code.length !== literals.length + 1) throw new Error('Invalid packed string literals')
  for (let i = 0; i < literals.length; i++) code[i] += literals[i]
  return code.join('')
}
