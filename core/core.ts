// Where a reply's mermaid blocks are, and the drawing of each that fits the terminal. No Claude Code API here.
import { chart } from './extra/charts.ts'
import { rewrite } from './extra/transpile.ts'
import { keywordOf } from './extra/common.ts'
import { normalize } from './normalize.ts'
import { diagramKind, render, sourceBox } from './vendor/lovely-mermaid/index.js'
import type { MermaidArt, Role } from './vendor/lovely-mermaid/index.js'
import { stringWidth } from './vendor/lovely-mermaid/width.js'
import { notDrawnNote, t, tooWideNote, withLang } from './i18n.ts'
import type { Lang } from './i18n.ts'
export { replyLang, t } from './i18n.ts'
export type { Lang } from './i18n.ts'

/** A fenced mermaid block at the reply's top level: its span in the text and its source. */
export type Diagram = { start: number; end: number; source: string; closed: boolean }

/** What a block becomes: its drawing, or its source framed (`box`) with an optional note on why. */
export type Fit = { kind: 'art'; art: MermaidArt } | { kind: 'box'; art: MermaidArt; note?: string }

export type Part = { text: string } | { diagram: Diagram }

const OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

function closes(line: string, fence: string): boolean {
  const m = CLOSE.exec(line)
  return m !== null && m[1][0] === fence[0] && m[1].length >= fence.length
}

/**
 * Every mermaid fence that starts at column 0. Fences of other languages are
 * tracked too, so a mermaid example inside a ````markdown block stays text;
 * an indented fence (inside a list or quote) is left to the engine.
 */
export function findDiagrams(text: string): Diagram[] {
  const found: Diagram[] = []
  let open: { fence: string; mermaid: boolean; start: number; body: number } | undefined
  let at = 0
  for (const line of text.split('\n')) {
    const next = at + line.length + 1
    if (open === undefined) {
      const m = OPEN.exec(line)
      // A backtick fence's info string cannot hold a backtick: that line is inline code.
      if (m !== null && !(m[2][0] === '`' && m[3].includes('`'))) {
        const info = m[3].trim().split(/\s+/)[0].toLowerCase()
        open = { fence: m[2], mermaid: m[1] === '' && info === 'mermaid', start: at, body: next }
      }
    } else if (closes(line, open.fence)) {
      if (open.mermaid) {
        found.push({ start: open.start, end: at + line.length, source: text.slice(open.body, Math.max(open.body, at - 1)), closed: true })
      }
      open = undefined
    }
    at = next
  }
  if (open?.mermaid) found.push({ start: open.start, end: text.length, source: text.slice(Math.min(open.body, text.length)), closed: false })
  return found
}

/** The text between diagrams and the diagrams themselves, in reply order. */
export function segments(text: string, diagrams: readonly Diagram[]): Part[] {
  const parts: Part[] = []
  let at = 0
  for (const diagram of diagrams) {
    if (diagram.start > at) parts.push({ text: text.slice(at, diagram.start) })
    parts.push({ diagram })
    at = diagram.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}

/** The flowchart header's direction swapped by `swap`, past any frontmatter; undefined when there is none to swap. */
function turn(source: string, swap: (dir: string) => string | undefined): string | undefined {
  const m = /^((?:\s*---\n[\s\S]*?\n---[ \t]*\n)?\s*)(flowchart|graph)([ \t]+)(LR|RL|TD|TB|BT)\b/.exec(source)
  const dir = m === null ? undefined : swap(m[4])
  return m === null || dir === undefined ? undefined : `${m[1]}${m[2]}${m[3]}${dir}${source.slice(m[0].length)}`
}

/** A left-to-right flowchart turned top-down, the shape that usually fits a terminal; undefined for anything else. */
export function topDown(source: string): string | undefined {
  return turn(source, d => (d === 'LR' || d === 'RL' ? 'TD' : undefined))
}

/** The other way round when the first does not fit: left-right turned top-down, top-down turned left-right. */
export function turned(source: string): string | undefined {
  return topDown(source) ?? turn(source, d => (d === 'TD' || d === 'TB' || d === 'BT' ? 'LR' : undefined))
}

/** `art` with `rows` of detail under it, a blank row between. */
function withRows(art: MermaidArt, rows: [string, Role][][]): MermaidArt {
  if (rows.length === 0) return art
  const extra = rows.map(r => r.filter(([t]) => t !== '').map(([text, role]) => ({ text, role })))
  const plain = extra.map(r => r.map(s => s.text).join('').replace(/ +$/, ''))
  return {
    ...art,
    plain: [...art.plain, '', ...plain],
    styled: [...art.styled, [], ...extra],
    width: Math.max(art.width, ...plain.map(stringWidth)),
  }
}

/**
 * The edge labels the layout had no room for (two labeled edges into one
 * node share an arrowhead), listed by edge so the drawing loses nothing silently.
 */
function lostRows(lost: MermaidArt['lostLabels']): [string, Role][][] {
  const byEdge = new Map<string, string[]>()
  for (const { label, from = '?', to = '?' } of lost) {
    const key = `${from} → ${to}`
    byEdge.set(key, [...(byEdge.get(key) ?? []), label])
  }
  if (byEdge.size === 0) return []
  return [[[t('Labels not drawn'), 'edgeLabel']], ...[...byEdge].map(([edge, labels]): [string, Role][] => [[edge, 'text'], ['  ', 'none'], [labels.join(' / '), 'edgeLabel']])]
}

/** Diagram types drawn by default: lovely-mermaid's own, plus our gantt. The rest need `experimental`. */
export const DEFAULT_EXTRA = new Set(['gantt'])

export type FitOptions = { experimental?: boolean; lang?: Lang }

/**
 * The drawing for `columns` cells: as written, then turned the other way.
 * Anything not drawn comes back as its source in a frame (lovely-mermaid's
 * `sourceBox`), with a note when there is a reason worth telling: like pi, a
 * drawing lovely-mermaid had to drop part of is never shown missing an edge.
 *
 * The source is first respelled where lovely-mermaid misreads mermaid.js
 * (normalize.ts). Types lovely-mermaid does not know are, with `experimental`, first
 * rewritten into a grammar it draws (extra/transpile.ts), else drawn by a
 * chart renderer of ours (extra/charts.ts) that lays itself out for `columns`.
 */
export function fit(source: string, columns: number, options: FitOptions = {}): Fit {
  return withLang(options.lang ?? 'en', () => fitIn(source, columns, options))
}

function fitIn(source: string, columns: number, options: FitOptions): Fit {
  const boxed = (note?: string): Fit => ({ kind: 'box', art: sourceBox(source, columns), note })
  const tooWide = (_w: number) => tooWideNote()
  const keyword = (keywordOf(source) ?? '').toLowerCase()
  const extra = options.experimental === true || DEFAULT_EXTRA.has(keyword)
  const rewritten = extra ? rewrite(source) : null
  if (rewritten === null && diagramKind(source) === null) {
    const art = extra ? chart(source, columns) : null
    if (art === null) return boxed()
    if (art.warnings.length > 0) return boxed(notDrawnNote(art.warnings[0] ?? '', 0))
    return art.width <= columns ? { kind: 'art', art } : boxed(tooWide(art.width))
  }
  const normalized = normalize(rewritten?.src ?? source)
  const src = normalized.src
  const after = [...(rewritten?.after ?? []), ...normalized.after]
  let widest = 0
  for (const candidate of [src, turned(src)]) {
    if (candidate === undefined) break
    const drawn = render(candidate)
    if (drawn === null) return boxed()
    const art = withRows(drawn, [...after, ...lostRows(drawn.lostLabels)])
    if (art.warnings.length > 0) {
      return boxed(notDrawnNote(art.warnings[0] ?? '', art.warnings.length - 1))
    }
    if (art.width <= columns) return { kind: 'art', art }
    widest = widest === 0 ? art.width : Math.min(widest, art.width)
  }
  return boxed(tooWide(widest))
}

/**
 * True when cutting the reply into separate Markdown blocks could change it:
 * link reference and footnote definitions resolve across the whole text.
 */
export function needsWholeMarkdown(text: string): boolean {
  return /^ {0,3}\[[^\]\n]{1,999}\]:/m.test(text)
}

/** True when `Markdown` draws the text as is: no control character but tab and newline. */
export function markdownSafe(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)
}

/** The reply with each drawn block swapped for its plain art in a text fence: the colorless path. */
export function plainRewrite(text: string, diagrams: readonly Diagram[], fits: ReadonlyMap<Diagram, Fit>): string {
  return segments(text, diagrams)
    .map(part => {
      if ('text' in part) return part.text
      const f = fits.get(part.diagram)
      return f === undefined ? text.slice(part.diagram.start, part.diagram.end) : ['```text', ...(f.kind === 'box' && f.note ? [f.note] : []), ...f.art.plain, '```'].join('\n')
    })
    .join('')
}
