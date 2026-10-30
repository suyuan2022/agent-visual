// Inline images in a reply: a line that is only `![alt](/abs/path.png "w=60 center")`, drawn as the picture with a
// link to the original under it, sized the way pi sizes it. Where the lines are and how big; no Claude Code API here.

/** An image line at the reply's top level: its span in the text and what it asks for. */
export type ImageLine = { start: number; end: number; alt: string; path: string; width?: number; center: boolean }

const LINE = /^ {0,3}!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** The title's options, as pi reads them: `w=<columns>` and `center`. */
export function parseOptions(title = ''): { width?: number; center: boolean } {
  const w = /(?:^|\s)w=(\d+)/.exec(title)
  return { width: w ? Number(w[1]) : undefined, center: /(?:^|\s)center(?:\s|$)/.test(title) }
}

/** The local path an image names, `~/` against `home` and `file://` decoded; undefined when it is not one. */
export function localPath(raw: string, home: string | undefined): string | undefined {
  const path = raw.startsWith('~/') && home ? home + raw.slice(1) : raw.startsWith('file://') ? decodeURI(raw.slice(7)) : raw
  return path.startsWith('/') ? path : undefined
}

/** Every line that is only a local image, outside code fences, in reply order. */
export function findImages(text: string, home: string | undefined): ImageLine[] {
  const found: ImageLine[] = []
  let fence: string | undefined
  let at = 0
  for (const line of text.split('\n')) {
    const run = FENCE.exec(line)?.[1]
    if (run !== undefined) {
      if (fence === undefined) fence = run
      else if (run[0] === fence[0] && run.length >= fence.length) fence = undefined
    } else if (fence === undefined) {
      const m = LINE.exec(line)
      const path = m === null ? undefined : localPath(m[2] ?? '', home)
      if (m !== null && path !== undefined) found.push({ start: at, end: at + line.length, alt: m[1] ?? '', path, ...parseOptions(m[3]) })
    }
    at += line.length + 1
  }
  return found
}

/** The pixel size in a PNG's header, from the start of its base64; undefined when it is not a PNG. */
export function pngSize(base64: string): { width: number; height: number } | undefined {
  const head = atob(base64.slice(0, 32))
  if (head.length < 24 || head.slice(1, 4) !== 'PNG' || head.slice(12, 16) !== 'IHDR') return undefined
  const u32 = (i: number) => ((head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) | (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3)) >>> 0
  return { width: u32(16), height: u32(20) }
}

/** A terminal cell's size in screen pixels. */
export type Cell = { width: number; height: number }

/**
 * The cell size pictures are measured in. Claude Code does not report the
 * terminal's, so it is the `cellSize` setting (`WxH`); `auto` is Ghostty's
 * on a Retina Mac at its default font, 14×28, on macOS, else 8×16. At the
 * true size one picture pixel lands on one screen pixel, as pi draws it.
 */
export function cellSize(setting: string | undefined, macos: boolean): Cell {
  const m = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(setting ?? '')
  const width = Number(m?.[1])
  const height = Number(m?.[2])
  if (width > 0 && height > 0) return { width, height }
  return macos ? { width: 14, height: 28 } : { width: 8, height: 16 }
}

/** Of the window's height, the most a picture takes, as in pi. */
export const MAX_HEIGHT_RATIO = 0.85

/**
 * The picture's box in cells, as pi sizes it: `w=` when asked, else the
 * picture's own pixels at `cell`; never wider than `columns` minus 2, nor
 * taller than 85% of the window's `rows` (the width then shrinks to keep the shape).
 */
export function imageBox(px: { width: number; height: number }, room: { columns: number; rows: number }, cell: Cell, asked?: number): { columns: number; rows: number } {
  const maxWidth = Math.min(255, Math.max(10, room.columns - 2))
  const maxHeight = Math.min(255, Math.max(8, Math.floor(room.rows * MAX_HEIGHT_RATIO)))
  let columns = Math.max(10, Math.min(asked ?? Math.ceil(px.width / cell.width), maxWidth))
  const tall = (c: number) => Math.max(1, Math.round((c * cell.width * px.height) / px.width / cell.height))
  let rows = tall(columns)
  if (rows > maxHeight) {
    rows = maxHeight
    columns = Math.max(1, Math.min(columns, Math.round((rows * cell.height * px.width) / px.height / cell.width)))
  }
  return { columns, rows }
}

/** A `file://` URL for an absolute path. */
export function fileUrl(path: string): string {
  return `file://${encodeURI(path).replace(/[?#]/g, c => encodeURIComponent(c))}`
}
