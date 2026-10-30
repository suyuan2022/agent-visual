// Diagram types whose structure a grammar lovely-mermaid draws can carry: rewritten into that grammar, with any detail it would lose listed under the drawing.
import { t } from '../i18n.ts'
import { bodyOf, commaSplit, label, stringWidth, unquote } from './common.ts'
import type { Body, Line, Role } from './common.ts'

/** The rewritten source, plus rows of detail to print under the drawing. */
export type Rewrite = { src: string; after: [string, Role][][] }

/** `&quot;` survives lovely's label cleaning; a bare quote would end the label. */
function q(s: string): string {
  return `"${s.replace(/"/g, '&quot;')}"`
}

function withTitle(title: string | null, src: string): string {
  return title === null || title === '' ? src : `---\ntitle: ${q(title)}\n---\n${src}`
}

/** Every rewriter, by header keyword (lowercased). */
export const REWRITERS: Record<string, (b: Body) => Rewrite | null> = {
  'swimlane-beta': swimlane,
  swimlane: swimlane,
  swimlanes: swimlane,
  c4context: c4,
  c4container: c4,
  c4component: c4,
  c4dynamic: c4,
  c4deployment: c4,
  'architecture-beta': architecture,
  architecture: architecture,
  'sankey-beta': sankey,
  sankey: sankey,
  requirementdiagram: requirement,
}

// ── swimlane-beta: flowchart grammar, its top-level subgraphs drawn as lanes ──

function swimlane(b: Body): Rewrite {
  const dir = /^(TB|TD|BT|LR|RL)$/i.test(b.rest.trim()) ? b.rest.trim().toUpperCase() : 'TB'
  const lines = b.lines.map(l => ' '.repeat(l.indent) + l.text)
  return { src: withTitle(b.title, [`flowchart ${dir}`, ...lines].join('\n')), after: [] }
}

// ── C4: elements and boundaries become nodes and subgraphs; descriptions go in a list below ──

const C4_KIND: Record<string, { type: string; shape: 'person' | 'db' | 'queue' | 'box'; tech: boolean }> = {}
for (const [base, type, tech] of [
  ['Person', 'Person', false],
  ['System', 'Software System', false],
  ['SystemDb', 'Database', false],
  ['SystemQueue', 'Queue', false],
  ['Container', 'Container', true],
  ['ContainerDb', 'Container: Database', true],
  ['ContainerQueue', 'Container: Queue', true],
  ['Component', 'Component', true],
  ['ComponentDb', 'Component: Database', true],
  ['ComponentQueue', 'Component: Queue', true],
] as const) {
  const shape = base === 'Person' ? 'person' : base.endsWith('Db') ? 'db' : base.endsWith('Queue') ? 'queue' : 'box'
  C4_KIND[base.toLowerCase()] = { type, shape, tech }
  C4_KIND[`${base.toLowerCase()}_ext`] = { type: `External ${type}`, shape, tech }
}
const C4_BOUNDARY = new Set(['boundary', 'enterprise_boundary', 'system_boundary', 'container_boundary', 'deployment_node', 'node', 'node_l', 'node_r'])
const C4_REL = /^(birel|rel|rel_u|rel_up|rel_d|rel_down|rel_l|rel_left|rel_r|rel_right|rel_back|relindex)$/

/** `Name(a, "b, c", $tags="x") {` → name, positional args (named `$` args dropped), whether it opens a block. */
function c4Call(text: string): { name: string; args: string[]; opens: boolean } | null {
  const m = /^([A-Za-z_]+)\s*\((.*)\)\s*(\{)?\s*$/.exec(text)
  if (m === null) return null
  const args = commaSplit(m[2])
    .filter(a => !a.startsWith('$'))
    .map(a => label(a))
  return { name: m[1].toLowerCase(), args, opens: m[3] !== undefined }
}

function c4(b: Body): Rewrite | null {
  const out: string[] = []
  const edges: string[] = []
  const after: [string, Role][][] = []
  const id = (alias: string) => `c4_${alias.replace(/[^A-Za-z0-9_]/g, '_')}`
  let title = b.title
  let depth = 1
  for (const { text } of b.lines) {
    if (/^title\s/i.test(text)) {
      title = text.slice(6).trim()
      continue
    }
    if (text === '}') {
      if (depth > 1) {
        depth--
        out.push(`${'  '.repeat(depth)}end`)
      }
      continue
    }
    const call = c4Call(text)
    if (call === null) continue
    const indent = '  '.repeat(depth)
    if (C4_BOUNDARY.has(call.name)) {
      const [alias, name = alias, type] = call.args
      const kind = type ?? call.name.replace(/_[lr]$/, '').replace('_', ' ')
      out.push(`${indent}subgraph ${id(alias)}[${q(`${name} [${kind}]`)}]`)
      if (call.opens) depth++
      continue
    }
    const kind = C4_KIND[call.name]
    if (kind !== undefined) {
      const [alias, name = alias, a3, a4] = call.args
      const tech = kind.tech ? a3 : undefined
      const descr = kind.tech ? a4 : a3
      const type = tech ? `${kind.type}: ${tech}` : kind.type
      const text = q(`${name} [${type}]`)
      const node = kind.shape === 'person' ? `([${text}])` : kind.shape === 'db' ? `[(${text})]` : kind.shape === 'queue' ? `[[${text}]]` : `[${text}]`
      out.push(`${indent}${id(alias)}${node}`)
      if (descr) after.push([[name, 'text'], ['  ', 'none'], [descr, 'none']])
      continue
    }
    const rel = C4_REL.exec(call.name)
    if (rel !== null) {
      let args = call.args
      if (call.name === 'relindex') args = args.slice(1)
      const [from, to, lbl, tech] = args
      if (from === undefined || to === undefined) continue
      const text = [lbl, tech ? `[${tech}]` : ''].filter(Boolean).join(' ')
      const arrow = call.name === 'birel' ? '<-->' : '-->'
      const [a, z] = call.name === 'rel_back' ? [to, from] : [from, to]
      edges.push(`  ${id(a)} ${arrow}${text ? `|${q(text)}|` : ''} ${id(z)}`)
    }
  }
  if (out.length === 0) return null
  if (after.length > 0) {
    const w = Math.max(...after.map(r => stringWidth(r[0][0])))
    for (const r of after) r[0][0] = r[0][0] + ' '.repeat(w - stringWidth(r[0][0]))
    after.unshift([[t('Notes'), 'edgeLabel']])
  }
  return { src: withTitle(title, ['flowchart TD', ...out, ...edges].join('\n')), after }
}

// ── architecture-beta: groups become subgraphs, services nodes; side hints (L/R/T/B) are layout only ──

function architecture(b: Body): Rewrite | null {
  type Item = { kind: 'group' | 'service' | 'junction'; id: string; icon: string; title: string; parent: string | null }
  const items: Item[] = []
  const edges: string[] = []
  const DECL = /^(group|service|junction)\s+([\w-]+)(?:\(([^)]*)\))?(?:\[([^\]]*)\])?(?:\s+in\s+([\w-]+))?\s*$/
  const EDGE = /^([\w-]+)(?:\{group\})?\s*:\s*([LRTB])\s*(<?)--(>?)\s*([LRTB])\s*:\s*([\w-]+)(?:\{group\})?\s*$/
  for (const { text } of b.lines) {
    const d = DECL.exec(text)
    if (d !== null) {
      items.push({ kind: d[1] as Item['kind'], id: d[2], icon: d[3] ?? '', title: d[4] ?? (d[1] === 'junction' ? '' : d[2]), parent: d[5] ?? null })
      continue
    }
    const e = EDGE.exec(text)
    if (e !== null) {
      const [, a, , back, fwd, , z] = e
      const arrow = back && fwd ? '<-->' : fwd ? '-->' : back ? '<--' : '---'
      edges.push(arrow === '<--' ? `  a_${z} --> a_${a}` : `  a_${a} ${arrow} a_${z}`)
    }
  }
  if (items.length === 0) return null
  const out: string[] = []
  const emit = (parent: string | null, depth: number) => {
    for (const it of items.filter(i => i.parent === parent)) {
      const indent = '  '.repeat(depth)
      if (it.kind === 'group') {
        out.push(`${indent}subgraph a_${it.id}[${q(it.title)}]`)
        emit(it.id, depth + 1)
        out.push(`${indent}end`)
      } else if (it.kind === 'junction') {
        out.push(`${indent}a_${it.id}((·))`)
      } else {
        const icon = it.icon.split(':').pop() ?? ''
        const text = q(icon === '' ? it.title : `${it.title} [${icon}]`)
        const node = /database|disk/.test(icon) ? `[(${text})]` : /internet|cloud/.test(icon) ? `(${text})` : `[${text}]`
        out.push(`${indent}a_${it.id}${node}`)
      }
    }
  }
  emit(null, 1)
  return { src: withTitle(b.title, ['flowchart LR', ...out, ...edges].join('\n')), after: [] }
}

// ── sankey: each CSV row a flow; the value rides on the edge ──

function sankey(b: Body): Rewrite | null {
  const ids = new Map<string, string>()
  const node = (name: string) => {
    if (!ids.has(name)) ids.set(name, `s${ids.size}`)
    return ids.get(name)!
  }
  const edges: string[] = []
  for (const { text } of b.lines) {
    const cells = commaSplit(text).map(c => unquote(c).replace(/""/g, '"'))
    if (cells.length !== 3 || !Number.isFinite(Number(cells[2]))) continue
    edges.push(`  ${node(cells[0])} -->|${q(cells[2])}| ${node(cells[1])}`)
  }
  if (edges.length === 0) return null
  const nodes = [...ids].map(([name, id]) => `  ${id}[${q(name)}]`)
  return { src: withTitle(b.title, ['flowchart LR', ...nodes, ...edges].join('\n')), after: [] }
}

// ── requirementDiagram: UML-like boxes, so a class diagram with stereotypes and fields ──

const REQ_KIND: Record<string, string> = {
  requirement: 'Requirement',
  functionalrequirement: 'Functional Requirement',
  interfacerequirement: 'Interface Requirement',
  performancerequirement: 'Performance Requirement',
  physicalrequirement: 'Physical Requirement',
  designconstraint: 'Design Constraint',
  element: 'Element',
}

function requirement(b: Body): Rewrite | null {
  const ids = new Map<string, string>()
  const id = (name: string) => {
    if (!ids.has(name)) ids.set(name, `r${ids.size}`)
    return ids.get(name)!
  }
  const out: string[] = []
  const rels: string[] = []
  let block: { name: string; kind: string; fields: string[] } | null = null
  const flush = () => {
    if (block === null) return
    out.push(`  class ${id(block.name)}[${q(block.name)}] {`, `    <<${block.kind}>>`, ...block.fields.map(f => `    ${f}`), '  }')
    block = null
  }
  for (const { text } of b.lines as Line[]) {
    if (block !== null) {
      if (text === '}') flush()
      else {
        const m = /^(\w+)\s*:\s*(.*)$/.exec(text)
        if (m !== null) block.fields.push(`${m[1]}: ${unquote(m[2])}`)
      }
      continue
    }
    const open = /^(\w+)\s+("[^"]*"|[^\s{]+)\s*\{\s*$/.exec(text)
    if (open !== null && REQ_KIND[open[1].toLowerCase()] !== undefined) {
      block = { name: unquote(open[2]), kind: REQ_KIND[open[1].toLowerCase()], fields: [] }
      continue
    }
    const fwd = /^("[^"]*"|\S+)\s+-\s+(\w+)\s+->\s+("[^"]*"|\S+)$/.exec(text)
    const back = /^("[^"]*"|\S+)\s+<-\s+(\w+)\s+-\s+("[^"]*"|\S+)$/.exec(text)
    if (fwd !== null) rels.push(`  ${id(unquote(fwd[1]))} ..> ${id(unquote(fwd[3]))} : «${fwd[2]}»`)
    else if (back !== null) rels.push(`  ${id(unquote(back[3]))} ..> ${id(unquote(back[1]))} : «${back[2]}»`)
  }
  flush()
  if (out.length === 0) return null
  return { src: withTitle(b.title, ['classDiagram', ...out, ...rels].join('\n')), after: [] }
}

// ── zenuml: method-call sequence syntax, braces for nesting → sequenceDiagram ──

/** Statements and braces in order: `{` and `}` outside quotes and parentheses become tokens of their own. */
function zenTokens(lines: Line[]): string[] {
  const out: string[] = []
  for (const { text } of lines) {
    let cur = ''
    let depth = 0
    let quoted = false
    for (const c of text) {
      if (c === '"') quoted = !quoted
      if (!quoted && c === '(') depth++
      if (!quoted && c === ')') depth--
      if (!quoted && depth === 0 && (c === '{' || c === '}')) {
        if (cur.trim()) out.push(cur.trim())
        out.push(c)
        cur = ''
      } else cur += c
    }
    if (cur.trim()) out.push(cur.trim())
  }
  return out
}

function zenuml(b: Body): Rewrite | null {
  const tokens = zenTokens(b.lines)
  const out: string[] = []
  const declared = new Map<string, string>()
  const alias = new Map<string, string>()
  const shown = new Map<string, string>()
  const created = new Set<string>()
  let title = b.title
  let usesStarter = false
  const name = (n: string) => alias.get(n) ?? n
  const declare = (n: string, kind = 'participant') => {
    if (!declared.has(n)) declared.set(n, kind)
  }
  const callers: string[] = []
  const caller = () => {
    const c = callers[callers.length - 1]
    if (c !== undefined) return c
    usesStarter = true
    return 'Starter'
  }
  // `}` closes either a fragment (emit `end`, unless an else-branch follows) or a call block (reply + deactivate).
  const frames: ({ kind: 'fragment' } | { kind: 'call'; target: string; from: string; assign: string })[] = []
  let pendingNote = ''
  let replyNext = false
  let annot = ''
  const note = (who: string) => {
    if (pendingNote) out.push(`  Note over ${who}: ${pendingNote}`)
    pendingNote = ''
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const opens = tokens[i + 1] === '{'
    if (t === '{') continue
    if (t === '}') {
      const f = frames.pop()
      if (f === undefined) continue
      const next = tokens[i + 1] ?? ''
      if (f.kind === 'fragment') {
        const branch = /^(else|catch|finally)\b/.exec(next)
        if (branch !== null) {
          const cond = /\((.*)\)/.exec(next)?.[1] ?? (branch[1] === 'else' ? '' : branch[1])
          out.push(`  else${cond ? ` ${cond}` : ''}`)
          frames.push({ kind: 'fragment' })
          i++
        } else out.push('  end')
      } else {
        callers.pop()
        if (f.assign) out.push(`  ${f.target}-->>${f.from}: ${f.assign}`)
        out.push(`  deactivate ${f.target}`)
      }
      continue
    }
    if (t.startsWith('//')) {
      pendingNote = t.slice(2).trim()
      continue
    }
    if (/^title\s/i.test(t)) {
      title = t.slice(6).trim()
      continue
    }
    if (/^@(return|reply)$/i.test(t)) {
      replyNext = true
      continue
    }
    const an = /^@(\w+)\s*(.*)$/.exec(t)
    if (an !== null) {
      annot = an[1]
      if (an[2]) {
        declare(an[2], annot.toLowerCase() === 'actor' ? 'actor' : 'participant')
        annot = ''
      }
      continue
    }
    const frag = /^(if|while|for|foreach|forEach|loop|opt|par|try)\s*(?:\((.*)\))?$/.exec(t)
    if (frag !== null && opens) {
      const kw = frag[1].toLowerCase()
      const sd = kw === 'if' ? 'alt' : kw === 'try' ? 'critical' : kw === 'opt' ? 'opt' : kw === 'par' ? 'par' : 'loop'
      out.push(`  ${sd}${frag[2] ? ` ${frag[2]}` : kw === 'try' ? ' try' : ''}`)
      frames.push({ kind: 'fragment' })
      i++
      continue
    }
    const ret = /^return\s*(.*)$/.exec(t)
    if (ret !== null) {
      const f = [...frames].reverse().find(x => x.kind === 'call') as { target: string; from: string } | undefined
      if (f !== undefined) out.push(`  ${f.target}-->>${f.from}: ${ret[1]}`)
      continue
    }
    const asy = /^([\w\u0080-￿]+)\s*->\s*([\w\u0080-￿]+)\s*:\s*(.*)$/.exec(t)
    if (asy !== null) {
      const [a, z] = [name(asy[1]), name(asy[2])]
      declare(a)
      declare(z)
      note(a)
      out.push(`  ${a}${replyNext ? '-->>' : '->>'}${z}: ${asy[3]}`)
      replyNext = false
      continue
    }
    const created = /^(?:(?:[\w\u0080-￿]+\s+)?([\w\u0080-￿]+)\s*=\s*)?new\s+([\w\u0080-￿]+)\s*(\(.*\))?$/.exec(t)
    if (created !== null) {
      const from = caller()
      const target = name(created[2])
      if (!declared.has(target)) {
        out.push(`  create participant ${target}`)
        created.add(target)
      }
      declare(target)
      note(from)
      out.push(`  ${from}->>${target}: «create»${created[3] ?? ''}`)
      if (opens) {
        out.push(`  activate ${target}`)
        frames.push({ kind: 'call', target, from, assign: created[1] ?? '' })
        callers.push(target)
        i++
      }
      continue
    }
    const sync = /^(?:(?:[\w\u0080-￿]+\s+)?([\w\u0080-￿]+)\s*=\s*)?(?:([\w\u0080-￿]+)\s*->\s*)?([\w\u0080-￿]+)\.([\w\u0080-￿]+)\s*(\(.*\))?$/.exec(t)
    if (sync !== null) {
      const from = sync[2] ? name(sync[2]) : caller()
      const target = name(sync[3])
      declare(from)
      declare(target)
      note(from)
      out.push(`  ${from}->>${target}: ${sync[4]}${sync[5] ?? ''}`)
      if (opens) {
        out.push(`  activate ${target}`)
        frames.push({ kind: 'call', target, from, assign: sync[1] ?? '' })
        callers.push(target)
        i++
      } else if (sync[1]) out.push(`  ${target}-->>${from}: ${sync[1]}`)
      continue
    }
    const as = /^([\w\u0080-￿]+)\s+as\s+(.+)$/.exec(t)
    if (as !== null) {
      declare(as[1], annot.toLowerCase() === 'actor' ? 'actor' : 'participant')
      shown.set(as[1], as[2].trim())
      annot = ''
      continue
    }
    const bare = /^([\w\u0080-￿]+)$/.exec(t)
    if (bare !== null) {
      declare(bare[1], annot.toLowerCase() === 'actor' ? 'actor' : 'participant')
      annot = ''
    }
  }
  if (out.length === 0) return null
  const heads = [...(usesStarter ? [['Starter', 'participant'] as const] : []), ...declared]
    .filter(([n]) => !created.has(n))
    .map(([n, kind]) => `  ${kind} ${n}${shown.has(n) ? ` as ${shown.get(n)}` : ''}`)
  return { src: withTitle(title, ['sequenceDiagram', ...heads, ...out].join('\n')), after: [] }
}

// ── agentflow: flowchart grammar with agent shapes and `flow` containers; metadata listed below ──

// lovely draws three shape families (box, rounded, diamond); the agent kind also rides in the label so it is not lost.
const AGENT_SHAPE: Record<string, [string, string]> = { task: ['(', ')'], tool: ['[', ']'], input: ['[', ']'], decision: ['{', '}'], action: ['{{', '}}'], refdoc: ['(', ')'] }

/** Joins a multi-line `@{ ... }` onto the line that opened it. */
function joinMeta(lines: Line[]): string[] {
  const out: string[] = []
  let open = 0
  for (const { text } of lines) {
    if (open > 0) out[out.length - 1] += ` ${text}`
    else out.push(text)
    open += (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length
    if (open < 0) open = 0
  }
  return out
}

function agentflow(b: Body): Rewrite | null {
  const dir = /^(TB|TD|BT|LR|RL)$/i.test(b.rest.trim()) ? b.rest.trim().toUpperCase() : 'TB'
  const out: string[] = []
  const after: [string, Role][][] = []
  for (const text of joinMeta(b.lines)) {
    if (text === 'global' || /^global\s*$/.test(text)) continue
    const flow = /^flow\s+([\w-]+)\s*(\[.*\])?\s*(@\{.*\})?$/.exec(text)
    if (flow !== null) {
      out.push(`subgraph ${flow[1]}${flow[2] ?? ''}`)
      continue
    }
    const meta = /^([\w-]+)\s*(\[[^\]]*\])?\s*@\{(.*)\}\s*$/.exec(text)
    const conn = /^connector\s+([\w-]+)\s*(\[[^\]]*\])?/.exec(text)
    if (conn !== null) {
      out.push(`${conn[1]}[(${conn[2] ? conn[2].slice(1, -1) : q(conn[1])})]`)
      continue
    }
    if (meta !== null) {
      const fields = commaSplit(meta[3]).map(kv => kv.split(':')).filter(kv => kv.length >= 2)
      const shape = fields.find(([k]) => k.trim() === 'shape')?.[1].trim()
      const rest = fields.filter(([k]) => !['shape', 'label', 'labelType', 'view', 'algorithm', 'curve', 'animate', 'animation', 'class', 'style', 'icon', 'img', 'w', 'h'].includes(k.trim()))
      if (meta[2] !== undefined) {
        const [l, r] = AGENT_SHAPE[shape ?? ''] ?? ['[', ']']
        const shown = label(meta[2].slice(1, -1))
        out.push(`${meta[1]}${l}${q(shape && shape !== 'task' && shape !== 'decision' ? `${shown} [${shape}]` : shown)}${r}`)
      }
      for (const [k, ...v] of rest) after.push([[meta[1], 'text'], ['  ', 'none'], [`${k.trim()}:`, 'edgeLabel'], [` ${unquote(v.join(':').trim())}`, 'none']])
      continue
    }
    out.push(text.replace(/\s*@\{.*\}\s*$/, ''))
  }
  if (out.length === 0) return null
  if (after.length > 0) after.unshift([[t('Notes'), 'edgeLabel']])
  return { src: withTitle(b.title, [`flowchart ${dir}`, ...out.map(l => `  ${l}`)].join('\n')), after }
}

// ── usecase: actors, use cases and boundaries as flowchart nodes and subgraphs ──

function usecase(b: Body): Rewrite | null {
  let dir = 'LR'
  const out: string[] = []
  const edges: string[] = []
  const after: [string, Role][][] = []
  const lines = joinMeta(b.lines)
  const ID = '[A-Za-z0-9_]+'
  const SUFFIX = '(?:\\s*@\\{[^}]*\\})?(?:\\s*<<([^>]*)>>)?(?:\\s*:::[\\w,]+)?'
  const word = (s: string) => s.replace(/\W/g, '_')
  const stereo = (s: string | undefined) => (s ? `«${s}» ` : '')
  let inBoundary = false
  let notes = 0
  for (const text of lines) {
    if (/^(acctitle|accdescr|classdef|class|style)\b/i.test(text) || /^[\w]+@\{.*\}$/.test(text)) continue
    const dm = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(text)
    if (dm !== null) {
      dir = dm[1].toUpperCase()
      continue
    }
    const sb = new RegExp(`^systemBoundary\\s+(?:"([^"]*)"|(${ID}))\\s*(?:[[(]"?([^\\])"]*)"?[\\])])?`).exec(text)
    if (sb !== null) {
      const id = sb[1] !== undefined ? word(sb[1]) : sb[2]
      out.push(`  subgraph u_${id}[${q(sb[3] ?? sb[1] ?? sb[2])}]`)
      inBoundary = true
      continue
    }
    if (text === 'end' && inBoundary) {
      out.push('  end')
      inBoundary = false
      continue
    }
    const indent = inBoundary ? '    ' : '  '
    const actor = new RegExp(`^actor\\s+(${ID})\\s*(?:\\(\\s*"?([^)"]*)"?\\s*\\))?${SUFFIX}\\s*$`).exec(text)
    if (actor !== null) {
      out.push(`${indent}u_${actor[1]}([${q(`${stereo(actor[3] || 'actor')}${actor[2] || actor[1]}`)}])`)
      continue
    }
    const json = new RegExp(`^json\\s+(${ID})\\s*@(\\{.*\\})`).exec(text)
    if (json !== null) {
      out.push(`${indent}u_${json[1]}[${q(`${json[1]} [json]`)}]`)
      try {
        const flat = (v: unknown, path: string): [string, string][] =>
          v !== null && typeof v === 'object' ? Object.entries(v as object).flatMap(([k, x]) => flat(x, Array.isArray(v) ? `${path}[${k}]` : path ? `${path}.${k}` : k)) : [[path, String(v)]]
        for (const [k, v] of flat(JSON.parse(json[2]), '')) after.push([[json[1], 'text'], ['  ', 'none'], [`${k}:`, 'edgeLabel'], [` ${v}`, 'none']])
      } catch {
        after.push([[json[1], 'text'], ['  ', 'none'], [json[2], 'none']])
      }
      continue
    }
    const noteM = new RegExp(`^note\\s+for\\s+(${ID})\\s+"(.*)"$`).exec(text)
    if (noteM !== null) {
      const id = `u_note${notes++}`
      out.push(`${indent}${id}[${q(`Note: ${noteM[2].replace(/`|\*\*|__/g, '')}`)}]`)
      edges.push(`  ${id} -.- u_${noteM[1]}`)
      continue
    }
    const rel = new RegExp(`^(${ID})\\s+(?:${ID}@)?\\s*(-->+|<--|--o|o--|--x|x--|--\\|>|--+|\\.\\.>\\s*:\\s*(include|extend)|--\\s*(?:"([^"]*)"|([^-"]+?))\\s*-*-->)\\s*(${ID})\\s*$`).exec(text)
    if (rel !== null) {
      const [, a, op, ux, lq, lu, z] = rel
      const lbl = lq ?? lu?.trim()
      if (ux) edges.push(`  u_${a} -.->|«${ux}»| u_${z}`)
      else if (op === '<--') edges.push(`  u_${z} --> u_${a}`)
      else if (op === 'o--' || op === 'x--') edges.push(`  u_${z} --${op[0]} u_${a}`)
      else if (op === '--|>') edges.push(`  u_${a} -->|«generalization»| u_${z}`)
      else if (/^--o$|^--x$/.test(op)) edges.push(`  u_${a} ${op} u_${z}`)
      else if (/^-+$/.test(op)) edges.push(`  u_${a} --- u_${z}`)
      else edges.push(`  u_${a} -->${lbl ? `|${q(lbl)}|` : ''} u_${z}`)
      continue
    }
    const uc = new RegExp(`^(?:"([^"]*)"|(${ID})\\s*(?:\\(\\s*"?([^)"]*)"?\\s*\\)|\\[\\s*"?([^\\]"]*)"?\\s*\\])?)${SUFFIX}\\s*$`).exec(text)
    if (uc !== null) {
      const id = uc[1] !== undefined ? word(uc[1]) : uc[2]
      const shown = `${stereo(uc[5])}${uc[1] ?? uc[3] ?? uc[4] ?? uc[2]}`
      out.push(`${indent}u_${id}${uc[4] !== undefined ? `[${q(shown)}]` : `(${q(shown)})`}`)
    }
  }
  if (out.length === 0 && edges.length === 0) return null
  if (after.length > 0) after.unshift([[t('Data'), 'edgeLabel']])
  return { src: withTitle(b.title, [`flowchart ${dir}`, ...out, ...edges].join('\n')), after }
}

REWRITERS.zenuml = zenuml
REWRITERS['agentflow-beta'] = agentflow
REWRITERS.agentflow = agentflow
REWRITERS['usecase-beta'] = usecase
REWRITERS.usecase = usecase

/** The rewrite for a source, or `null` when its type is not one rewritten here. */
export function rewrite(src: string): Rewrite | null {
  const b = bodyOf(src)
  if (b === null) return null
  const fn = REWRITERS[b.keyword.toLowerCase()]
  return fn === undefined ? null : fn(b)
}
