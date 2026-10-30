// Shared by the diagram types lovely-mermaid does not draw: source lines, labels, and two ways to build art in lovely's own vocabulary.
import { Canvas, D, drawText, L, R, U } from '../vendor/lovely-mermaid/canvas.js'
import { cleanLabel, srcLines } from '../vendor/lovely-mermaid/labels.js'
import { frontmatterEnd, frontmatterTitle } from '../vendor/lovely-mermaid/statements.js'
import type { MermaidArt, Role, Span } from '../vendor/lovely-mermaid/types.js'
import { stringWidth } from '../vendor/lovely-mermaid/width.js'

export { Canvas, drawText, stringWidth }
export type { MermaidArt, Role, Span }

/** One source line after frontmatter and `%%` comments are gone, with its indent kept for the indentation grammars. */
export type Line = { text: string; indent: number }

/** The diagram's lines past the header, and the header's own words after its keyword. */
export type Body = { keyword: string; rest: string; lines: Line[]; title: string | null }

const COMMENT = /^\s*%%/

/** Splits a source into header and body; `null` when there is no header line. */
export function bodyOf(src: string): Body | null {
  const all = srcLines(src)
  const lines: Line[] = []
  for (const raw of all.slice(frontmatterEnd(all))) {
    if (raw.trim() === '' || COMMENT.test(raw)) continue
    const text = raw.replace(/\s+%%.*$/, '').replace(/\s+$/, '')
    lines.push({ text: text.trim(), indent: text.length - text.trimStart().length })
  }
  const head = lines.shift()
  if (head === undefined) return null
  const [keyword, ...rest] = head.text.split(/\s+/)
  return { keyword, rest: rest.join(' '), lines, title: frontmatterTitle(src) }
}

/** The header keyword alone, `null` when the source is blank. */
export function keywordOf(src: string): string | null {
  return bodyOf(src)?.keyword ?? null
}

/** Strips one pair of surrounding double quotes. */
export function unquote(s: string): string {
  const t = s.trim()
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t
}

/** A label as displayed: quotes, markup and entities resolved. */
export function label(s: string): string {
  return cleanLabel(unquote(s))
}

/** Splits on commas outside double quotes, trimming each part. */
export function commaSplit(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const c of s) {
    if (c === '"') quoted = !quoted
    if (c === ',' && !quoted) {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim())
  return out
}

/** Pads with spaces to `w` display columns. */
export function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - stringWidth(s)))
}

/** Escapes a label for a quoted flowchart/sequence label: lovely decodes the entity back. */
export function q(s: string): string {
  return `"${s.replace(/"/g, '#quot;')}"`
}

/**
 * Row-by-row art, for charts whose layout is a list of lines: each row a run
 * of spans in lovely's roles, so the plugin paints them like lovely's own.
 */
export class Rows {
  private rows: Span[][] = []
  warnings: string[] = []

  /** Appends a row; adjacent spans of one role merge. */
  add(...spans: [string, Role][]): void {
    const row: Span[] = []
    for (const [text, role] of spans) {
      if (text === '') continue
      const last = row[row.length - 1]
      if (last !== undefined && last.role === role) last.text += text
      else row.push({ text, role })
    }
    this.rows.push(row)
  }

  blank(): void {
    this.rows.push([])
  }

  /** Appends every row of a canvas, indented by `x` columns. */
  addCanvas(canvas: Canvas, x = 0): void {
    for (const row of canvas.toLines().styled) this.rows.push(x > 0 && row.length > 0 ? [{ text: ' '.repeat(x), role: 'none' }, ...row] : row)
  }

  get width(): number {
    return Math.max(0, ...this.rows.map(r => stringWidth(r.map(s => s.text).join(''))))
  }

  /** The finished art, `title` centred on top the way lovely draws a frontmatter title. */
  art(title: string | null): MermaidArt {
    const rows = this.rows.map(r => r.map(s => ({ ...s })))
    while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop()
    let width = this.width
    if (title !== null && title !== '') {
      const tw = stringWidth(title)
      width = Math.max(width, tw)
      const padding = ' '.repeat(Math.floor((width - tw) / 2))
      rows.unshift(padding === '' ? [{ text: title, role: 'title' }] : [{ text: padding, role: 'none' }, { text: title, role: 'title' }], [])
    }
    const styled = rows.map(r => {
      const out = r.map(s => ({ ...s }))
      const last = out[out.length - 1]
      if (last !== undefined) last.text = last.text.replace(/ +$/, '')
      return out.filter(s => s.text !== '')
    })
    return { plain: styled.map(r => r.map(s => s.text).join('')), styled, width, warnings: this.warnings, classDefs: {} }
  }
}

/** A box outline on a canvas, in the `border` role; shared edges of adjacent boxes join into tees and crosses. */
export function box(canvas: Canvas, x: number, y: number, w: number, h: number): void {
  const x1 = x + w - 1
  const y1 = y + h - 1
  for (let i = x; i <= x1; i++) {
    canvas.addBits(i, y, (i > x ? L : 0) | (i < x1 ? R : 0), 'border')
    canvas.addBits(i, y1, (i > x ? L : 0) | (i < x1 ? R : 0), 'border')
  }
  for (let j = y; j <= y1; j++) {
    canvas.addBits(x, j, (j > y ? U : 0) | (j < y1 ? D : 0), 'border')
    canvas.addBits(x1, j, (j > y ? U : 0) | (j < y1 ? D : 0), 'border')
  }
}

/** A horizontal bar `width` cells wide, filled to `share` of it in eighths; the rest is track. */
export function bar(share: number, width: number): [string, string] {
  const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
  const eighths = Math.max(0, Math.min(width * 8, Math.round(share * width * 8)))
  let fill = '█'.repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8]
  if (fill === '' && share > 0) fill = '▏'
  return [fill, '░'.repeat(width - stringWidth(fill))]
}

/** A number as a chart prints it: integers bare, others to two places at most. */
export function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}
