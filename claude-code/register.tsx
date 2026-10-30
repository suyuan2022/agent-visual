// Draws each top-level mermaid block of a reply in place, the way pi does: lovely-mermaid's box art with every span in a
// theme color. A line that is only a local image is drawn as the picture, with a link to the original under it.
import type { Color, FsBytes, Register, RenderNode } from 'claude-code'

import { findDiagrams, fit, markdownSafe, needsWholeMarkdown, plainRewrite } from '../core/core.ts'
import type { Diagram, Fit } from '../core/core.ts'
import { cellSize, fileUrl, findImages, imageBox, pngSize } from './images.ts'
import type { ImageLine } from './images.ts'
import { registerRules } from './rules.ts'
import type { Role } from '../core/vendor/lovely-mermaid/index.js'

// The `edgeColor` choices in plugin.json, as theme keys so every theme carries them.
const EDGE: Record<string, Color> = { teal: 'planMode', gray: 'inactive', blue: 'suggestion', orange: 'claude' }

// The bullet column the engine draws before a reply, and the transcript's own margin.
const GUTTER = 4

// Redraws are frequent (every resize, every streamed chunk): one layout per source and width.
const fits = new Map<string, Fit>()

function cachedFit(source: string, columns: number, experimental: boolean): Fit {
  const key = `${columns}\n${experimental}\n${source}`
  let f = fits.get(key)
  if (f === undefined) {
    f = fit(source, columns, { experimental })
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
    const drawn = new Map<Diagram, Fit>(diagrams.map(d => [d, cachedFit(d.source, columns, experimental)]))

    if (needsWholeMarkdown(text) || !markdownSafe(text)) {
      const rewritten = plainRewrite(text, diagrams, drawn)
      return rewritten === text ? next(e) : next({ ...e, props: { ...e.props, text: rewritten } })
    }

    // The engine draws an `Image` where the terminal speaks the kitty graphics protocol; elsewhere only the link.
    // Rex speaks it too (pi draws pictures there).
    const term = images.length === 0 ? '' : `${(await $.env.get('TERM_PROGRAM')) ?? ''} ${(await $.env.get('TERM')) ?? ''}`.toLowerCase()
    const graphics = /ghostty|kitty|rex/.test(term) || (images.length > 0 && (await $.env.get('KITTY_WINDOW_ID')) !== undefined)

    async function load(path: string): Promise<Loaded> {
      let stat
      try {
        stat = await $.fs.stat(path)
      } catch {
        return { kind: 'missing' }
      }
      if (stat.kind !== 'file') return { kind: 'missing' }
      // Where no picture can be drawn, knowing the file is there is enough for its link.
      if (!graphics) return { kind: 'unshown' }
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

    const { Box, Image, Link, Markdown, Text } = $.ui.resolve(e)
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
        const link = (
          <Text dimColor>
            <Link href={fileUrl(img.path)}>{`Open image${img.alt ? `: ${img.alt}` : ''}`}</Link>
          </Text>
        )
        if (got.kind === 'missing') children.push(<Text color="warning">{`Image not found: ${img.path}`}</Text>)
        else if (got.kind === 'unshown' || !graphics) children.push(link)
        else {
          const cell = cellSize(String(options.cellSize ?? ''), home?.startsWith('/Users/') === true)
          const box = imageBox(got.picture, { columns, rows: e.viewport?.rows ?? 40 }, cell, img.width)
          children.push(
            <Box flexDirection="column" paddingLeft={img.center ? Math.max(0, Math.floor((columns - box.columns) / 2)) : 0}>
              <Image source={{ png: got.picture.png }} columns={box.columns} rows={box.rows} alt={img.alt || ' '} />
              {link}
            </Box>,
          )
        }
        continue
      }
      // A drawing and a framed source paint alike; a framed source may carry a note on why it was not drawn.
      const f = drawn.get(item.diagram)!
      children.push(
        <Box flexDirection="column">
          {f.art.styled.map(row => (
            <Text wrap="truncate">
              {row.map(span => (
                <Text color={paint[span.role]} bold={span.role === 'title'}>
                  {span.text}
                </Text>
              ))}
            </Text>
          ))}
          {f.kind === 'box' && f.note !== undefined ? <Text dimColor>{f.note}</Text> : null}
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
