// Draws each top-level mermaid block of a reply in place, the way pi does: lovely-mermaid's box art with every span in a
// theme color. A line that is only a local image is drawn as the picture, with a link to the original under it.
import type { Color, FsBytes, Register, RenderNode } from 'claude-code'

import { findDiagrams, fit, markdownSafe, needsWholeMarkdown, plainRewrite, replyLang, t } from '../core/core.ts'
import type { Lang } from '../core/core.ts'
import type { Diagram, Fit } from '../core/core.ts'
import { bmpToHalfBlocks, cellSize, findImages, imageBox, pngSize, rexCell } from './images.ts'
import type { Cell, ImageLine } from './images.ts'
import { registerRules } from './rules.ts'
import type { Role } from '../core/vendor/lovely-mermaid/index.js'

// The `edgeColor` choices in plugin.json, as theme keys so every theme carries them.
const EDGE: Record<string, Color> = { teal: 'planMode', gray: 'inactive', blue: 'suggestion', orange: 'claude' }

// The bullet column the engine draws before a reply, and the transcript's own margin.
const GUTTER = 4

// Redraws are frequent (every resize, every streamed chunk): one layout per source and width.
const fits = new Map<string, Fit>()

function cachedFit(source: string, columns: number, experimental: boolean, lang: Lang): Fit {
  const key = `${columns}\n${experimental}\n${lang}\n${source}`
  let f = fits.get(key)
  if (f === undefined) {
    f = fit(source, columns, { experimental, lang })
    if (fits.size >= 200) fits.delete(fits.keys().next().value as string)
    fits.set(key, f)
  }
  return f
}

/** A picture's own size in pixels. */
type Picture = { width: number; height: number }

/** What an image line resolves to: its picture, no file there, or a file no `Image` can show. */
type Loaded = { kind: 'picture'; picture: Picture } | { kind: 'missing' } | { kind: 'unshown' }

/**
 * What an `Image` is drawn from: a PNG file the terminal opens and reads itself, or, where the terminal is on another
 * machine (ssh) and cannot, the PNG's bytes. The engine refuses a drawing whose Images hold more than 2 MiB of bytes
 * together and draws its own text in its place, which a reply with five screenshots passes; a file counts nothing, and
 * no pixel crosses the hook on a redraw.
 */
type Source = { file: string; format: 'png' } | { png: string }
const MAX_TREE_BYTES = 2 * 1024 * 1024
const CONVERTIBLE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i
// A picture past this many pixels on a side is handed to the terminal as a smaller copy.
const MAX_SIDE = 2560

// One size per file version: a redraw reads nothing.
const pictures = new Map<string, Loaded>()
// Half-block cells per file version and box.
const rastered = new Map<string, string>()
// PNG files made here (Rex's exact boxes, converted or smaller copies), per file version and size.
const made = new Map<string, string>()
// PNG bytes for a terminal across ssh, per file and share of the drawing's bytes.
const bytes = new Map<string, string>()
// Rex's cell pixels for a pane as Rex last gave them, asked again after a few seconds: a font, line height or display
// change moves them.
let rexCells: { block: string; at: number; cell: Cell } | undefined
// Work in flight per key (a picture read, a sips run), shared by the drawings that want it at once.
const inFlight = new Map<string, Promise<unknown>>()

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36)
}

function remember<V>(cache: Map<string, V>, key: string, value: V): V {
  if (cache.size >= 24) cache.delete(cache.keys().next().value as string)
  cache.set(key, value)
  return value
}

/**
 * `make()`'s result, shared with every drawing that asks for `key` while it runs. Scrolling redraws a reply many times
 * a second and a newer drawing ends the calls of the one it replaces, so a run that ends without a result is made
 * again by the drawing still waiting for it.
 */
async function once<T>(key: string, make: () => Promise<T | undefined>): Promise<T | undefined> {
  let running = inFlight.get(key) as Promise<T | undefined> | undefined
  while (running !== undefined) {
    const shared = await running.catch(() => undefined)
    if (shared !== undefined) return shared
    const next = inFlight.get(key) as Promise<T | undefined> | undefined
    running = next === running ? undefined : next
  }
  const own = make()
  inFlight.set(key, own)
  try {
    return await own
  } finally {
    if (inFlight.get(key) === own) inFlight.delete(key)
  }
}

export const register: Register = (on, options) => {
  // lovely-mermaid tags each span with a role; pi paints them borderMuted, text, accent, muted.
  const paint: Record<Role, Color | undefined> = {
    border: 'subtle',
    text: 'text',
    edge: EDGE[String(options.edgeColor)] ?? EDGE.teal,
    edgeLabel: 'inactive',
    title: 'text',
    none: undefined,
  }
  const experimental = options.experimentalTypes === true
  registerRules(on)

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const text = e.props.text
    // An unclosed fence is still streaming: the engine draws its source until it closes.
    const diagrams = findDiagrams(text).filter(d => d.closed)
    const pictured = text.includes('![')
    const home = pictured ? await $.env.get('HOME') : undefined
    const images = pictured ? findImages(text, home) : []
    if (diagrams.length === 0 && images.length === 0) return next(e)

    const columns = (e.viewport?.columns ?? 80) - GUTTER
    const lang = replyLang(text)
    const drawn = new Map<Diagram, Fit>(diagrams.map(d => [d, cachedFit(d.source, columns, experimental, lang)]))

    if (needsWholeMarkdown(text) || !markdownSafe(text)) {
      const rewritten = plainRewrite(text, diagrams, drawn)
      return rewritten === text ? next(e) : next({ ...e, props: { ...e.props, text: rewritten } })
    }

    // The engine draws an `Image` only where the terminal speaks kitty graphics with Unicode placeholders: kitty
    // and Ghostty, or any terminal under CLAUDE_CODE_FORCE_TERMINAL_IMAGES. Rex speaks them but draws a picture's
    // pixels one to one instead of scaling them to the box, so there each picture is made at the box's exact
    // pixels, in the cell size Rex reports for this pane. Everywhere else (iTerm2, Terminal, Rex without the
    // variable) the picture is drawn in half blocks: two pixels a cell.
    const term = images.length === 0 ? '' : `${(await $.env.get('TERM_PROGRAM')) ?? ''} ${(await $.env.get('TERM')) ?? ''}`.toLowerCase()
    const rex = images.length > 0 && term.startsWith('rex ') && Boolean(await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) ? await rexCellSize() : undefined
    const graphics = /ghostty|kitty/.test(term) || rex !== undefined || (images.length > 0 && (await $.env.get('KITTY_WINDOW_ID')) !== undefined)
    const tmp = images.length === 0 ? '/tmp/' : ((await $.env.get('TMPDIR')) ?? '/tmp/')
    // Across ssh the terminal cannot open a file of this machine.
    const remote = graphics && images.length > 0 && Boolean((await $.env.get('SSH_CONNECTION')) || (await $.env.get('SSH_TTY')))

    async function rexCellSize(): Promise<Cell | undefined> {
      const block = await $.env.get('REX_BLOCK')
      if (!block) return undefined
      const known = rexCells?.block === block ? rexCells : undefined
      const now = await $.clock.now()
      if (known !== undefined && now - known.at < 5000) return known.cell
      const dir = await $.env.get('REX_BIN_DIR')
      const session = await $.env.get('REX_SESSION')
      let cell: Cell | undefined
      try {
        const got = await $.process.run([dir ? `${dir}/rex` : 'rex', 'block', 'call', ...(session ? ['-s', session] : []), '-b', block, 'size'])
        cell = got.exitCode === 0 ? rexCell(got.stdout) : undefined
      } catch {
        cell = undefined
      }
      // Only Rex's answer is kept. A query cut short (a newer drawing ended this one's calls) or refused says nothing
      // about the pane: the size Rex gave last stands, and the next drawing asks again.
      if (cell === undefined) return known?.cell
      rexCells = { block, at: now, cell }
      return cell
    }

    async function load(path: string): Promise<Loaded> {
      let stat
      try {
        stat = await $.fs.stat(path)
      } catch {
        return { kind: 'missing' }
      }
      if (stat.kind !== 'file') return { kind: 'missing' }
      const key = `${path}\n${stat.mtimeMs}\n${stat.size}`
      const hit = pictures.get(key)
      if (hit !== undefined) return hit
      const loaded = await once(`load\n${key}`, () => measure(path))
      // A read that failed or was cut short is not kept: the next drawing reads again.
      if (loaded === undefined) return { kind: 'unshown' }
      return remember(pictures, key, loaded)
    }

    // The picture's own size: a PNG's header, else what `sips` reads; `unshown` when it is no picture, undefined when
    // reading it failed.
    async function measure(path: string): Promise<Loaded | undefined> {
      try {
        if (/\.png$/i.test(path)) {
          const size = pngSize(((await $.fs.read(path, { as: 'bytes' })) as FsBytes).base64)
          if (size !== undefined) return { kind: 'picture', picture: size }
        }
        if (!CONVERTIBLE.test(path)) return { kind: 'unshown' }
        const probe = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])
        const width = Number(/pixelWidth: (\d+)/.exec(probe.stdout)?.[1])
        const height = Number(/pixelHeight: (\d+)/.exec(probe.stdout)?.[1])
        return width > 0 && height > 0 ? { kind: 'picture', picture: { width, height } } : { kind: 'unshown' }
      } catch {
        // Not readable here, no `sips` (not macOS), or cut short by a newer drawing: the link still opens it.
        return undefined
      }
    }

    const loaded = new Map<ImageLine, Loaded>(await Promise.all(images.map(async img => [img, await load(img.path)] as const)))
    const cell = rex ?? cellSize(String(options.cellSize ?? ''), home?.startsWith('/Users/') === true)
    const boxes = new Map<ImageLine, { columns: number; rows: number }>()
    const own = new Map<ImageLine, Picture>()
    for (const [img, got] of loaded) {
      if (got.kind !== 'picture') continue
      own.set(img, got.picture)
      boxes.set(img, imageBox(got.picture, { columns, rows: e.viewport?.rows ?? 40 }, cell, img.width, rex !== undefined))
    }
    // The PNG file each picture is drawn from: in Rex one made at the box's pixels; elsewhere the picture itself when
    // it is a PNG of a sensible size, else a PNG copy of it.
    const files = new Map<ImageLine, string>()
    if (graphics) {
      await Promise.all(
        [...boxes].map(async ([img, box]) => {
          const px = own.get(img)!
          const file =
            rex !== undefined
              ? await once(`png\n${img.path}\n${box.columns * rex.width}x${box.rows * rex.height}`, () => pngAt(img.path, box.columns * rex.width, box.rows * rex.height, tmp))
              : /\.png$/i.test(img.path) && Math.max(px.width, px.height) <= MAX_SIDE
                ? img.path
                : await once(`copy\n${img.path}`, () => pngCopy(img.path, Math.min(MAX_SIDE, Math.max(px.width, px.height)), tmp))
          if (file !== undefined) files.set(img, file)
        }),
      )
    }
    const sources = new Map<ImageLine, Source>()
    if (!remote) for (const [img, file] of files) sources.set(img, { file, format: 'png' })
    else {
      // The pictures share the drawing's 2 MiB of bytes, each shrunk until it fits its share; the terminal scales it
      // back to the box.
      const share = Math.floor((MAX_TREE_BYTES * 0.9) / Math.max(1, files.size))
      await Promise.all(
        [...files].map(async ([img, file]) => {
          const png = await once(`bytes\n${file}\n${share}`, () => pngBytes(file, share, tmp))
          if (png !== undefined) sources.set(img, { png })
        }),
      )
    }
    const rasters = new Map<ImageLine, string>()
    await Promise.all(
      [...boxes].map(async ([img, box]) => {
        if (sources.has(img)) return
        const cells = await once(`bmp\n${img.path}\n${box.columns}x${box.rows}`, () => halfBlocks(img.path, box, tmp))
        if (cells !== undefined) rasters.set(img, cells)
      }),
    )

    // A PNG made by `sips` from `path` under `dir`, once per file version and `args`; undefined without `sips`, or when
    // the file went away. A made file the system's cleaner took is made again.
    async function sipsPng(path: string, args: string[], dir: string): Promise<string | undefined> {
      try {
        const stat = await $.fs.stat(path)
        const key = `${path}\n${stat.mtimeMs}\n${args.join(' ')}`
        const out = `${dir}agent-visual-${hash(key)}.png`.replace(/\/\/+/g, '/')
        if (made.get(key) === out && (await $.fs.stat(out).then(s => s.kind === 'file', () => false))) return out
        const run = await $.process.run(['sips', '-s', 'format', 'png', ...args, path, '--out', out])
        return run.exitCode === 0 ? remember(made, key, out) : undefined
      } catch {
        return undefined
      }
    }

    // The picture at exactly `width` x `height` pixels, for Rex.
    function pngAt(path: string, width: number, height: number, dir: string): Promise<string | undefined> {
      return sipsPng(path, ['-z', String(height), String(width)], dir)
    }

    // A PNG of the picture, its longest side at most `side` pixels.
    function pngCopy(path: string, side: number, dir: string): Promise<string | undefined> {
      return sipsPng(path, ['-Z', String(side)], dir)
    }

    // The PNG's bytes, shrunk until they fit `share`.
    async function pngBytes(file: string, share: number, dir: string): Promise<string | undefined> {
      try {
        let from = file
        for (const side of [0, 1600, 1024, 640, 400, 256]) {
          if (side > 0) from = (await sipsPng(file, ['-Z', String(side)], dir)) ?? ''
          if (from === '') return undefined
          const stat = await $.fs.stat(from)
          if (stat.size > share) continue
          const key = `${from}\n${stat.mtimeMs}\n${stat.size}`
          return bytes.get(key) ?? remember(bytes, key, ((await $.fs.read(from, { as: 'bytes' })) as FsBytes).base64)
        }
      } catch {
        // Cut short by a newer drawing: the next one reads again.
      }
      return undefined
    }

    // The picture as half blocks: macOS `sips` scales it to one pixel per column and two per row, as a BMP read here.
    async function halfBlocks(path: string, box: { columns: number; rows: number }, dir: string): Promise<string | undefined> {
      try {
        const stat = await $.fs.stat(path)
        const key = `${path}\n${stat.mtimeMs}\n${box.columns}x${box.rows}`
        const hit = rastered.get(key)
        if (hit !== undefined) return hit
        const out = `${dir}agent-visual-${hash(key)}.bmp`.replace(/\/\/+/g, '/')
        const run = await $.process.run(['sips', '-s', 'format', 'bmp', '-z', String(box.rows * 2), String(box.columns), path, '--out', out])
        if (run.exitCode !== 0) return undefined
        const { base64 } = (await $.fs.read(out, { as: 'bytes' })) as FsBytes
        const cells = bmpToHalfBlocks((Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(base64), box.columns, box.rows)
        return cells === undefined ? undefined : remember(rastered, key, cells)
      } catch {
        return undefined
      }
    }

    const { Box, Button, Image, Markdown, Raster, Text } = $.ui.resolve(e)
    const opener = home?.startsWith('/Users/') === true ? 'open' : 'xdg-open'
    const children: RenderNode[] = []
    const prose = (part: string) => {
      const trimmed = part.replace(/^\n+|\s+$/g, '')
      if (trimmed !== '') children.push(<Markdown text={trimmed} />)
    }
    const items = [...diagrams.map(diagram => ({ start: diagram.start, end: diagram.end, diagram })), ...images.map(image => ({ start: image.start, end: image.end, image }))].sort((a, b) => a.start - b.start)
    let at = 0
    for (const item of items) {
      if (item.start < at) continue
      prose(text.slice(at, item.start))
      at = item.end
      if ('image' in item) {
        const img = item.image
        const got = loaded.get(img)!
        // A picture takes no press, so its name under it does: one click opens the file in the system viewer.
        // A Button, not a Link: the engine draws a Link's URL beside it where it doubts the terminal's links (Rex).
        const name = img.alt || (img.path.split('/').pop() ?? img.path)
        const link = (
          <Button key={`open:${item.start}`} plain dimColor label={name} onPress={() => void $.process.run([opener, img.path])} />
        )
        if (got.kind === 'missing') children.push(<Text color="warning">{`${t('Image not found', lang)}${lang === 'zh' ? '：' : ': '}${img.path}`}</Text>)
        else if (got.kind === 'unshown' || (!sources.has(img) && !rasters.has(img))) children.push(link)
        else {
          const box = boxes.get(img)!
          const source = sources.get(img)
          children.push(
            <Box flexDirection="column" paddingLeft={img.center ? Math.max(0, Math.floor((columns - box.columns) / 2)) : 0}>
              {source !== undefined ? (
                <Image source={source} columns={box.columns} rows={box.rows} alt={img.alt || ' '} />
              ) : (
                <Raster key={`img-${item.start}`} columns={box.columns} rows={box.rows} cells={rasters.get(img)!} />
              )}
              {link}
            </Box>,
          )
        }
        continue
      }
      // A drawing and a framed source paint alike; a framed source carries its note above, where a tall frame cannot hide it.
      const f = drawn.get(item.diagram)!
      children.push(
        <Box flexDirection="column">
          {f.kind === 'box' && f.note !== undefined ? <Text color="warning">{f.note}</Text> : null}
          {f.art.styled.map(row => (
            <Text wrap="truncate">
              {row.map(span => (
                <Text color={paint[span.role]} bold={span.role === 'title'}>
                  {span.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>,
      )
    }
    prose(text.slice(at))
    // A tree replaces the engine's drawing whole: its blank line above, bullet and indent too.
    return (
      <Box flexDirection="row" marginTop={1}>
        <Box width={2} flexShrink={0}>
          <Text color="text">{e.props.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          {children}
        </Box>
      </Box>
    )
  })
}
