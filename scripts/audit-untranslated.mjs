// List possible display strings which have not yet been assigned translation keys.
// This is an audit aid, not a proof of complete coverage: it cannot infer whether
// every arbitrary string in a program is user-facing.
import ts from 'typescript'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Deliberately untranslated product names, protocol labels, units and language names.
// Scoped by file so the same words elsewhere still require review.
const intentional = {
  'src/App.tsx': ['config.yaml'],
  'src/components/AboutModal.tsx': ['RST', 'FigUI v', 'Language / Idioma', 'English', 'Español'],
  'src/components/CodeEditor.tsx': ['Studio', 'YAML', ', Col'],
  'src/components/DRO.tsx': ['rpm', 'WCS'],
  'src/components/Header.tsx': ['RST'],
  'src/components/JogPad.tsx': ['mm/min', '(cmd:', 'RPM', 'XY', 'ABC'],
  'src/components/PluginLauncher.tsx': ['SD'],
  'src/components/Macros.tsx': ['KB'],
  'src/components/ProbePanel.tsx': ['Z0'],
  'src/components/SettingsPanel.tsx': ['Chip', 'Radio', 'Firmware', 'Config Studio', 'config.yaml', 'KB', 'MB'],
}
// Stable identifiers in data structures; display is translated at render time.
const intentionalData = {
  'src/components/ConfigStudio.tsx': ['StallGuard', 'StealthChop TOFF', 'CoolStep TOFF', 'DIAG0 push-pull', 'Macro 0', 'Macro 1', 'Macro 2', 'Macro 3', 'Tooling', 'Motion', 'Hardware', 'Safety & automation'],
  'src/components/GCodeViewer.tsx': ['Top', 'Bottom', 'Front', 'Back', 'Right', 'Left'],
  'src/components/SettingsPanel.tsx': ['ESP-NOW', 'ESP32', 'ESP32-S3', 'WiFi', 'Bluetooth'],
}
const findings = []
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) { scan(file); continue }
    if (!/\.tsx?$/.test(file)) continue
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    function add(node, value, data = false) {
      const text = value.trim().replace(/\s+/g, ' ')
      const path = relative('.', file).split(sep).join('/')
      if (!/[A-Za-z]{2}/.test(text) || (data ? intentionalData : intentional)[path]?.includes(text)) return
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      findings.push(`${path}:${line + 1}: ${text}`)
    }
    function expr(node) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text)
      else if (ts.isTemplateExpression(node)) add(node, node.head.text + node.templateSpans.map(span => span.literal.text).join(' '))
      else if (ts.isConditionalExpression(node)) { expr(node.whenTrue); expr(node.whenFalse) }
      else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) expr(node.right)
      else if (ts.isParenthesizedExpression(node)) expr(node.expression)
    }
    function visit(node) {
      if (ts.isCallExpression(node) && /^(?:alert|confirm|setError|setMessage|setErrorMsg|setFramingError|setStatusMsg)$/.test(node.expression.getText(source))) {
        for (const argument of node.arguments) expr(argument)
      }
      if (ts.isPropertyAssignment(node) && ['label', 'message', 'hint', 'description'].includes(node.name.getText(source)) && ts.isStringLiteral(node.initializer)) add(node.initializer, node.initializer.text, true)
      if (ts.isJsxText(node)) add(node, node.text)
      else if (ts.isJsxAttribute(node) && ['title', 'placeholder', 'aria-label', 'label'].includes(node.name.getText(source)) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) add(node.initializer, node.initializer.text)
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) expr(node.initializer.expression)
      } else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) && node.expression) expr(node.expression)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}
scan('src')
for (const finding of findings) console.log(finding)
console.log(`${findings.length} potential unkeyed display strings in audited contexts.`)
if (process.argv.includes('--strict') && findings.length) process.exitCode = 1
