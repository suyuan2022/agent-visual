// Draws each top-level mermaid block of a reply in place, the way pi does: lovely-mermaid's box art with every span in a
// theme color. A line that is only a local image is drawn as the picture, with a link to the original under it.
import type { Color, FsBytes, Register, RenderNode } from 'claude-code'

import { findDiagrams, fit, markdownSafe, needsWholeMarkdown, plainRewrite, replyLang, t } from '../core/core.ts'
import type { Lang } from '../core/core.ts'
import type { Diagram, Fit } from '../core/core.ts'
import { bmpToHalfBlocks, cellSize, findImages, imageBox, pngSize } from './images.ts'
import type { ImageLine } from './images.ts'
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

/** A picture ready for `Image`: PNG bytes, base64, at most 2 MiB, and its size in pixels. */
type Picture = { png: string; width: number; height: number }

/** What an image line resolves to: its picture, no file there, or a file no `Image` can show. */
type Loaded = { kind: 'picture'; picture: Picture } | { kind: 'missing' } | { kind: 'unshown' }

// `Image` takes a PNG of at most 2 MiB; anything else goes through macOS `sips` first.
const MAX_PNG = 2 * 1024 * 1024
const CONVERTIBLE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i

// One read per file version: a redraw draws from here.
const pictures = new Map<string, Loaded>()
// Half-block cells per file version and box.
const rastered = new Map<string, string>()


function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36)
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

    // The engine draws an `Image` only where the terminal speaks kitty graphics with Unicode placeholders (kitty,
    // Ghostty). Everywhere else (Rex, iTerm2, Terminal) the picture is drawn in half blocks: two pixels a cell.
    const term = images.length === 0 ? '' : `${(await $.env.get('TERM_PROGRAM')) ?? ''} ${(await $.env.get('TERM')) ?? ''}`.toLowerCase()
    const graphics = /ghostty|kitty/.test(term) || (images.length > 0 && (await $.env.get('KITTY_WINDOW_ID')) !== undefined)
    const tmp = images.length === 0 ? '/tmp/' : ((await $.env.get('TMPDIR')) ?? '/tmp/')

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
      let loaded: Loaded = { kind: 'unshown' }
      try {
        if (/\.png$/i.test(path) && stat.size <= MAX_PNG) {
          const { base64 } = (await $.fs.read(path, { as: 'bytes' })) as FsBytes
          const size = pngSize(base64)
          if (size !== undefined) loaded = { kind: 'picture', picture: { png: base64, ...size } }
        }
        if (loaded.kind === 'unshown' && CONVERTIBLE.test(path)) {
          // The picture's own size, then a PNG of it small enough for `Image`.
          const probe = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])
          const width = Number(/pixelWidth: (\d+)/.exec(probe.stdout)?.[1])
          const height = Number(/pixelHeight: (\d+)/.exec(probe.stdout)?.[1])
          const out = `${(await $.env.get('TMPDIR')) ?? '/tmp/'}agent-visual-${hash(key)}.png`.replace(/\/\/+/g, '/')
          // Each try shrinks the longest side until the PNG fits; a file past the cap is never read.
          for (const side of [1600, 1024, 640, 400]) {
            if (!(width > 0 && height > 0)) break
            const made = await $.process.run(['sips', '-s', 'format', 'png', '-Z', String(Math.min(side, Math.max(width, height))), path, '--out', out])
            if (made.exitCode !== 0) break
            if ((await $.fs.stat(out)).size > MAX_PNG) continue
            const { base64 } = (await $.fs.read(out, { as: 'bytes' })) as FsBytes
            loaded = { kind: 'picture', picture: { png: base64, width, height } }
            break
          }
        }
      } catch {
        // Not readable here, or no `sips` (not macOS): the link still opens it.
      }
      if (pictures.size >= 12) pictures.delete(pictures.keys().next().value as string)
      pictures.set(key, loaded)
      return loaded
    }
    const loaded = new Map<ImageLine, Loaded>(await Promise.all(images.map(async img => [img, await load(img.path)] as const)))
    const cell = cellSize(String(options.cellSize ?? ''), home?.startsWith('/Users/') === true)
    const boxes = new Map<ImageLine, { columns: number; rows: number }>()
    for (const [img, got] of loaded) if (got.kind === 'picture') boxes.set(img, imageBox(got.picture, { columns, rows: e.viewport?.rows ?? 40 }, cell, img.width))
    const rasters = new Map<ImageLine, string>()
    if (!graphics) {
      await Promise.all(
        [...boxes].map(async ([img, box]) => {
          const cells = await halfBlocks(img.path, box, tmp)
          if (cells !== undefined) rasters.set(img, cells)
        }),
      )
    }

    // The picture as half blocks: macOS `sips` scales it to one pixel per column and two per row, as a BMP read here.
    async function halfBlocks(path: string, box: { columns: number; rows: number }, dir: string): Promise<string | undefined> {
      try {
        const stat = await $.fs.stat(path)
        const key = `${path}\n${stat.mtimeMs}\n${box.columns}x${box.rows}`
        const hit = rastered.get(key)
        if (hit !== undefined) return hit
        const out = `${dir}agent-visual-${hash(key)}.bmp`.replace(/\/\/+/g, '/')
        const made = await $.process.run(['sips', '-s', 'format', 'bmp', '-z', String(box.rows * 2), String(box.columns), path, '--out', out])
        if (made.exitCode !== 0) return undefined
        const { base64 } = (await $.fs.read(out, { as: 'bytes' })) as FsBytes
        const cells = bmpToHalfBlocks((Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(base64), box.columns, box.rows)
        if (cells === undefined) return undefined
        if (rastered.size >= 12) rastered.delete(rastered.keys().next().value as string)
        rastered.set(key, cells)
        return cells
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
        else if (got.kind === 'unshown' || (!graphics && !rasters.has(img))) children.push(link)
        else {
          const box = boxes.get(img)!
          children.push(
            <Box flexDirection="column" paddingLeft={img.center ? Math.max(0, Math.floor((columns - box.columns) / 2)) : 0}>
              {graphics ? (
                <Image source={{ png: got.picture.png }} columns={box.columns} rows={box.rows} alt={img.alt || ' '} />
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
