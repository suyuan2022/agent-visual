// Chart-like diagram types lovely-mermaid does not draw, drawn here in its vocabulary: bars `█` in the edge role over a `░` border track, labels in text, values in edgeLabel.
import { t } from '../i18n.ts'
import { D, L, R, U } from '../vendor/lovely-mermaid/canvas.js'
import { fitLabel, wrapLabel } from '../vendor/lovely-mermaid/labels.js'
import { bar, bodyOf, box, Canvas, commaSplit, drawText, label, num, pad, Rows, stringWidth, unquote } from './common.ts'
import type { Body, MermaidArt, Role } from './common.ts'
import { cynefin, eventmodeling, ishikawa, railroad, treeView, venn, wardley } from './more.ts'

type Chart = (b: Body, columns: number) => MermaidArt | null

/** Every chart, by header keyword (lowercased). */
const CHARTS: Record<string, Chart> = {
  journey,
  gantt,
  quadrantchart: quadrant,
  'xychart-beta': xychart,
  xychart,
  'radar-beta': radar,
  radar,
  'packet-beta': packet,
  packet,
  'treemap-beta': treemap,
  treemap,
  kanban,
  'block-beta': block,
  block,
  info,
  'venn-beta': venn,
  venn,
  'ishikawa-beta': ishikawa,
  ishikawa,
  'treeview-beta': treeView,
  treeview: treeView,
  'cynefin-beta': cynefin,
  cynefin,
  'wardley-beta': wardley,
  wardley,
  eventmodeling,
  'railroad-ebnf-beta': railroad,
  'railroad-abnf-beta': railroad,
  'railroad-peg-beta': railroad,
  'railroad-beta': railroad,
}

/** The chart for a source laid out for `columns`, or `null` when its type is not one drawn here. */
export function chart(src: string, columns: number): MermaidArt | null {
  const b = bodyOf(src)
  if (b === null) return null
  const fn = CHARTS[b.keyword.toLowerCase()]
  return fn === undefined ? null : fn(b, Math.max(20, columns))
}

/** `title X` statements, which every chart grammar shares; the last one wins over a frontmatter title. */
function titleOf(b: Body): string | null {
  let title = b.title
  for (const { text } of b.lines) if (/^title(\s|$)/i.test(text)) title = unquote(text.slice(5).trim()) || null
  return title
}

const isMeta = (text: string) => /^(title|acctitle|accdescr)\b/i.test(text)

// ── journey: sections of tasks, each scored 1–5 by its actors ──

function journey(b: Body): MermaidArt | null {
  const rows = new Rows()
  const tasks: { section: string | null; name: string; score: number; actors: string }[] = []
  let section: string | null = null
  for (const { text } of b.lines) {
    if (isMeta(text)) continue
    if (/^section\s/i.test(text)) {
      section = text.slice(8).trim()
      continue
    }
    const parts = text.split(':')
    if (parts.length < 2) {
      rows.warnings.push(`dropped, unreadable statement: "${text}"`)
      continue
    }
    const score = Math.max(0, Math.min(5, Number(parts[1].trim())))
    tasks.push({ section, name: label(parts[0]), score: Number.isFinite(score) ? score : 0, actors: parts.slice(2).join(':').trim() })
  }
  if (tasks.length === 0) return null
  const nameW = Math.max(...tasks.map(t => stringWidth(t.name)))
  let last: string | null | undefined
  for (const t of tasks) {
    if (t.section !== last && t.section !== null) rows.add([t.section, 'title'])
    last = t.section
    const [fill, track] = bar(t.score / 5, 10)
    rows.add(['  ', 'none'], [pad(t.name, nameW + 2), 'text'], [fill, 'edge'], [track, 'border'], [` ${num(t.score)}`, 'edgeLabel'], [t.actors ? `  ${t.actors}` : '', 'none'])
  }
  return rows.art(titleOf(b))
}

// ── gantt: tasks on a time axis scaled to the terminal ──

const DAY = 86_400_000
const UNIT: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY, M: 30 * DAY, y: 365 * DAY }
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** A date in `format` (dayjs tokens: YYYY YY MM M DD D HH H mm ss X x), as UTC ms; falls back to Date.parse. */
function parseDate(s: string, format: string): number | null {
  const t = s.trim()
  if (format === 'X' && /^\d+$/.test(t)) return Number(t) * 1000
  if (format === 'x' && /^\d+$/.test(t)) return Number(t)
  const order: string[] = []
  const re = format.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|ss|[.*+?^${}()|[\]\\]/g, tok => {
    if (/^[YMDHms]/.test(tok)) {
      order.push(tok)
      return tok.length === 4 ? '(\\d{4})' : tok.length === 2 ? '(\\d{2})' : '(\\d{1,2})'
    }
    return `\\${tok}`
  })
  const m = new RegExp(`^${re}$`).exec(t)
  if (m !== null) {
    const v: Record<string, number> = { Y: 1970, M: 1, D: 1, H: 0, m: 0, s: 0 }
    order.forEach((tok, i) => {
      const n = Number(m[i + 1])
      v[tok[0]] = tok === 'YY' ? 2000 + n : n
    })
    return Date.UTC(v.Y, v.M - 1, v.D, v.H, v.m, v.s)
  }
  const p = Date.parse(t)
  return Number.isNaN(p) ? null : p
}

function gantt(b: Body, columns: number): MermaidArt | null {
  type Task = { section: string | null; name: string; id: string; tags: Set<string>; start?: number; end?: number; startRef: string; endRef: string }
  let format = 'YYYY-MM-DD'
  const excludes: string[] = []
  const tasks: Task[] = []
  let section: string | null = null
  const rows = new Rows()
  for (const { text } of b.lines) {
    const kw = text.split(/\s+/)[0].toLowerCase()
    if (isMeta(text) || ['axisformat', 'tickinterval', 'todaymarker', 'weekday', 'inclusiveenddates', 'topaxis', 'displaymode', 'weekend'].includes(kw)) continue
    if (kw === 'dateformat') {
      format = text.slice(10).trim()
      continue
    }
    if (kw === 'excludes') {
      excludes.push(...text.slice(8).split(/[\s,]+/).filter(Boolean).map(x => x.toLowerCase()))
      continue
    }
    if (kw === 'section') {
      section = text.slice(7).trim()
      continue
    }
    if (/^(click|style|classdef|class)\s/i.test(text)) continue
    const colon = text.indexOf(':')
    if (colon === -1) {
      rows.warnings.push(`dropped, unreadable statement: "${text}"`)
      continue
    }
    const meta = text.slice(colon + 1).split(',').map(x => x.trim()).filter(Boolean)
    const tags = new Set<string>()
    while (meta.length > 0 && ['done', 'active', 'crit', 'milestone', 'vert'].includes(meta[0])) tags.add(meta.shift()!)
    const [startRef, endRef, id] = meta.length >= 3 ? [meta[1], meta[2], meta[0]] : meta.length === 2 ? [meta[0], meta[1], ''] : ['', meta[0] ?? '', '']
    tasks.push({ section, name: label(text.slice(0, colon)), id: id || `task${tasks.length}`, tags, startRef, endRef })
  }
  if (tasks.length === 0) return null

  const excluded = (t: number) => {
    const d = new Date(t)
    const wd = d.getUTCDay()
    const iso = d.toISOString().slice(0, 10)
    return (excludes.includes('weekends') && (wd === 0 || wd === 6)) || excludes.includes(WEEKDAYS[wd]) || excludes.includes(iso)
  }
  const addDuration = (from: number, dur: string): number | null => {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|M|y)$/.exec(dur)
    if (m === null) return null
    const n = Number(m[1])
    if ((m[2] === 'd' || m[2] === 'w') && excludes.length > 0) {
      let left = m[2] === 'w' ? n * 7 : n
      let t = from
      while (left > 0) {
        t += DAY
        if (!excluded(t - DAY)) left--
      }
      return t
    }
    return from + n * UNIT[m[2]]
  }
  const byId = new Map(tasks.map(t => [t.id, t]))
  // References may point forward: resolve until nothing changes.
  for (let pass = 0; pass < 6; pass++) {
    tasks.forEach((t, i) => {
      if (t.start === undefined) {
        if (t.startRef === '') t.start = i === 0 ? undefined : tasks[i - 1].end
        else if (/^after\s/i.test(t.startRef)) {
          const ends = t.startRef.slice(6).split(/\s+/).map(id => byId.get(id)?.end)
          if (ends.every(e => e !== undefined)) t.start = Math.max(...(ends as number[]))
        } else t.start = parseDate(t.startRef, format) ?? undefined
      }
      if (t.start !== undefined && t.end === undefined) {
        if (/^until\s/i.test(t.endRef)) {
          const starts = t.endRef.slice(6).trim().split(/\s+/).map(id => byId.get(id)?.start)
          if (starts.every(s => s !== undefined)) t.end = Math.min(...(starts as number[]))
        }
        else t.end = addDuration(t.start, t.endRef) ?? parseDate(t.endRef, format) ?? undefined
      }
    })
  }
  const placed = tasks.filter(t => t.start !== undefined && t.end !== undefined) as (Task & { start: number; end: number })[]
  for (const t of tasks) if (!placed.includes(t as never)) rows.warnings.push(`dropped, task without a resolvable time: "${t.name}"`)
  if (placed.length === 0) return null

  const t0 = Math.min(...placed.map(t => t.start))
  const t1 = Math.max(...placed.map(t => Math.max(t.end, t.start)))
  const nameW = Math.min(24, Math.max(...placed.map(t => stringWidth(t.name)), ...placed.map(t => stringWidth(t.section ?? '') - 2)))
  const lead = 2 + nameW + 2
  const width = Math.max(10, Math.min(72, columns - lead))
  const span = Math.max(t1 - t0, 1)
  const cell = (t: number) => ((t - t0) / span) * width

  // Ticks on whole days (whole hours under two days), as far apart as a label needs.
  const short = span < 2 * DAY
  const stamp = (t: number) => new Date(t).toISOString().slice(short ? 11 : 5, short ? 16 : 10)
  const unit = short ? 3_600_000 : DAY
  const step = Math.max(1, Math.ceil((7 / width) * (span / unit))) * unit
  let axis = ''
  for (let t = Math.ceil(t0 / unit) * unit; t <= t1; t += step) {
    const x = Math.round(cell(t))
    if (x + 5 > width || x < stringWidth(axis)) continue
    axis = pad(axis, x) + stamp(t)
  }
  rows.add([' '.repeat(lead), 'none'], [axis, 'edgeLabel'])

  let last: string | null | undefined
  for (const t of placed) {
    if (t.section !== last && t.section !== null) rows.add([t.section, 'title'])
    last = t.section
    const a = Math.min(width - 1, Math.floor(cell(t.start)))
    const role: Role = t.tags.has('crit') ? 'title' : t.tags.has('done') ? 'border' : 'edge'
    const glyphs = t.tags.has('milestone') || t.end <= t.start ? '◆' : '█'.repeat(Math.max(1, Math.ceil(cell(t.end)) - a))
    rows.add(['  ', 'none'], [pad(fitLabel(t.name, nameW), nameW + 2), 'text'], [' '.repeat(a), 'none'], [glyphs, role])
  }
  const used = new Set(placed.flatMap(t => [...t.tags]))
  if (used.has('done') || used.has('crit') || used.has('active')) {
    rows.blank()
    rows.add([' '.repeat(lead), 'none'], ['█', 'edge'], [t(' planned / active  '), 'none'], ['█', 'border'], [t(' done  '), 'none'], ['█', 'title'], [t(' critical'), 'none'])
  }
  return rows.art(titleOf(b))
}

// ── quadrantChart: a 2×2 grid, quadrant names in their corners, points plotted ──

function quadrant(b: Body, columns: number): MermaidArt | null {
  const quads: string[] = ['', '', '', '']
  let xAxis = ['', '']
  let yAxis = ['', '']
  const points: { name: string; x: number; y: number }[] = []
  const rows = new Rows()
  for (const { text } of b.lines) {
    if (isMeta(text) || /^classdef\s/i.test(text)) continue
    const qm = /^quadrant-([1-4])\s+(.*)$/i.exec(text)
    if (qm !== null) {
      quads[Number(qm[1]) - 1] = label(qm[2])
      continue
    }
    const am = /^([xy])-axis\s+(.*)$/i.exec(text)
    if (am !== null) {
      const ends = am[2].split('-->').map(s => label(s))
      if (am[1].toLowerCase() === 'x') xAxis = [ends[0] ?? '', ends[1] ?? '']
      else yAxis = [ends[0] ?? '', ends[1] ?? '']
      continue
    }
    const pm = /^(.*?)(?::::\w+)?\s*:\s*\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]/.exec(text)
    if (pm !== null) {
      points.push({ name: label(pm[1]), x: Number(pm[2]), y: Number(pm[3]) })
      continue
    }
    rows.warnings.push(`dropped, unreadable statement: "${text}"`)
  }
  if (points.length === 0 && quads.every(x => x === '')) return null
  const W = Math.max(24, Math.min(48, columns - 2) & ~1)
  const H = Math.max(8, Math.round(W / 4) | 1)
  const c = new Canvas(W + 1, H + 1)
  box(c, 0, 0, W + 1, H + 1)
  const mx = W / 2
  const my = Math.floor(H / 2)
  for (let y = 0; y <= H; y++) c.addBits(mx, y, (y > 0 ? U : 0) | (y < H ? D : 0), 'border')
  for (let x = 0; x <= W; x++) c.addBits(x, my, (x > 0 ? L : 0) | (x < W ? R : 0), 'border')
  const corner = [
    [mx + 2, 1],
    [2, 1],
    [2, my + 1],
    [mx + 2, my + 1],
  ]
  quads.forEach((name, i) => name && drawText(c, fitLabel(name, mx - 3), corner[i][0], corner[i][1], 'edgeLabel'))
  for (const p of points) {
    const px = 1 + Math.round(Math.max(0, Math.min(1, p.x)) * (W - 2))
    const py = 1 + Math.round((1 - Math.max(0, Math.min(1, p.y))) * (H - 2))
    drawText(c, '●', px, py, 'edge')
    const name = fitLabel(p.name, Math.max(4, W - px - 3))
    const nx = px + 2 + stringWidth(name) < W ? px + 2 : Math.max(1, px - 1 - stringWidth(name))
    drawText(c, name, nx, py, 'text')
  }
  c.finalizeMask()
  // y runs bottom to top, x left to right: each axis's low and high ends at its own ends.
  if (yAxis[1]) rows.add([`↑ ${yAxis[1]}`, 'edgeLabel'])
  rows.addCanvas(c)
  if (yAxis[0]) rows.add([`↓ ${yAxis[0]}`, 'edgeLabel'])
  const xl = xAxis[0] ? `← ${xAxis[0]}` : ''
  const xr = xAxis[1] ? `${xAxis[1]} →` : ''
  if (xl || xr) rows.add([pad(xl, W + 1 - stringWidth(xr)), 'edgeLabel'], [xr, 'edgeLabel'])
  return rows.art(titleOf(b))
}

// ── xychart: bar and line series over categories, vertical or horizontal ──

function listOf(s: string): string[] {
  const m = /\[(.*)\]/.exec(s)
  return m === null ? [] : commaSplit(m[1]).map(x => label(x))
}

function xychart(b: Body, columns: number): MermaidArt | null {
  const horizontal = /horizontal/i.test(b.rest)
  let cats: string[] = []
  let xTitle = ''
  let yTitle = ''
  let yMin: number | null = null
  let yMax: number | null = null
  const series: { kind: 'bar' | 'line'; name: string; values: number[] }[] = []
  const rows = new Rows()
  for (const { text } of b.lines) {
    if (isMeta(text)) continue
    const ax = /^([xy])-axis\s*(.*)$/i.exec(text)
    if (ax !== null) {
      const rest = ax[2]
      const t = /^("[^"]*"|[^\s[]+(?=\s))/.exec(rest)
      const range = /([-\d.]+)\s*-->\s*([-\d.]+)/.exec(rest)
      if (ax[1].toLowerCase() === 'x') {
        if (rest.includes('[')) cats = listOf(rest)
        if (t !== null && !range) xTitle = label(t[1])
        if (range !== null) {
          const [lo, hi] = [Number(range[1]), Number(range[2])]
          cats = Array.from({ length: 0 }, () => '')
          xTitle = t !== null ? label(t[1]) : xTitle
          ;(rows as unknown as { range: number[] }).range = [lo, hi]
        }
      } else {
        if (t !== null) yTitle = label(t[1])
        else if (!range && rest.trim()) yTitle = label(rest)
        if (range !== null) [yMin, yMax] = [Number(range[1]), Number(range[2])]
      }
      continue
    }
    const sm = /^(bar|line)\s*("[^"]*")?\s*(\[.*\])\s*$/i.exec(text)
    if (sm !== null) {
      series.push({ kind: sm[1].toLowerCase() as 'bar' | 'line', name: sm[2] ? label(sm[2]) : '', values: listOf(sm[3]).map(Number) })
      continue
    }
    rows.warnings.push(`dropped, unreadable statement: "${text}"`)
  }
  if (series.length === 0) return null
  const n = Math.max(...series.map(s => s.values.length))
  const range = (rows as unknown as { range?: number[] }).range
  if (cats.length < n) {
    cats = Array.from({ length: n }, (_, i) => cats[i] ?? (range ? num(range[0] + ((range[1] - range[0]) * i) / Math.max(1, n - 1)) : String(i + 1)))
  }
  const all = series.flatMap(s => s.values).filter(Number.isFinite)
  const lo = yMin ?? Math.min(0, ...all)
  const hi = yMax ?? Math.max(...all)
  const share = (v: number) => (hi === lo ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo))))
  const bars = series.filter(s => s.kind === 'bar')
  const lines = series.filter(s => s.kind === 'line')

  const catW = Math.max(...cats.map(stringWidth))
  const verticalW = 8 + cats.length * Math.max(catW + 1, bars.length * 2 + 2)
  if (horizontal || verticalW > columns) {
    // One row per category and bar series; line series print as values.
    const barW = Math.max(8, Math.min(32, columns - catW - 12))
    if (yTitle) rows.add([pad('', catW + 2), 'none'], [`${yTitle} (${num(lo)} → ${num(hi)})`, 'edgeLabel'])
    cats.forEach((cat, i) => {
      series.forEach((s, k) => {
        const v = s.values[i]
        if (v === undefined) return
        const [fill, track] = bar(share(v), barW)
        const head = k === 0 ? pad(cat, catW + 2) : ' '.repeat(catW + 2)
        if (s.kind === 'bar') rows.add([head, 'text'], [fill, 'edge'], [track, 'border'], [` ${num(v)}`, 'edgeLabel'], [s.name ? `  ${s.name}` : '', 'none'])
        else rows.add([head, 'text'], [' '.repeat(Math.max(0, Math.round(share(v) * barW) - 1)), 'none'], ['●', 'title'], [` ${num(v)}`, 'edgeLabel'], [s.name ? `  ${s.name}` : '', 'none'])
      })
    })
    if (xTitle) rows.add([xTitle, 'edgeLabel'])
    return rows.art(titleOf(b))
  }

  const H = 10
  const colW = Math.max(catW + 1, bars.length * 2 + 2)
  const tick = [num(hi), num((hi + lo) / 2), num(lo)]
  const axisW = Math.max(...tick.map(stringWidth)) + 1
  const c = new Canvas(axisW + 1 + cats.length * colW + 1, H + 2)
  const V = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  for (let y = 0; y < H; y++) c.addBits(axisW, y, U | D, 'border')
  c.addBits(axisW, H, U | R, 'border')
  for (let x = axisW + 1; x < c.w; x++) c.addBits(x, H, L | (x < c.w - 1 ? R : 0), 'border')
  drawText(c, tick[0], axisW - stringWidth(tick[0]) - 1, 0, 'edgeLabel')
  drawText(c, tick[1], axisW - stringWidth(tick[1]) - 1, Math.floor(H / 2), 'edgeLabel')
  drawText(c, tick[2], axisW - stringWidth(tick[2]) - 1, H - 1, 'edgeLabel')
  cats.forEach((cat, i) => {
    const x0 = axisW + 1 + i * colW
    bars.forEach((s, k) => {
      const v = s.values[i]
      if (v === undefined || !Number.isFinite(v)) return
      const eighths = Math.round(share(v) * H * 8)
      for (let y = 0; y < H; y++) {
        const fromBottom = H - 1 - y
        const e = Math.max(0, Math.min(8, eighths - fromBottom * 8))
        if (e > 0) drawText(c, V[e].repeat(2), x0 + 1 + k * 2, y, 'edge')
      }
    })
    lines.forEach(s => {
      const v = s.values[i]
      if (v === undefined || !Number.isFinite(v)) return
      const y = H - 1 - Math.min(H - 1, Math.floor(share(v) * H - 1e-9))
      drawText(c, '●', x0 + Math.floor(colW / 2), Math.max(0, y), 'title')
    })
    drawText(c, cat, x0 + Math.max(0, Math.floor((colW - stringWidth(cat)) / 2)), H + 1, 'text')
  })
  c.finalizeMask()
  if (yTitle) rows.add([yTitle, 'edgeLabel'])
  rows.addCanvas(c)
  if (xTitle) rows.add([pad('', axisW + 1), 'none'], [xTitle, 'edgeLabel'])
  const named = series.filter(s => s.name)
  if (named.length > 0 || (bars.length > 0 && lines.length > 0)) {
    rows.add(
      ...series.flatMap((s, i): [string, Role][] => [
        [i === 0 ? '' : '   ', 'none'],
        [s.kind === 'bar' ? '██' : '●', s.kind === 'bar' ? 'edge' : 'title'],
        [` ${s.name || (s.kind === 'bar' ? 'bar' : 'line')}`, 'none'],
      ]),
    )
  }
  return rows.art(titleOf(b))
}

// ── radar: one bar per curve on every axis ──

function radar(b: Body, columns: number): MermaidArt | null {
  const axes: { id: string; name: string }[] = []
  const curves: { name: string; values: Map<string, number> }[] = []
  let max: number | null = null
  let min = 0
  const rows = new Rows()
  const idLabel = (s: string) => {
    const m = /^([\w-]+)\s*(?:\[\s*(.*?)\s*\])?$/.exec(s.trim())
    return m === null ? { id: s.trim(), name: label(s) } : { id: m[1], name: m[2] ? label(m[2]) : m[1] }
  }
  for (const { text } of b.lines) {
    if (isMeta(text) || /^(graticule|ticks|showlegend)\b/i.test(text)) continue
    if (/^axis\s/i.test(text)) {
      axes.push(...commaSplit(text.slice(5)).map(idLabel))
      continue
    }
    if (/^max\s/i.test(text)) {
      max = Number(text.slice(4))
      continue
    }
    if (/^min\s/i.test(text)) {
      min = Number(text.slice(4))
      continue
    }
    if (/^curve\s/i.test(text)) {
      for (const part of text.slice(6).split(/(?<=\})\s*,\s*/)) {
        const m = /^(.*?)\{(.*)\}\s*$/.exec(part.trim())
        if (m === null) continue
        const values = new Map<string, number>()
        commaSplit(m[2]).forEach((v, i) => {
          const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(v)
          if (kv !== null) values.set(kv[1], Number(kv[2]))
          else values.set(axes[i]?.id ?? String(i), Number(v))
        })
        curves.push({ name: idLabel(m[1]).name, values })
      }
      continue
    }
    rows.warnings.push(`dropped, unreadable statement: "${text}"`)
  }
  if (axes.length === 0 || curves.length === 0) return null
  const hi = max ?? Math.max(...curves.flatMap(c => [...c.values.values()]))
  const axisW = Math.max(...axes.map(a => stringWidth(a.name)))
  const curveW = Math.max(...curves.map(c => stringWidth(c.name)))
  const barW = Math.max(8, Math.min(30, columns - axisW - curveW - 10))
  for (const a of axes) {
    curves.forEach((c, k) => {
      const v = c.values.get(a.id) ?? 0
      const [fill, track] = bar(hi === min ? 0 : (v - min) / (hi - min), barW)
      rows.add([pad(k === 0 ? a.name : '', axisW + 2), 'text'], [pad(c.name, curveW + 1), 'none'], [fill, 'edge'], [track, 'border'], [` ${num(v)}`, 'edgeLabel'])
    })
  }
  return rows.art(titleOf(b))
}

// ── packet: bit fields in rows of 32 (16 when narrow), a bit ruler above each row ──

function packet(b: Body, columns: number): MermaidArt | null {
  const fields: { from: number; to: number; name: string }[] = []
  const rows = new Rows()
  let next = 0
  for (const { text } of b.lines) {
    if (isMeta(text)) continue
    const m = /^(?:(\d+)(?:\s*-\s*(\d+))?|\+(\d+))\s*:\s*(.*)$/.exec(text)
    if (m === null) {
      rows.warnings.push(`dropped, unreadable statement: "${text}"`)
      continue
    }
    const from = m[3] !== undefined ? next : Number(m[1])
    const to = m[3] !== undefined ? next + Number(m[3]) - 1 : m[2] !== undefined ? Number(m[2]) : from
    fields.push({ from, to, name: label(m[4]) })
    next = to + 1
  }
  if (fields.length === 0) return null
  const perRow = columns >= 2 * 32 + 1 ? 32 : 16
  const cpb = columns >= 2 * perRow + 1 ? 2 : 1
  const lastBit = Math.max(...fields.map(f => f.to))
  for (let start = 0; start <= lastBit; start += perRow) {
    const end = start + perRow - 1
    const inRow = fields.filter(f => f.to >= start && f.from <= end).map(f => ({ ...f, a: Math.max(f.from, start), z: Math.min(f.to, end) }))
    if (inRow.length === 0) continue
    const c = new Canvas(perRow * cpb + 1, 4)
    for (const f of inRow) {
      const x = (f.a - start) * cpb
      const w = (f.z - f.a + 1) * cpb + 1
      drawText(c, String(f.a), x, 0, 'edgeLabel')
      box(c, x, 1, w, 3)
      const name = fitLabel(f.name, w - 3)
      drawText(c, name, x + Math.max(1, Math.floor((w - stringWidth(name)) / 2)), 2, 'text')
    }
    c.finalizeMask()
    rows.addCanvas(c)
  }
  return rows.art(titleOf(b))
}

// ── treemap: the hierarchy as a tree, each node's share of the whole as a bar ──

type TreeNode = { name: string; value: number; children: TreeNode[] }

function treemap(b: Body, columns: number): MermaidArt | null {
  const root: TreeNode = { name: '', value: 0, children: [] }
  const stack: { indent: number; node: TreeNode }[] = [{ indent: -1, node: root }]
  const rows = new Rows()
  for (const { text, indent } of b.lines) {
    if (isMeta(text) || /^classdef\s/i.test(text)) continue
    const m = /^("[^"]*"|[^:]+?)(?::::\w+)?\s*(?::\s*([-\d.]+))?\s*(?::::\w+)?$/.exec(text)
    if (m === null) {
      rows.warnings.push(`dropped, unreadable statement: "${text}"`)
      continue
    }
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const node: TreeNode = { name: label(m[1]), value: m[2] !== undefined ? Number(m[2]) : 0, children: [] }
    stack[stack.length - 1].node.children.push(node)
    stack.push({ indent, node })
  }
  const total = (n: TreeNode): number => (n.children.length === 0 ? n.value : (n.value = n.children.reduce((s, c) => s + total(c), 0)))
  const sum = total(root)
  if (root.children.length === 0) return null
  const lines: { prefix: string; node: TreeNode }[] = []
  const walk = (n: TreeNode, prefix: string, childPrefix: string) => {
    lines.push({ prefix, node: n })
    n.children.forEach((c, i) => {
      const lastOne = i === n.children.length - 1
      walk(c, childPrefix + (lastOne ? '└── ' : '├── '), childPrefix + (lastOne ? '    ' : '│   '))
    })
  }
  for (const top of root.children) walk(top, '', '')
  const headW = Math.max(...lines.map(l => stringWidth(l.prefix + l.node.name)))
  const valW = Math.max(...lines.map(l => num(l.node.value).length))
  const barW = Math.max(8, Math.min(24, columns - headW - valW - 10))
  for (const l of lines) {
    const [fill, track] = bar(sum === 0 ? 0 : l.node.value / sum, barW)
    const pct = sum === 0 ? '' : `${Math.round((l.node.value / sum) * 100)}%`.padStart(5)
    rows.add([l.prefix, 'edge'], [pad(l.node.name, headW - stringWidth(l.prefix) + 2), l.node.children.length > 0 ? 'title' : 'text'], [num(l.node.value).padStart(valW), 'edgeLabel'], ['  ', 'none'], [fill, 'edge'], [track, 'border'], [pct, 'edgeLabel'])
  }
  return rows.art(titleOf(b))
}

// ── kanban: columns of task cards, side by side when they fit, stacked when not ──

function kanban(b: Body, columns: number): MermaidArt | null {
  type Card = { text: string; meta: string }
  const cols: { name: string; cards: Card[] }[] = []
  const base = Math.min(...b.lines.map(l => l.indent))
  const nodeText = (s: string) => {
    const m = /^(?:[\w-]*)\s*\[(.*)\]\s*(?:@\{(.*)\})?\s*$/.exec(s)
    if (m === null) return { text: label(s.replace(/@\{.*\}\s*$/, '')), meta: '' }
    const meta = (m[2] ?? '')
      .split(',')
      .map(kv => kv.split(':').slice(1).join(':').trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
      .join(' · ')
    return { text: label(m[1]), meta }
  }
  for (const { text, indent } of b.lines) {
    if (isMeta(text)) continue
    if (indent === base) cols.push({ name: nodeText(text).text, cards: [] })
    else if (cols.length > 0) cols[cols.length - 1].cards.push(nodeText(text))
  }
  if (cols.length === 0) return null
  const cardW = Math.max(14, Math.min(24, ...cols.flatMap(c => [stringWidth(c.name), ...c.cards.map(k => stringWidth(k.text) + 4)])))
  const drawColumn = (col: (typeof cols)[number]) => {
    const wrapped = col.cards.map(k => ({ lines: wrapLabel(k.text, cardW - 4, 4), meta: k.meta ? fitLabel(k.meta, cardW - 4) : '' }))
    const h = 1 + wrapped.reduce((s, k) => s + k.lines.length + (k.meta ? 1 : 0) + 2, 0)
    const c = new Canvas(cardW, Math.max(1, h))
    drawText(c, fitLabel(col.name, cardW), 0, 0, 'title')
    let y = 1
    for (const k of wrapped) {
      const kh = k.lines.length + (k.meta ? 1 : 0) + 2
      box(c, 0, y, cardW, kh)
      k.lines.forEach((ln, i) => drawText(c, ln, 2, y + 1 + i, 'text'))
      if (k.meta) drawText(c, k.meta, 2, y + 1 + k.lines.length, 'edgeLabel')
      y += kh
    }
    c.finalizeMask()
    return c
  }
  const canvases = cols.map(drawColumn)
  const rows = new Rows()
  const gap = 2
  if (cols.length * (cardW + gap) - gap <= columns) {
    const all = new Canvas(cols.length * (cardW + gap), Math.max(...canvases.map(c => c.h)))
    canvases.forEach((c, i) => all.blit(c, i * (cardW + gap), 0))
    rows.addCanvas(all)
  } else {
    canvases.forEach((c, i) => {
      if (i > 0) rows.blank()
      rows.addCanvas(c)
    })
  }
  return rows.art(titleOf(b))
}

// ── block: blocks on a grid of `columns`, spans honoured, nested blocks framed; links listed below ──

type Block = { id: string; text: string; span: number; space: boolean; cols: number | null; children: Block[] }

function block(b: Body, columns: number): MermaidArt | null {
  const root: Block = { id: '', text: '', span: 1, space: false, cols: null, children: [] }
  const stack: Block[] = [root]
  const links: [string, string, string][] = []
  const names = new Map<string, string>()
  const rows = new Rows()
  const TOKEN = /("[^"]*"|\[[^\]]*\]+|\([^)]*\)+|\{[^}]*\}+|<\[[^\]]*\]>\([^)]*\)|>[^\]]*\]|[^\s"[({<>]+)+/g
  for (const { text } of b.lines) {
    const top = stack[stack.length - 1]
    if (isMeta(text) || /^(style|classdef|class)\s/i.test(text)) continue
    const cm = /^columns\s+(\d+|auto)$/i.exec(text)
    if (cm !== null) {
      top.cols = cm[1] === 'auto' ? null : Number(cm[1])
      continue
    }
    if (text === 'end') {
      if (stack.length > 1) stack.pop()
      continue
    }
    const bm = /^block(?::([\w-]+))?(?::(\d+))?\s*(?:\[(.*)\])?$/.exec(text)
    if (bm !== null) {
      const node: Block = { id: bm[1] ?? '', text: bm[3] ? label(bm[3]) : '', span: Number(bm[2] ?? 1), space: false, cols: null, children: [] }
      top.children.push(node)
      stack.push(node)
      continue
    }
    const lm = /^([\w-]+)\s*(-->|---|==>|-\.->|--\s*"[^"]*"\s*-->|--\s*[^-]+?\s*-->)\s*([\w-]+)$/.exec(text)
    if (lm !== null) {
      const lbl = /--\s*"?([^"]*?)"?\s*-->/.exec(lm[2])
      links.push([lm[1], lm[3], lbl && lm[2] !== '-->' ? label(lbl[1]) : ''])
      continue
    }
    for (const tok of text.match(TOKEN) ?? []) {
      const sm = /^space(?::(\d+))?$/.exec(tok)
      if (sm !== null) {
        top.children.push({ id: '', text: '', span: Number(sm[1] ?? 1), space: true, cols: null, children: [] })
        continue
      }
      const m = /^([\w-]+)(.*?)(?::(\d+))?$/.exec(tok)
      if (m === null) continue
      const inner = /^[[({<>]+(.*?)[\])}>]*(?:\([^)]*\))?$/.exec(m[2])
      const shown = inner !== null && inner[1] !== '' ? label(inner[1].replace(/^[/\\]|[/\\]$/g, '')) : m[1]
      names.set(m[1], shown)
      top.children.push({ id: m[1], text: shown, span: Number(m[3] ?? 1), space: false, cols: null, children: [] })
    }
  }
  if (root.children.length === 0) return null

  // Each container lays its children on a grid of equal columns, `cols` wide (all in one row when unset).
  const unitOf = (n: Block): number => Math.max(6, ...n.children.map(c => Math.ceil(sizeOf(c).w / c.span)))
  const sizeOf = (n: Block): { w: number; h: number } => {
    if (n.children.length === 0) return { w: Math.min(26, stringWidth(n.text) + 4), h: 3 }
    const grid = layout(n)
    return { w: grid.w + 2, h: grid.h + 2 + (n.text ? 1 : 0) }
  }
  const layout = (n: Block) => {
    const cols = n.cols ?? n.children.reduce((s, c) => s + c.span, 0)
    const unit = unitOf(n)
    const placed: { node: Block; x: number; y: number; w: number }[] = []
    let col = 0
    let y = 0
    let rowH = 0
    for (const c of n.children) {
      const span = Math.min(c.span, cols)
      if (col + span > cols) {
        col = 0
        y += rowH + 1
        rowH = 0
      }
      const w = span * unit + (span - 1) * 2
      placed.push({ node: c, x: col * (unit + 2), y, w })
      rowH = Math.max(rowH, c.space ? 3 : sizeOf(c).h)
      col += span
    }
    return { placed, w: cols * unit + (cols - 1) * 2, h: y + rowH }
  }
  const paint = (c: Canvas, n: Block, ox: number, oy: number) => {
    const grid = layout(n)
    for (const p of grid.placed) {
      if (p.node.space) continue
      const h = sizeOf(p.node).h
      if (p.node.children.length === 0) {
        box(c, ox + p.x, oy + p.y, p.w, h)
        const t = fitLabel(p.node.text, p.w - 4)
        drawText(c, t, ox + p.x + Math.floor((p.w - stringWidth(t)) / 2), oy + p.y + 1, 'text')
      } else {
        box(c, ox + p.x, oy + p.y, p.w, h)
        if (p.node.text) drawText(c, fitLabel(p.node.text, p.w - 4), ox + p.x + 2, oy + p.y + 1, 'edgeLabel')
        paint(c, p.node, ox + p.x + 1, oy + p.y + 1 + (p.node.text ? 1 : 0))
      }
    }
  }
  const grid = layout(root)
  const c = new Canvas(grid.w, grid.h)
  paint(c, root, 0, 0)
  c.finalizeMask()
  rows.addCanvas(c)
  if (links.length > 0) {
    rows.blank()
    for (const [a, z, t] of links) rows.add([names.get(a) ?? a, 'text'], [' ──', 'edge'], [t ? ` ${t} ` : '', 'edgeLabel'], ['──▶ ', 'edge'], [names.get(z) ?? z, 'text'])
  }
  return rows.art(titleOf(b))
}

// ── info: mermaid's version probe; here, what draws the diagrams ──

function info(): MermaidArt {
  const rows = new Rows()
  rows.add(['mermaid', 'title'], [' · drawn in the terminal by ', 'none'], ['agent-visual', 'text'], [' with ', 'none'], ['lovely-mermaid 0.3.3', 'edgeLabel'])
  return rows.art(null)
}
