// Tables inside a list item: Claude Code draws a table at the reply's top level as a bordered grid, but one inside a
// list item as its raw pipes. pi draws both as grids, so this is the Claude Code side only. No Claude Code API here.

const FENCE = /^\s*(`{3,}|~{3,})/
const ROW = /^( +)\|.*\|\s*$/
const DELIMITER = /^ *\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const ITEM = /^ *(?:[-*+]|\d{1,9}[.)])(?: |$)/

const indentOf = (line: string) => line.length - line.trimStart().length

/** Whether a table indented by `indent` continues a list item: what precedes it, back to the item, is indented as deep. */
function inItem(before: string[], indent: number): boolean {
  for (let k = before.length - 1; k >= 0; k--) {
    const line = before[k]
    if (line.trim() === '') continue
    if (indentOf(line) < indent) return ITEM.test(line)
  }
  return false
}

/**
 * The reply with each table inside a list item moved to the top level, so Claude Code draws it as a grid. The table
 * and the rest of its item lose the item's indent, set off by blank lines, and the list goes on after them from the
 * next item, its number kept. Only what is drawn changes; the saved reply keeps its text.
 */
export function liftTables(text: string): string {
  if (!text.includes('|')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const run = FENCE.exec(line)?.[1]
    if (run !== undefined) fence = fence === undefined ? run : run[0] === fence[0] && run.length >= fence.length ? undefined : fence
    const head = fence === undefined ? ROW.exec(line) : null
    if (head === null || !DELIMITER.test(lines[i + 1] ?? '') || !inItem(out, head[1].length)) {
      out.push(line)
      continue
    }
    const indent = head[1].length
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
    // The table and the rest of its item, to the first line indented less (outside a fence the item holds).
    let inner: string | undefined
    let j = i
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (inner === undefined && l.trim() !== '' && indentOf(l) < indent) break
      const r = FENCE.exec(l)?.[1]
      if (r !== undefined) inner = inner === undefined ? r : r[0] === inner[0] && r.length >= inner.length ? undefined : inner
      out.push(l.slice(Math.min(indent, indentOf(l))))
    }
    if (j < lines.length && out[out.length - 1].trim() !== '') out.push('')
    i = j - 1
  }
  return out.join('\n')
}
