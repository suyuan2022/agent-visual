// The common types as mermaid.js reads them, respelled in what lovely-mermaid draws: the newer or rarer syntax it misses or misreads.
import { t } from './i18n.ts'
import { srcLines, stripMarkdown } from './vendor/lovely-mermaid/labels.js'
import { frontmatterEnd } from './vendor/lovely-mermaid/statements.js'
import type { Role } from './vendor/lovely-mermaid/index.js'

/** The respelled source, plus rows of detail to print under the drawing for what the drawing cannot hold. */
export type Normalized = { src: string; after: [string, Role][][] }

/**
 * mermaid's `#name;` entities lovely has no name for, as characters; the
 * five it knows (and every `#123;`) become its own `&name;` spelling.
 */
const NAMED: Record<string, string> = {
  nbsp: ' ', hearts: '♥', spades: '♠', clubs: '♣', diams: '♦', infin: '∞', check: '✓', cross: '✗', star: '☆', starf: '★',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', middot: '·', bull: '•',
  hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐', rArr: '⇒', hArr: '⇔',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', equiv: '≡', sum: '∑', radic: '√', part: '∂', ang: '∠', empty: '∅', isin: '∈',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π',
  sigma: 'σ', Sigma: 'Σ', tau: 'τ', phi: 'φ', omega: 'ω', Omega: 'Ω',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
}
const LOVELY = new Set(['lt', 'gt', 'amp', 'quot', 'apos'])
const LITERAL: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/**
 * Where lovely ends a statement at `;` (state, sequence, class, timeline),
 * so `&quot;` would cut the line: entities there become the characters
 * themselves. Elsewhere labels are quoted, so `"` must stay an entity.
 */
const SPLITS_AT_SEMICOLON = new Set(['statediagram', 'statediagram-v2', 'sequencediagram', 'classdiagram', 'classdiagram-v2', 'timeline'])

function entities(line: string, literal: boolean): string {
  return line.replace(/#(\w+);/g, (whole, body: string) => {
    if (/^\d+$/.test(body)) {
      const code = Number(body)
      if (!literal) return `&#${body};`
      return code === 59 || code === 35 || code < 0x20 || code > 0x10ffff ? whole : String.fromCodePoint(code)
    }
    if (LOVELY.has(body)) return literal ? LITERAL[body] : `&${body};`
    return NAMED[body] ?? whole
  })
}

/** A `` "`markdown`" `` string as the plain quoted label it shows, its lines joined: lovely draws a label on one line. */
function markdownStrings(text: string): string {
  return text.replace(/"`([\s\S]*?)`"/g, (_, inner: string) => `"${stripMarkdown(inner.replace(/\s*\n\s*/g, ' ').trim())}"`)
}

const STYLE = /^\s*(style|classDef|linkStyle)\b/

/** Font Awesome icons (`fa:fa-camera`) draw as nothing in a terminal; a label that was only icons keeps their names. */
function icons(line: string): string {
  return line.replace(/([[({])([^[\](){}]*\bfa[a-z]*:fa-[\w-]+[^[\](){}]*)([\])}])/g, (_, open: string, body: string, close: string) => {
    const names = [...body.matchAll(/\bfa[a-z]*:fa-([\w-]+)/g)].map(m => m[1])
    const rest = body.replace(/\s*\bfa[a-z]*:fa-[\w-]+\s*/g, ' ').replace(/^(["'`]?)\s+|\s+(["'`]?)$/g, '$1$2').trim()
    return open + (/^["'`]*$/.test(rest) ? names.join(' ') : rest) + close
  })
}

function flowchart(lines: string[]): string[] {
  const edgeIds = new Set<string>()
  const out: string[] = []
  for (const raw of lines) {
    if (STYLE.test(raw)) {
      out.push(raw)
      continue
    }
    // `A e1@--> B` names the edge for `e1@{ animate: true }`; lovely reads the name as a node.
    let line = raw.replace(/(^|\s)([A-Za-z_][\w-]*)@(?=[<ox]?(?:--|==|-\.|~~))/g, (_, pre: string, id: string) => {
      edgeIds.add(id)
      return pre
    })
    line = icons(line).replace(/\(\(\(([^()]*)\)\)\)/g, '(($1))')
    // `A ~~~ B` is an invisible link: both nodes, no edge.
    if (line.includes('~~~')) {
      const indent = /^\s*/.exec(line)![0]
      for (const part of line.trim().split(/\s*~~~+\s*/)) if (part !== '') out.push(indent + part)
      continue
    }
    out.push(line)
  }
  return out.filter(l => {
    const m = /^\s*([A-Za-z_][\w-]*)@\{.*\}\s*;?\s*$/.exec(l)
    return m === null || !edgeIds.has(m[1])
  })
}

// erDiagram's cardinalities in words, as the left and right symbol each stands for.
const CARD: [RegExp, string, string][] = [
  [/^(one or zero|zero or one)$/i, '|o', 'o|'],
  [/^(only one|1)$/i, '||', '||'],
  [/^(zero or more|zero or many|many\(0\)|0\+)$/i, '}o', 'o{'],
  [/^(one or more|one or many|many\(1\)|1\+)$/i, '}|', '|{'],
]

function card(words: string, side: 1 | 2): string | undefined {
  return CARD.find(([re]) => re.test(words.trim()))?.[side]
}

function er(lines: string[], after: [string, Role][][]): string[] {
  const out: string[] = []
  type Group = { name: string; path: string; members: string[] }
  const groups: Group[] = []
  const stack: Group[] = []
  let depth = 0
  for (const raw of lines) {
    let line = raw.replace(/:::[\w-]+/g, '')
    const t = line.trim()
    // mermaid.js renders markdown in a quoted entity name.
    if (depth === 0) line = line.replace(/"([^"]*)"/g, (_, s: string) => `"${stripMarkdown(s)}"`)
    if (depth > 0) {
      if (t.startsWith('}')) depth--
      out.push(line)
      continue
    }
    if (/^(direction|style|classDef|class)\b/.test(t)) continue
    const sub = /^subgraph\s+(.*)$/.exec(t)
    if (sub !== null) {
      const name = sub[1].replace(/^[\w-]+\s*\[(.*)\]$/, '$1').replace(/^"(.*)"$/, '$1').trim()
      const g: Group = { name, path: [...stack.map(s => s.name), name].join(' › '), members: [] }
      groups.push(g)
      stack.push(g)
      continue
    }
    if (t === 'end' && stack.length > 0) {
      stack.pop()
      continue
    }
    // lovely wants the symbols spaced off the names: `a||--o{b`.
    line = line.replace(/^(\s*)([^\s|}]+?)\s*(\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{)\s*(?=[^\s:])/, '$1$2 $3$4$5 ')
    const words = /^(\s*)([^\s:]+)\s+(.+?)\s+(optionally to|to)\s+(.+?)\s+([^\s:]+)(\s*:.*)$/i.exec(line)
    const l = words === null ? undefined : card(words[3], 1)
    const r = words === null ? undefined : card(words[5], 2)
    if (words !== null && l !== undefined && r !== undefined) {
      line = `${words[1]}${words[2]} ${l}${/^optionally/i.test(words[4]) ? '..' : '--'}${r} ${words[6]}${words[7]}`
    }
    const g = stack[stack.length - 1]
    if (g !== undefined) {
      const rel = /^\s*([^\s:{]+)\s+\S*(?:--|\.\.)\S*\s+([^\s:]+)/.exec(line)
      const names = rel === null ? [/^\s*([^\s:{]+)/.exec(line)?.[1]] : [rel[1], rel[2]]
      for (const n of names) if (n !== undefined && !g.members.includes(n)) g.members.push(n)
    }
    if (t.endsWith('{')) depth++
    out.push(line)
  }
  const shown = groups.filter(g => g.members.length > 0)
  if (shown.length > 0) {
    after.push([[t('Groups'), 'edgeLabel']])
    for (const g of shown) after.push([[g.path, 'text'], ['  ', 'none'], [g.members.join('、'), 'none']])
  }
  return out
}

const END_L = String.raw`(<\||\*|o|<|\(\))`
const END_R = String.raw`(\|>|\*|o|>|\(\))`
const RELATION = new RegExp(String.raw`^(\s*)([^\s"<|*()]+)\s*("[^"]*")?\s*${END_L}?(--|\.\.)${END_R}?\s*("[^"]*")?\s*([^\s":<|*()]+)\s*(:.*)?$`)

function classes(lines: string[]): string[] {
  // `` `Animal Class!` `` names a class lovely cannot spell: an id with that label.
  const ids = new Map<string, string>()
  const used = new Set<string>()
  const idOf = (name: string): string => {
    let id = ids.get(name)
    if (id === undefined) {
      const base = name.replace(/[^\p{L}\p{N}_]/gu, '_') || 'C'
      id = base
      for (let n = 2; used.has(id); n++) id = `${base}_${n}`
      used.add(id)
      ids.set(name, id)
    }
    return id
  }
  const tail: string[] = []
  const out: string[] = []
  for (const raw of lines) {
    let line = raw.replace(/`([^`]+)`/g, (_, name: string) => idOf(name))
    const stereo = /^(\s*)class\s+(\S+?)\s*<<([^>]+)>>\s*(\{.*)?$/.exec(line)
    if (stereo !== null) {
      tail.push(`${stereo[1]}<<${stereo[3]}>> ${stereo[2]}`)
      line = `${stereo[1]}class ${stereo[2]}${stereo[4] === undefined ? '' : ` ${stereo[4]}`}`
    }
    const rel = RELATION.exec(line)
    if (rel !== null) {
      const [, indent, a, ca, left, link, right, cb, b, labelPart] = rel
      const label = labelPart ?? ''
      const cards = (s?: string) => (s === undefined ? '' : `${s} `)
      // A lollipop `()` is an interface the class at the other end provides.
      if (left === '()' || right === '()') {
        const iface = left === '()' ? a : b
        out.push(`${indent}${a} ${cards(ca)}${link} ${cards(cb)}${b}${label}`)
        tail.push(`${indent}<<interface>> ${iface}`)
        continue
      }
      // Both ends marked: lovely draws the two halves as one line with both heads.
      if (left !== undefined && right !== undefined) {
        out.push(`${indent}${a} ${cards(ca)}${left}${link} ${cards(cb)}${b}${label}`)
        out.push(`${indent}${a} ${link}${right} ${b}`)
        continue
      }
    }
    out.push(line)
  }
  const labels = [...ids].map(([name, id]) => `  class ${id}["${name.replace(/"/g, '&quot;')}"]`)
  return [...labels, ...out, ...tail]
}

function sequence(lines: string[]): string[] {
  return lines.map(line => {
    // `participant Alice@{ "type": "database" }`: the newer participant shapes, named in the label.
    const m = /^(\s*)(?:create\s+)?(participant|actor)\s+([^\s@]+)@\{(.*)\}\s*(?:as\s+(.+))?$/.exec(line)
    if (m === null) return line
    const type = /"?type"?\s*:\s*"?([\w-]+)"?/.exec(m[4])?.[1]
    const shown = m[5]?.trim() ?? m[3]
    const create = /^\s*create\s/.test(line) ? 'create ' : ''
    if (type === undefined || type === 'actor' || type === 'participant') return `${m[1]}${create}${type ?? m[2]} ${m[3]} as ${shown}`
    return `${m[1]}${create}participant ${m[3]} as ${shown} [${type}]`
  })
}

/**
 * The source respelled for lovely-mermaid; the same text when nothing needed it.
 * Lines inside frontmatter and `%%` comments are left as they are.
 */
export function normalize(source: string): Normalized {
  const all = srcLines(source)
  const fm = frontmatterEnd(all)
  const head = all.slice(0, fm)
  const body = srcLines(markdownStrings(all.slice(fm).join('\n')))
  const at = body.findIndex(l => l.trim() !== '' && !/^\s*%%/.test(l))
  if (at === -1) return { src: source, after: [] }
  const keyword = body[at].trim().split(/\s+/)[0].toLowerCase()
  const literal = SPLITS_AT_SEMICOLON.has(keyword)
  const lines = body.slice(at + 1).map(l => (/^\s*%%/.test(l) || STYLE.test(l) ? l : entities(l.replace(/<br\s*\/?>/gi, ' '), literal)))
  const after: [string, Role][][] = []
  const rest =
    keyword === 'flowchart' || keyword === 'graph' ? flowchart(lines)
    : keyword === 'erdiagram' ? er(lines, after)
    : keyword === 'classdiagram' || keyword === 'classdiagram-v2' ? classes(lines)
    : keyword === 'sequencediagram' ? sequence(lines)
    : lines
  return { src: [...head, ...body.slice(0, at + 1), ...rest].join('\n'), after }
}
