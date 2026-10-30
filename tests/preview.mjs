// Prints every fixture as the terminal would show it, in lovely-mermaid's default ANSI theme.
// usage: node tests/preview.mjs [columns] [number...]   (numbers pick fixtures, 1-based)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findDiagrams, fit } from '../core/core.ts'
import { DEFAULT_THEME, toAnsi } from '../core/vendor/lovely-mermaid/index.js'

const [cols = '100', ...picks] = process.argv.slice(2)
const columns = Number(cols)
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
let n = 0
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
  for (const d of findDiagrams(fs.readFileSync(path.join(dir, file), 'utf8'))) {
    n++
    if (picks.length > 0 && !picks.includes(String(n))) continue
    const f = fit(d.source, columns)
    console.log(`\x1b[31m── ${n} ${d.source.split('\n')[0].trim()}\x1b[39m`)
    console.log(f.kind === 'art' ? toAnsi(f.art, DEFAULT_THEME).join('\n') : `(source)${f.note ? ` ${f.note}` : ''}`)
    console.log()
  }
}
