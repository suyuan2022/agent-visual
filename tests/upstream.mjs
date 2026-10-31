// Runs lovely-mermaid's own golden cases (tests/upstream/cases, from xl0/lovely-mermaid 787abd0) against the
// vendored build, so a local patch that changes any upstream drawing shows up as a FAIL.
// usage: node tests/upstream.mjs [-v]   (-v prints source, expected and actual for each failure)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { render } = await import(path.join(here, '../core/vendor/lovely-mermaid/index.js'))
const casesDir = path.join(here, 'upstream/cases')
const verbose = process.argv.includes('-v')
// Cases a patch changes on purpose (core/vendor/README.md): counted apart, never a FAIL.
const CHANGED = new Set(['pie/basic.md'])
let changed = 0

// Each case file holds ```mermaid fences, each followed by a ```text fence with the expected plain art, or `(null)`.
let pass = 0
let fail = 0
for (const file of fs.readdirSync(casesDir, { recursive: true }).filter(f => f.endsWith('.md')).sort()) {
  const lines = fs.readFileSync(path.join(casesDir, file), 'utf8').split('\n')
  const blocks = []
  let open = null
  lines.forEach((l, i) => {
    if (open) {
      if (l === '```') {
        open.end = i
        blocks.push(open)
        open = null
      }
    } else if (l === '```mermaid' || l === '```text' || l === '```warnings') open = { kind: l.slice(3), start: i + 1 }
    else if (l.trim() === '(null)') blocks.push({ kind: 'null', start: i, end: i + 1 })
  })
  blocks.forEach((b, k) => {
    if (b.kind !== 'mermaid') return
    const expected = blocks[k + 1]
    const src = lines.slice(b.start, b.end).join('\n')
    const art = render(src)
    const want = expected.kind === 'null' ? null : lines.slice(expected.start, expected.end).join('\n')
    const got = art === null ? null : art.plain.join('\n')
    if (want === got) return pass++
    if (CHANGED.has(file.split(path.sep).join('/'))) return changed++
    fail++
    console.log(`FAIL ${file}:${b.start}`)
    if (verbose) console.log(`${src}\n--- want\n${want}\n--- got\n${got}\n`)
  })
}
console.log(`${pass} pass, ${fail} fail${changed ? `, ${changed} changed on purpose` : ''}`)
process.exitCode = fail === 0 ? 0 : 1
