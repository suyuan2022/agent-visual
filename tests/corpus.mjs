// Runs every mermaid block in tests/fixtures/*.md through the plugin's fit() and prints what each becomes.
// usage: node tests/corpus.mjs [columns] [--experimental] [file.md ...]   (Node 23.6+ for the .ts import)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findDiagrams, fit } from '../core/core.ts'

const args = process.argv.slice(2)
const columns = Number(args.find(a => /^\d+$/.test(a)) ?? 120)
const experimental = args.includes('--experimental')
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const files = args.filter(a => a.endsWith('.md'))
let drawn = 0
let total = 0
for (const file of files.length > 0 ? files : fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
  for (const d of findDiagrams(fs.readFileSync(path.join(dir, file), 'utf8'))) {
    total++
    const f = fit(d.source, columns, { experimental })
    const head = d.source.split('\n').find(l => l.trim() !== '' && l.trim() !== '---' && !l.includes(':'))?.trim() ?? ''
    if (f.kind === 'art') drawn++
    console.log(String(total).padStart(3), head.slice(0, 26).padEnd(26), f.kind === 'art' ? `drawn ${f.art.width}x${f.art.plain.length}` : `box${f.note ? `  (${f.note})` : ''}`)
  }
}
console.log(`\n${drawn}/${total} drawn at ${columns} columns${experimental ? ', experimental' : ''}`)
