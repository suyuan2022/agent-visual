// The newer mermaid types (11.12+): venn, ishikawa, treeView, cynefin, wardley, eventmodeling, railroad — drawn in lovely-mermaid's vocabulary.
import { D, L, R, U } from '../vendor/lovely-mermaid/canvas.js'
import { fitLabel } from '../vendor/lovely-mermaid/labels.js'
import { box, Canvas, commaSplit, drawText, label, num, pad, Rows, stringWidth, unquote } from './common.ts'
import type { Body, MermaidArt, Role } from './common.ts'

const titleOf = (b: Body): string | null => {
  let title = b.title
  for (const { text } of b.lines) if (/^title(\s|$)/i.test(text)) title = unquote(text.slice(5).trim()) || null
  return title
}
const isMeta = (text: string) => /^(title|acctitle|accdescr|size|style|classdef|class)\b/i.test(text)

/** A tree drawn with `├──` guides, the way lovely draws a mindmap. */
type Tree = { text: string; role: Role; note?: string; children: Tree[] }

function treeRows(rows: Rows, nodes: Tree[], prefix = '', top = true): void {
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1
    const guide = top ? '' : prefix + (last ? '└── ' : '├── ')
    rows.add([guide, 'edge'], [n.text, n.role], [n.note ? `  ${n.note}` : '', 'edgeLabel'])
    treeRows(rows, n.children, top ? '' : prefix + (last ? '    ' : '│   '), false)
  })
}

/** Builds a tree from indented lines: deeper indent nests under the line above. */
function nest<T extends { indent: number }>(items: T[], make: (it: T) => Tree): Tree[] {
  const root: Tree[] = []
  const stack: { indent: number; node: Tree }[] = []
  for (const it of items) {
    const node = make(it)
    while (stack.length > 0 && stack[stack.length - 1].indent >= it.indent) stack.pop()
    ;(stack.length === 0 ? root : stack[stack.length - 1].node.children).push(node)
    stack.push({ indent: it.indent, node })
  }
  return root
}

// ── venn: two sets as a strip of three regions; more as a list of sets and overlaps ──

export function venn(b: Body, columns: number): MermaidArt | null {
  type Region = { ids: string[]; name: string; size: string; texts: string[] }
  const sets: Region[] = []
  const unions: Region[] = []
  let last: Region | null = null
  const head = /^((?:"[^"]*"|[\w-]+)(?:\s*,\s*(?:"[^"]*"|[\w-]+))*)\s*(?:\[\s*(.*?)\s*\])?\s*(?::\s*([\d.]+))?$/
  for (const { text } of b.lines) {
    if (isMeta(text)) continue
    const m = /^(set|union|text)\s+(.*)$/i.exec(text)
    const h = m === null ? null : head.exec(m[2].trim())
    if (m === null || h === null) continue
    const ids = commaSplit(h[1]).map(unquote)
    const region: Region = { ids, name: h[2] ? label(h[2]) : ids.join(' ∩ '), size: h[3] ?? '', texts: [] }
    const kind = m[1].toLowerCase()
    if (kind === 'text') last?.texts.push(region.name)
    else if (kind === 'set') sets.push((last = region))
    else unions.push((last = region))
  }
  if (sets.length === 0) return null
  const named = new Map(sets.map(s => [s.ids[0], s.name]))
  const rows = new Rows()
  const lines = (r: Region, heading: string) => [heading + (r.size ? ` (${r.size})` : ''), ...r.texts.map(t => `· ${t}`)]
  if (sets.length === 2 && unions.length <= 1) {
    const [a, z] = sets
    const mid = unions[0] ?? { ids: [], name: '', size: '', texts: [] }
    const cols = [lines(a, a.name), mid.name || mid.texts.length ? lines(mid, `${mid.name}`) : [''], lines(z, z.name)]
    const widths = cols.map(c => Math.max(6, ...c.map(stringWidth)) + 2)
    const h = Math.max(...cols.map(c => c.length)) + 2
    const c = new Canvas(widths.reduce((s, w) => s + w, 0) + 1, h)
    let x = 0
    cols.forEach((col, i) => {
      box(c, x, 0, widths[i] + 1, h)
      col.forEach((ln, j) => drawText(c, ln, x + (i === 1 ? 1 + Math.floor((widths[i] - 1 - stringWidth(ln)) / 2) : 2), 1 + j, j === 0 ? (i === 1 ? 'edgeLabel' : 'title') : 'text'))
      x += widths[i]
    })
    c.finalizeMask()
    rows.add([pad(`${a.name} only`, widths[0]), 'edgeLabel'], [pad(' ∩', widths[1]), 'edgeLabel'], [`${z.name} only`, 'edgeLabel'])
    rows.addCanvas(c)
  } else {
    for (const s of sets) {
      rows.add(['● ', 'edge'], [s.name, 'title'], [s.size ? ` (${s.size})` : '', 'edgeLabel'])
      for (const t of s.texts) rows.add(['    · ', 'none'], [t, 'text'])
    }
    for (const u of unions) {
      rows.add(['◐ ', 'edge'], [u.ids.map(id => named.get(id) ?? id).join(' ∩ '), 'text'], [u.name !== u.ids.join(' ∩ ') ? `  ${u.name}` : '', 'edgeLabel'], [u.size ? ` (${u.size})` : '', 'edgeLabel'])
      for (const t of u.texts) rows.add(['    · ', 'none'], [t, 'text'])
    }
  }
  return rows.art(titleOf(b))
}

// ── ishikawa: a fishbone when it fits — categories above and below a spine into the problem — else a tree ──

export function ishikawa(b: Body, columns: number): MermaidArt | null {
  const [effect, ...causes] = b.lines.filter(l => !isMeta(l.text))
  if (effect === undefined) return null
  const cats = nest(causes, l => ({ text: label(l.text), role: 'text', children: [] }))
  const rows = new Rows()
  const block = (t: Tree): string[] => {
    const out = [t.text]
    const walk = (n: Tree, depth: number) => n.children.forEach(ch => (out.push(`${'  '.repeat(depth)}· ${ch.text}`), walk(ch, depth + 1)))
    walk(t, 1)
    return out
  }
  const pairs: [string[], string[] | null][] = []
  for (let i = 0; i < cats.length; i += 2) pairs.push([block(cats[i]), cats[i + 1] ? block(cats[i + 1]) : null])
  const colW = pairs.map(([t, d]) => Math.max(...t.map(stringWidth), ...(d ?? []).map(stringWidth)) + 3)
  const head = label(effect.text)
  const width = colW.reduce((s, w) => s + w, 0) + 4 + stringWidth(head) + 4
  if (cats.length > 0 && width <= columns) {
    const topH = Math.max(...pairs.map(([t]) => t.length))
    const botH = Math.max(0, ...pairs.map(([, d]) => d?.length ?? 0))
    const spine = topH + 1
    const c = new Canvas(width, spine + 2 + botH + (botH > 0 ? 1 : 0))
    let x = 0
    pairs.forEach(([t, d], i) => {
      t.forEach((ln, j) => drawText(c, ln, x + 1, spine - 1 - t.length + j, j === 0 ? 'title' : 'text'))
      c.addBits(x + 1, spine - 1, D, 'edge')
      c.addBits(x + 1, spine, U | (d ? D : 0), 'edge')
      if (d) {
        c.addBits(x + 1, spine + 1, U, 'edge')
        d.forEach((ln, j) => drawText(c, ln, x + 1, spine + 2 + j, j === 0 ? 'title' : 'text'))
      }
      x += colW[i]
    })
    for (let i = 0; i <= x + 2; i++) c.addBits(i, spine, (i > 0 ? L : 0) | R, 'edge')
    drawText(c, '▶', x + 3, spine, 'edge')
    box(c, x + 4, spine - 1, stringWidth(head) + 4, 3)
    drawText(c, head, x + 6, spine, 'title')
    c.finalizeMask()
    rows.addCanvas(c)
    return rows.art(titleOf(b))
  }
  rows.add(['◀ ', 'edge'], [head, 'title'])
  treeRows(rows, cats.map(cat => ({ ...cat, role: 'title' })), '', false)
  return rows.art(titleOf(b))
}

// ── treeView: a file tree; directories bold, `## notes` beside their entry ──

export function treeView(b: Body): MermaidArt | null {
  const items: { indent: number; text: string }[] = []
  for (const l of b.lines) {
    if (isMeta(l.text)) continue
    const raw = ' '.repeat(l.indent) + l.text
    const branch = /[├└┣┗]/.exec(raw)
    if (branch !== null) {
      const col = stringWidth(raw.slice(0, branch.index))
      items.push({ indent: col, text: raw.slice(branch.index).replace(/^[├└┣┗][─━]*\s*/, '') })
    } else if (/^[│┃\s]*$/.test(raw)) continue
    else items.push({ indent: l.indent, text: l.text.replace(/^[│┃\s]+/, '') })
  }
  if (items.length === 0) return null
  const tree = nest(items, it => {
    const note = /\s##\s*(.*)$/.exec(it.text)?.[1]
    const name = unquote(it.text.replace(/\s##\s*.*$/, '').replace(/\s*:::\w+/g, '').replace(/\s*icon\([^)]*\)/g, '').trim())
    const highlight = /:::highlight\b/.test(it.text)
    return { text: name, role: (name.endsWith('/') ? 'title' : highlight ? 'edge' : 'text') as Role, note, children: [] }
  })
  const rows = new Rows()
  const single = tree.length === 1
  if (single) treeRows(rows, tree)
  else treeRows(rows, tree, '', false)
  return rows.art(titleOf(b))
}

// ── cynefin: the four domains in their fixed places, confusion and transitions below ──

const DOMAINS: Record<string, [string, string]> = {
  complex: ['Complex', 'Probe → Sense → Respond'],
  complicated: ['Complicated', 'Sense → Analyse → Respond'],
  chaotic: ['Chaotic', 'Act → Sense → Respond'],
  clear: ['Clear', 'Sense → Categorise → Respond'],
  confusion: ['Confusion', ''],
}

export function cynefin(b: Body, columns: number): MermaidArt | null {
  const items: Record<string, string[]> = { complex: [], complicated: [], chaotic: [], clear: [], confusion: [] }
  const moves: [string, string, string][] = []
  let cur: string | null = null
  let seen = false
  for (const { text } of b.lines) {
    if (isMeta(text)) continue
    const d = text.toLowerCase()
    if (d in items) {
      cur = d
      seen = true
      continue
    }
    const mv = /^(\w+)\s*-->\s*(\w+)\s*(?::\s*(.*))?$/.exec(text)
    if (mv !== null) {
      if (mv[1].toLowerCase() !== mv[2].toLowerCase()) moves.push([mv[1].toLowerCase(), mv[2].toLowerCase(), mv[3] ? unquote(mv[3]) : ''])
      continue
    }
    if (cur !== null) items[cur].push(unquote(text))
  }
  if (!seen) return null
  const cell = (k: string) => [DOMAINS[k][0], DOMAINS[k][1], ...items[k].map(t => `· ${t}`)]
  const w = Math.min(Math.max(26, ...['complex', 'complicated', 'chaotic', 'clear'].flatMap(k => cell(k).map(s => stringWidth(s) + 3))), Math.floor((columns - 1) / 2))
  const h = Math.max(cell('complex').length, cell('complicated').length) + 2
  const h2 = Math.max(cell('chaotic').length, cell('clear').length) + 2
  const c = new Canvas(2 * w + 1, h + h2 - 1)
  box(c, 0, 0, w + 1, h)
  box(c, w, 0, w + 1, h)
  box(c, 0, h - 1, w + 1, h2)
  box(c, w, h - 1, w + 1, h2)
  const put = (k: string, x: number, y: number) =>
    cell(k).forEach((ln, i) => drawText(c, fitLabel(ln, w - 3), x + 2, y + 1 + i, i === 0 ? 'title' : i === 1 ? 'edgeLabel' : 'text'))
  put('complex', 0, 0)
  put('complicated', w, 0)
  put('chaotic', 0, h - 1)
  put('clear', w, h - 1)
  c.finalizeMask()
  const rows = new Rows()
  rows.addCanvas(c)
  if (items.confusion.length > 0) {
    rows.add(['Confusion', 'title'], ['  (centre)', 'edgeLabel'])
    for (const t of items.confusion) rows.add(['  · ', 'none'], [t, 'text'])
  }
  for (const [a, z, t] of moves) rows.add([DOMAINS[a]?.[0] ?? a, 'text'], [' ──▶ ', 'edge'], [DOMAINS[z]?.[0] ?? z, 'text'], [t ? `  ${t}` : '', 'edgeLabel'])
  return rows.art(titleOf(b))
}

// ── wardley: components plotted by evolution (x) and visibility (y); links, evolutions and notes listed ──

export function wardley(b: Body, columns: number): MermaidArt | null {
  type Comp = { name: string; vis: number; evo: number; anchor: boolean; marks: string }
  const comps = new Map<string, Comp>()
  const links: [string, string, string][] = []
  const evolves: [string, number][] = []
  const notes: [string, number, number][] = []
  const extras: [string, string][] = []
  let stages = ['Genesis', 'Custom', 'Product', 'Commodity']
  let bounds = [0.25, 0.5, 0.75, 1]
  const NAME = '("[^"]*"|[^[\\]]+?)'
  const COORD = '\\[\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*\\]'
  let pipeline: Comp | null = null
  const MARK: Record<string, string> = { build: '△', buy: '◇', outsource: '□', market: '○', inertia: '‖' }
  for (const { text } of b.lines) {
    if (isMeta(text)) continue
    if (pipeline !== null) {
      if (text === '}') pipeline = null
      else {
        const pc = new RegExp(`^component\\s+${NAME}\\s*\\[\\s*([\\d.]+)\\s*\\]`).exec(text)
        if (pc !== null) comps.set(unquote(pc[1]), { name: unquote(pc[1]), vis: pipeline.vis, evo: Number(pc[2]), anchor: false, marks: '' })
      }
      continue
    }
    const cm = new RegExp(`^(component|anchor)\\s+${NAME}\\s*${COORD}(.*)$`).exec(text)
    if (cm !== null) {
      const marks = [...cm[5].matchAll(/\((\w+)\)/g)].map(m => MARK[m[1]] ?? '').join('')
      comps.set(unquote(cm[2]), { name: unquote(cm[2]), vis: Number(cm[3]), evo: Number(cm[4]), anchor: cm[1] === 'anchor', marks })
      continue
    }
    const pm = new RegExp(`^pipeline\\s+${NAME}\\s*\\{?$`).exec(text)
    if (pm !== null) {
      pipeline = comps.get(unquote(pm[1])) ?? { name: '', vis: 0.5, evo: 0, anchor: false, marks: '' }
      continue
    }
    const ev = new RegExp(`^evolve\\s+${NAME}\\s+([\\d.]+)`).exec(text)
    if (ev !== null) {
      evolves.push([unquote(ev[1]), Number(ev[2])])
      continue
    }
    const st = /^evolution\s+(.*)$/.exec(text)
    if (st !== null) {
      const parts = st[1].split('->').map(s => s.trim())
      stages = parts.map(p => p.replace(/@[\d.]+$/, '').trim())
      bounds = parts.map((p, i) => Number(/@([\d.]+)$/.exec(p)?.[1] ?? (i + 1) / parts.length))
      continue
    }
    const nm = new RegExp(`^note\\s+"([^"]*)"\\s*${COORD}`).exec(text)
    if (nm !== null) {
      notes.push([nm[1], Number(nm[2]), Number(nm[3])])
      continue
    }
    const an = /^annotation\s+(\d+)\s*,\s*\[[^\]]*\]\s*"([^"]*)"/.exec(text)
    if (an !== null) {
      extras.push([`(${an[1]})`, an[2]])
      continue
    }
    const ac = new RegExp(`^(accelerator|deaccelerator)\\s+"([^"]*)"`).exec(text)
    if (ac !== null) {
      extras.push([ac[1] === 'accelerator' ? '» accelerator' : '« deaccelerator', ac[2]])
      continue
    }
    const tr = new RegExp(`^${NAME}\\s*-\\.-\\s*\\(`).exec(text)
    if (tr !== null) continue
    const lk = new RegExp(`^${NAME}\\s*(->|-->|-\\.->|\\+>|\\+<>|\\+<|\\+'[^']*'>)\\s*${NAME}\\s*(?:;\\s*(.*))?$`).exec(text)
    if (lk !== null) {
      const flow = /^\+'(.*)'>$/.exec(lk[2])?.[1]
      const [a, z] = lk[2] === '+<' ? [unquote(lk[3]), unquote(lk[1])] : [unquote(lk[1]), unquote(lk[3])]
      links.push([a, z, [flow, lk[4]].filter(Boolean).join(' ')])
    }
  }
  if (comps.size === 0) return null
  const W = Math.max(40, Math.min(90, columns - 2))
  const H = Math.max(12, Math.min(24, Math.round(W / 3.5)))
  const c = new Canvas(W + 1, H + 1)
  box(c, 0, 0, W + 1, H + 1)
  const X = (evo: number) => 1 + Math.round(Math.max(0, Math.min(1, evo)) * (W - 2))
  const Y = (vis: number) => 1 + Math.round((1 - Math.max(0, Math.min(1, vis))) * (H - 2))
  for (const bd of bounds.slice(0, -1)) for (let y = 1; y < H; y++) drawText(c, '┊', X(bd), y, 'border')
  for (const [name, to] of evolves) {
    const cp = comps.get(name)
    if (cp === undefined) continue
    const [x0, x1, y] = [X(cp.evo), X(to), Y(cp.vis)]
    for (let x = Math.min(x0, x1) + 1; x < Math.max(x0, x1); x++) drawText(c, '┄', x, y, 'edge')
    drawText(c, x1 > x0 ? '▶' : '◀', x1, y, 'edge')
  }
  for (const cp of comps.values()) {
    const x = X(cp.evo)
    const y = Y(cp.vis)
    drawText(c, cp.anchor ? '◉' : '●', x, y, 'edge')
    // The label goes right of the dot when it fits, else left; only a label too long for either side is cut.
    const full = cp.name + (cp.marks ? ` ${cp.marks}` : '')
    const right = W - x - 3
    const left = x - 2
    const name = stringWidth(full) <= right || right >= left ? fitLabel(full, Math.max(4, right)) : fitLabel(full, Math.max(4, left))
    const nx = stringWidth(full) <= right || right >= left ? x + 2 : x - 1 - stringWidth(name)
    drawText(c, name, nx, y, cp.anchor ? 'title' : 'text')
  }
  c.finalizeMask()
  const rows = new Rows()
  rows.add(['↑ Visible', 'edgeLabel'])
  rows.addCanvas(c)
  rows.add(['↓ Invisible', 'edgeLabel'])
  let axis = ''
  stages.forEach((s, i) => {
    const from = X(i === 0 ? 0 : bounds[i - 1])
    const mid = Math.max(0, Math.round((from + X(bounds[i])) / 2 - stringWidth(s) / 2))
    if (mid >= stringWidth(axis) + (axis ? 1 : 0)) axis = pad(axis, mid) + s
  })
  rows.add([axis, 'edgeLabel'], ['  evolution →', 'edgeLabel'])
  if (links.length > 0 || evolves.length > 0 || extras.length > 0 || notes.length > 0) rows.blank()
  for (const [text] of notes) rows.add(['note ', 'edgeLabel'], [text, 'text'])
  for (const [a, z, t] of links) rows.add([a, 'text'], [' ──▶ ', 'edge'], [z, 'text'], [t ? `  ${t}` : '', 'edgeLabel'])
  for (const [name, to] of evolves) rows.add([name, 'text'], [' ┄┄▶ ', 'edge'], [`evolves to ${num(to)}`, 'edgeLabel'])
  for (const [k, t] of extras) rows.add([k, 'edgeLabel'], [` ${t}`, 'text'])
  if ([...comps.values()].some(cp => cp.marks)) rows.add(['△ build  ◇ buy  □ outsource  ○ market  ‖ inertia', 'edgeLabel'])
  return rows.art(titleOf(b))
}

// ── eventmodeling: frames down the page, swimlanes across, data blocks listed ──

const LANE: Record<string, [number, string, string]> = {
  ui: [0, 'UI / Automation', '▢'],
  pcr: [0, 'UI / Automation', '◎'],
  processor: [0, 'UI / Automation', '◎'],
  cmd: [1, 'Command / Read Model', '▶'],
  command: [1, 'Command / Read Model', '▶'],
  rmo: [1, 'Command / Read Model', '◇'],
  readmodel: [1, 'Command / Read Model', '◇'],
  evt: [2, 'Events', '●'],
  event: [2, 'Events', '●'],
}

export function eventmodeling(b: Body, columns: number): MermaidArt | null {
  type Frame = { no: string; reset: boolean; lane: string; order: number; mark: string; name: string; inline: string; data: string; to: string[] }
  const frames: Frame[] = []
  const data = new Map<string, string[]>()
  let block: { id: string; lines: string[] } | null = null
  for (const { text } of b.lines) {
    if (block !== null) {
      if (text === '}') {
        data.set(block.id, block.lines)
        block = null
      } else block.lines.push(text)
      continue
    }
    const dm = /^data\s+([\w.-]+)\s*(?:`\w+`)?\s*\{\s*$/.exec(text)
    if (dm !== null) {
      block = { id: dm[1], lines: [] }
      continue
    }
    const fm = /^(tf|timeframe|rf|resetframe)\s+(\S+)\s+(\w+)\s+([\w.-]+)(.*)$/i.exec(text)
    if (fm === null) continue
    const kind = LANE[fm[3].toLowerCase()]
    if (kind === undefined) continue
    const [ns, entity] = fm[4].includes('.') ? [fm[4].slice(0, fm[4].lastIndexOf('.')), fm[4].slice(fm[4].lastIndexOf('.') + 1)] : ['', fm[4]]
    const rest = fm[5]
    frames.push({
      no: fm[2],
      reset: /^r/i.test(fm[1]),
      lane: ns ? `${ns} · ${kind[1]}` : kind[1],
      order: kind[0],
      mark: kind[2],
      name: entity,
      inline: /(?:`\w+`)?\{([^}]*)\}/.exec(rest)?.[1].trim() ?? '',
      data: /\[\[([^\]]+)\]\]/.exec(rest)?.[1] ?? '',
      to: [...rest.matchAll(/->>\s*(\S+)/g)].map(m => m[1]),
    })
  }
  if (frames.length === 0) return null
  const lanes = [...new Map(frames.map(f => [f.lane, f.order])).entries()].sort((a, z) => a[1] - z[1]).map(([name]) => name)
  const cellOf = (f: Frame) => `${f.mark} ${f.name}${f.inline ? ` {${f.inline}}` : ''}`
  const laneW = lanes.map(l => Math.min(30, Math.max(stringWidth(l), ...frames.filter(f => f.lane === l).map(f => stringWidth(cellOf(f))))) + 3)
  const noW = Math.max(...frames.map(f => stringWidth(f.no))) + 2
  const rows = new Rows()
  rows.add([' '.repeat(noW), 'none'], ...lanes.map((l, i): [string, Role] => [pad(l, laneW[i]), 'title']))
  frames.forEach((f, i) => {
    const li = lanes.indexOf(f.lane)
    const x = laneW.slice(0, li).reduce((s, w) => s + w, 0)
    const links = f.to.map(t => `→ ${t}`).join(' ')
    rows.add([pad(f.no, noW), 'edgeLabel'], [' '.repeat(x), 'none'], [fitLabel(cellOf(f), laneW[li] - 1), f.order === 2 ? 'edge' : 'text'], [f.reset ? '  ⟲ reset' : '', 'edgeLabel'], [links ? `  ${links}` : '', 'edgeLabel'], [f.data ? `  [${f.data}]` : '', 'none'])
  })
  if (data.size > 0) {
    rows.blank()
    for (const [id, lines] of data) rows.add([id, 'text'], ['  ', 'none'], [lines.join(' · '), 'edgeLabel'])
  }
  return rows.art(titleOf(b))
}

// ── railroad: EBNF / ABNF / PEG / IR rules parsed to one expression tree, each rule drawn as a track ──

type Expr =
  | { t: 'term'; s: string }
  | { t: 'nt'; s: string }
  | { t: 'seq'; xs: Expr[] }
  | { t: 'alt'; xs: Expr[] }
  | { t: 'opt'; x: Expr }
  | { t: 'plus'; x: Expr; note?: string }
  | { t: 'star'; x: Expr; note?: string }

const seq = (xs: Expr[]): Expr => (xs.length === 1 ? xs[0] : { t: 'seq', xs })
const alt = (xs: Expr[]): Expr => (xs.length === 1 ? xs[0] : { t: 'alt', xs })

/** Tokens for the text notations: strings, names, punctuation; comments already gone. */
function lex(s: string): string[] {
  return s.match(/"[^"]*"|'[^']*'|%[xdb][0-9A-Fa-f]+(?:[-.][0-9A-Fa-f]+)*|\?[^?]*\?|::=|<-|\d*\*\d*|[A-Za-z_][\w-]*|\d+|[()[\]{}|/,?*+&!.=-]/g) ?? []
}

/** A recursive-descent parser over `lex` tokens; `ops` picks the notation's alternation and repetition forms. */
function parseExpr(tokens: string[], notation: 'ebnf' | 'abnf' | 'peg'): Expr {
  let i = 0
  const peek = () => tokens[i]
  const altOp = notation === 'ebnf' ? '|' : '/'
  const parseAlt = (): Expr => {
    const xs = [parseSeq()]
    while (peek() === altOp || (notation === 'ebnf' && peek() === '/')) {
      i++
      xs.push(parseSeq())
    }
    return alt(xs)
  }
  const parseSeq = (): Expr => {
    const xs: Expr[] = []
    while (i < tokens.length && ![')', ']', '}', altOp, '|'].includes(peek())) {
      if (peek() === ',') {
        i++
        continue
      }
      xs.push(parseFactor())
    }
    return seq(xs)
  }
  const parseFactor = (): Expr => {
    let rep: string | null = null
    if (notation === 'abnf' && /^\d*\*\d*$|^\d+$/.test(peek()) && tokens[i + 1] !== undefined && !/^[)\]}]$/.test(tokens[i + 1])) rep = tokens[i++]
    let pred = ''
    if (notation === 'peg' && (peek() === '&' || peek() === '!')) pred = tokens[i++]
    let x = parsePrimary()
    if (pred) x = seq([{ t: 'term', s: pred === '&' ? '&(' : '!(' }, x, { t: 'term', s: ')' }])
    for (;;) {
      const op = peek()
      if (op === '?' && notation !== 'abnf') x = { t: 'opt', x }
      else if (op === '*' && notation !== 'abnf') x = { t: 'star', x }
      else if (op === '+' && notation !== 'abnf') x = { t: 'plus', x }
      else if (op === '-' && notation === 'ebnf') {
        i++
        const ex = parsePrimary()
        x = seq([x, { t: 'term', s: `except ${render(ex)}` }])
        continue
      } else break
      i++
    }
    if (rep !== null) {
      const [min, max] = rep.includes('*') ? rep.split('*').map(v => (v === '' ? null : Number(v))) : [Number(rep), Number(rep)]
      const note = `${min ?? 0}${max === null ? '+' : min === max ? '' : `–${max}`}×`
      if ((min ?? 0) === 0) x = { t: 'star', x, note: max === null ? undefined : note }
      else x = { t: 'plus', x, note: min === 1 && max === null ? undefined : note }
    }
    return x
  }
  const parsePrimary = (): Expr => {
    const tok = tokens[i++] ?? ''
    if (tok === '(') {
      const x = parseAlt()
      i++
      return x
    }
    if (tok === '[') {
      const x = parseAlt()
      i++
      return { t: 'opt', x }
    }
    if (tok === '{') {
      const x = parseAlt()
      i++
      return { t: 'star', x }
    }
    if (/^["']/.test(tok)) return { t: 'term', s: tok }
    if (tok.startsWith('%')) return { t: 'term', s: tok }
    if (tok.startsWith('?')) return { t: 'term', s: tok }
    if (tok === '.') return { t: 'term', s: 'any char' }
    return { t: 'nt', s: tok }
  }
  return parseAlt()
}

/** The IR notation: nested constructor calls. */
function parseIR(s: string): Expr {
  let i = 0
  const ws = () => {
    while (/\s|,/.test(s[i] ?? '')) i++
  }
  const value = (): Expr => {
    ws()
    const m = /^(\w+)\s*\(/.exec(s.slice(i))
    if (m === null) {
      const str = /^"([^"]*)"|^'([^']*)'/.exec(s.slice(i))
      i += str?.[0].length ?? 1
      return { t: 'term', s: str?.[0] ?? '' }
    }
    i += m[0].length
    const args: Expr[] = []
    for (;;) {
      ws()
      if (s[i] === ')' || i >= s.length) break
      args.push(value())
    }
    i++
    const str = (x: Expr | undefined) => (x !== undefined && x.t === 'term' ? x.s.replace(/^["']|["']$/g, '') : '')
    switch (m[1]) {
      case 'terminal':
        return { t: 'term', s: `"${str(args[0])}"` }
      case 'nonterminal':
        return { t: 'nt', s: str(args[0]) }
      case 'special':
        return { t: 'term', s: `? ${str(args[0])} ?` }
      case 'sequence':
        return seq(args)
      case 'choice':
        return alt(args)
      case 'optional':
        return { t: 'opt', x: args[0] }
      case 'zeroOrMore':
        return { t: 'star', x: args[0] }
      case 'oneOrMore':
        return { t: 'plus', x: args[0] }
      default:
        return seq(args)
    }
  }
  return value()
}

function render(x: Expr): string {
  switch (x.t) {
    case 'term':
    case 'nt':
      return x.s
    case 'seq':
      return x.xs.map(render).join(' ')
    case 'alt':
      return `(${x.xs.map(render).join(' | ')})`
    case 'opt':
      return `[${render(x.x)}]`
    case 'plus':
      return `${render(x.x)}+`
    case 'star':
      return `${render(x.x)}*`
  }
}

/** A laid-out track piece: `w`×`h` cells, the through-line on row `y`. */
type Piece = { w: number; h: number; y: number; draw: (c: Canvas, ox: number, oy: number) => void }

const hline = (c: Canvas, y: number, x0: number, x1: number) => {
  for (let x = x0; x <= x1; x++) c.addBits(x, y, (x > x0 ? L : 0) | (x < x1 ? R : 0) | L | R, 'edge')
}

function piece(x: Expr): Piece {
  switch (x.t) {
    case 'term':
    case 'nt': {
      const text = x.t === 'nt' ? x.s : x.s
      const w = stringWidth(text) + 4
      return {
        w,
        h: 1,
        y: 0,
        draw: (c, ox, oy) => {
          hline(c, oy, ox, ox)
          hline(c, oy, ox + w - 1, ox + w - 1)
          drawText(c, ` ${text} `, ox + 1, oy, x.t === 'term' ? 'edgeLabel' : 'text')
        },
      }
    }
    case 'seq': {
      const ps = x.xs.map(piece)
      const y = Math.max(0, ...ps.map(p => p.y))
      const h = Math.max(1, ...ps.map(p => y - p.y + p.h))
      return {
        w: ps.reduce((s, p) => s + p.w, 0),
        h,
        y,
        draw: (c, ox, oy) => {
          let cx = ox
          for (const p of ps) {
            p.draw(c, cx, oy + y - p.y)
            cx += p.w
          }
        },
      }
    }
    case 'alt':
    case 'opt': {
      const ps = x.t === 'opt' ? [{ w: 1, h: 1, y: 0, draw: (c: Canvas, ox: number, oy: number) => hline(c, oy, ox, ox) }, piece(x.x)] : x.xs.map(piece)
      const inner = Math.max(...ps.map(p => p.w))
      const tops: number[] = []
      let h = 0
      for (const p of ps) {
        tops.push(h)
        h += p.h
      }
      const w = inner + 4
      const mains = ps.map((p, k) => tops[k] + p.y)
      return {
        w,
        h,
        y: mains[0],
        draw: (c, ox, oy) => {
          const last = mains[mains.length - 1]
          ps.forEach((p, k) => {
            const ry = oy + mains[k]
            p.draw(c, ox + 2, oy + tops[k])
            hline(c, ry, ox + 2 + p.w, ox + w - 3)
            c.addBits(ox + 1, ry, R | (k > 0 ? U : 0) | (mains[k] < last ? D : 0), 'edge')
            c.addBits(ox + w - 2, ry, L | (k > 0 ? U : 0) | (mains[k] < last ? D : 0), 'edge')
          })
          for (let r = mains[0] + 1; r < last; r++) {
            if (!mains.includes(r)) {
              c.addBits(ox + 1, oy + r, U | D, 'edge')
              c.addBits(ox + w - 2, oy + r, U | D, 'edge')
            }
          }
          hline(c, oy + mains[0], ox, ox + 1)
          hline(c, oy + mains[0], ox + w - 2, ox + w - 1)
        },
      }
    }
    case 'plus':
    case 'star': {
      const p = piece(x.x)
      const loop: Piece = {
        w: p.w + 4,
        h: p.h + 1,
        y: p.y,
        draw: (c, ox, oy) => {
          const w = p.w + 4
          const bottom = oy + p.h
          p.draw(c, ox + 2, oy)
          hline(c, oy + p.y, ox, ox + 1)
          hline(c, oy + p.y, ox + w - 2, ox + w - 1)
          c.addBits(ox + 1, oy + p.y, D, 'edge')
          c.addBits(ox + w - 2, oy + p.y, D, 'edge')
          for (let r = oy + p.y + 1; r < bottom; r++) {
            c.addBits(ox + 1, r, U | D, 'edge')
            c.addBits(ox + w - 2, r, U | D, 'edge')
          }
          c.addBits(ox + 1, bottom, U | R, 'edge')
          c.addBits(ox + w - 2, bottom, U | L, 'edge')
          for (let cx = ox + 2; cx < ox + w - 2; cx++) c.addBits(cx, bottom, L | R, 'edge')
          drawText(c, '◀', ox + Math.floor(w / 2), bottom, 'edge')
          if (x.note) drawText(c, x.note, ox + Math.floor(w / 2) + 2, bottom, 'edgeLabel')
        },
      }
      return x.t === 'plus' ? loop : optOf(loop)
    }
  }
}

/** An optional around an already laid-out piece: bypass on the through-line, the piece below. */
function optOf(p: Piece): Piece {
  const w = p.w + 4
  return {
    w,
    h: p.h + 1,
    y: 0,
    draw: (c, ox, oy) => {
      const ry = oy + 1 + p.y
      hline(c, oy, ox, ox + w - 1)
      c.addBits(ox + 1, oy, D, 'edge')
      c.addBits(ox + w - 2, oy, D, 'edge')
      for (let r = oy + 1; r < ry; r++) {
        c.addBits(ox + 1, r, U | D, 'edge')
        c.addBits(ox + w - 2, r, U | D, 'edge')
      }
      c.addBits(ox + 1, ry, U | R, 'edge')
      c.addBits(ox + w - 2, ry, U | L, 'edge')
      p.draw(c, ox + 2, oy + 1)
    },
  }
}

export function railroad(b: Body, columns: number): MermaidArt | null {
  const kw = b.keyword.toLowerCase()
  const notation = kw.includes('abnf') ? 'abnf' : kw.includes('peg') ? 'peg' : kw === 'railroad-beta' ? 'ir' : 'ebnf'
  let src = b.lines.filter(l => !/^(title|acctitle|accdescr)\b/i.test(l.text)).map(l => l.text).join('\n')
  src = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\(\*[\s\S]*?\*\)/g, ' ')
  if (notation === 'peg') src = src.replace(/#.*$/gm, ' ')
  const rules: [string, Expr][] = []
  if (notation === 'abnf') {
    // `;` starts a comment in ABNF; a rule runs until the next `name =` at a line start.
    const text = src.replace(/;.*$/gm, '')
    for (const m of text.matchAll(/^([A-Za-z][\w-]*)\s*=\/?\s*([\s\S]*?)(?=^[A-Za-z][\w-]*\s*=|(?![\s\S]))/gm)) rules.push([m[1], parseExpr(lex(m[2]), 'abnf')])
  } else {
    for (const stmt of src.split(/;(?=(?:[^"']|"[^"]*"|'[^']*')*$)/m)) {
      const m = /^\s*([A-Za-z_][\w-]*)\s*(=|::=|<-)\s*([\s\S]*)$/.exec(stmt)
      if (m === null) continue
      rules.push([m[1], notation === 'ir' ? parseIR(m[3]) : parseExpr(lex(m[3]), notation === 'peg' ? 'peg' : 'ebnf')])
    }
  }
  if (rules.length === 0) return null
  const rows = new Rows()
  rules.forEach(([name, expr], k) => {
    if (k > 0) rows.blank()
    rows.add([name, 'title'])
    const p = piece(expr)
    if (p.w + 4 > columns) {
      rows.add(['  ', 'none'], [render(expr), 'text'])
      return
    }
    const c = new Canvas(p.w + 4, p.h)
    c.addBits(0, p.y, R, 'edge')
    c.addBits(1, p.y, L | R, 'edge')
    p.draw(c, 2, 0)
    c.addBits(p.w + 2, p.y, L | R, 'edge')
    c.addBits(p.w + 3, p.y, L, 'edge')
    c.finalizeMask()
    drawText(c, '├', 0, p.y, 'edge')
    drawText(c, '┤', p.w + 3, p.y, 'edge')
    rows.addCanvas(c, 2)
  })
  return rows.art(titleOf(b))
}
