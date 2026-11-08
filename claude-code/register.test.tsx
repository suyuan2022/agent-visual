import { expect, mock, test } from 'claude-code/testing'

import { bmpToHalfBlocks } from './images.ts'

const FLOW = 'flowchart TD\n  A[开始] --> B{要不要画}\n  B -->|要| C[画成框图]'
const REPLY = `先看流程：\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n就这样。`
const viewport = { columns: 100, rows: 40 }

// Each art row is a Text of spans, one per lovely-mermaid role: their text and color.
async function paint(ui: { find: (q: { type: string; text: RegExp }) => Promise<{ children: unknown[] } | undefined> }, row: RegExp) {
  const spans = (await ui.find({ type: 'Text', text: row }))?.children as { props: { color?: string }; children: string[] }[]
  return Object.fromEntries(spans.map(s => [s.children.join(''), s.props.color]))
}

// Stands for the engine's own drawing of a reply.
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`engine: ${e.props.text}`}</Text>
  })
}

test('a closed block is drawn in place between its prose, in theme colors', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: REPLY, isFirstOfReply: true }, viewport })
  expect(await ui.find({ type: 'Markdown', text: '先看流程：' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: '就这样。' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /```mermaid/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /画成框图/ })).toBeDefined()
  expect(await paint(ui, /│ 画成框图 │/)).toMatchObject({ '│': 'subtle', 画成框图: 'text' })
  expect(await paint(ui, /▼要/)).toMatchObject({ '▼': 'planMode', 要: 'inactive' })
  expect(await ui.find({ type: 'Text', text: /^engine:/ })).toBeUndefined()
  await ui.unmount()
})

test('the edgeColor option picks the theme key lines are drawn in', { options: { edgeColor: 'blue' } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: REPLY, isFirstOfReply: true }, viewport })
  expect(await paint(ui, /▼要/)).toMatchObject({ '▼': 'suggestion' })
  await ui.unmount()
})

test('a streaming block, other surfaces and replies without mermaid go to the engine untouched', async ($, on) => {
  engine(on)
  const cases = [
    { surface: 'terminal' as const, text: '```mermaid\nflowchart TD\n  A --> ' },
    { surface: 'desktop' as const, text: REPLY },
    { surface: 'terminal' as const, text: '没有图。' },
  ]
  for (const c of cases) {
    const ui = await $.ui.mount({ plugin: 'agent-visual', surface: c.surface, component: 'AssistantMessage', props: { text: c.text, isFirstOfReply: true }, viewport })
    expect(await ui.find({ type: 'Text', text: `engine: ${c.text}` })).toBeDefined()
    await ui.unmount()
  }
})

test('a reply with footnotes stays one Markdown, the block swapped for plain art', async ($, on) => {
  engine(on)
  const text = `看图[^1]：\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n\n[^1]: 脚注`
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true }, viewport })
  const drawn = await ui.find({ type: 'Text', text: /^engine:/ })
  expect(drawn?.text).toContain('```text')
  expect(drawn?.text).toContain('画成框图')
  expect(drawn?.text).not.toContain('```mermaid')
  await ui.unmount()
})

test('too narrow frames the source and says why, in the reply language', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: REPLY, isFirstOfReply: true }, viewport: { columns: 14, rows: 40 } })
  expect(await ui.find({ type: 'Markdown', text: /```mermaid/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /mermaid: flowchart/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /当前宽度无法显示图表/ })).toBeDefined()
  await ui.unmount()
  const en = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: REPLY.replace('先看流程：', 'The flow:').replace('就这样。', 'Done.'), isFirstOfReply: true }, viewport: { columns: 14, rows: 40 } })
  expect(await en.find({ type: 'Text', text: /can't be displayed at this width/ })).toBeDefined()
  await en.unmount()
})

const JOURNEY = '```mermaid\njourney\n  title 一天\n  section 早\n    起床: 3: 我\n```'

test('an uncommon type is framed source in theme colors, with no note', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: JOURNEY, isFirstOfReply: true }, viewport })
  expect(await ui.find({ type: 'Text', text: /^engine:/ })).toBeUndefined()
  expect(await paint(ui, /起床: 3: 我/)).toMatchObject({ '│ ': 'subtle', '    起床: 3: 我': 'text' })
  expect(await ui.find({ type: 'Text', text: /Diagram not drawn|the terminal has/ })).toBeUndefined()
  await ui.unmount()
})

test('the experimentalTypes option draws the uncommon types', { options: { experimentalTypes: true } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: JOURNEY, isFirstOfReply: true }, viewport })
  expect(await ui.find({ type: 'Text', text: /██████░░░░ 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /mermaid: journey/ })).toBeUndefined()
  await ui.unmount()
})

const PIC = '/pictures/pic.png'
const ghostty = { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty', HOME: '/Users/nobody' }
// tests/fixtures/pic.png's signature and header: a 320×160 PNG.
const PNG_HEAD = 'iVBORw0KGgoAAAANSUhEUgAAAUAAAACgCAIAAADywSLL'
// The same picture as sips makes it for Rex: a 286×144 PNG's signature and header.
const EXACT_HEAD = 'iVBORw0KGgoAAAANSUhEUgAAAR4AAACQCAIAAABRZpOd'

// Stands for the files the hooks read: the picture, and rules.md under the plugin's root.
function files(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('fs.stat', async (_$, e) => (e.path === PIC ? { value: { kind: 'file' as const, size: 550, mtimeMs: 1, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  on('fs.read', async (_$, e) => {
    if (e.path === PIC) return { value: { base64: PNG_HEAD } }
    if (e.path.endsWith('/rules.md')) return { value: '画图和贴图的规矩：用 Mermaid。\n' }
    return { deny: `ENOENT: ${e.path}` }
  })
}

test('a line that is only a local image is drawn as the picture, sized like pi, its name under it opening the file', async ($, on) => {
  engine(on)
  files(on)
  const opened: string[][] = []
  on('process.run', async (_$, e) => {
    opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  mock.env(on, ghostty)
  const text = `截图如下：\n\n![首页](${PIC})\n\n![小图](${PIC} "w=20 center")\n\n完。`
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true }, viewport })
  const pics = await ui.findAll({ type: 'Image' })
  // On macOS, 320×160 px at 14×28 px a cell is 23×6 cells; `w=20` keeps the shape at 20×5.
  expect(pics.map(p => [p.props.columns, p.props.rows])).toEqual([[23, 6], [20, 5]])
  // Ghostty reads the file itself and scales it to the box.
  expect(pics.map(p => p.props.source)).toEqual([{ file: PIC, format: 'png' }, { file: PIC, format: 'png' }])
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.press({ key: `open:${text.indexOf('![首页]')}` })
  expect(opened).toEqual([['open', PIC]])
  expect(await ui.find({ type: 'Markdown', text: '截图如下：' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /!\[/ })).toBeUndefined()
  await ui.unmount()
})

test('a missing image says so; where no picture can be drawn, the name alone', async ($, on) => {
  engine(on)
  files(on)
  mock.env(on, { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color', HOME: '/Users/nobody' })
  const text = `![没有](/no/such/file.png)\n\n![有](${PIC})`
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true }, viewport })
  expect(await ui.find({ type: 'Text', text: '找不到图片：/no/such/file.png' })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: '有' })).toBeDefined()
  await ui.unmount()
})

test('an image line inside a code fence stays text', async ($, on) => {
  engine(on)
  mock.env(on, ghostty)
  const text = `\`\`\`md\n![图](${PIC})\n\`\`\``
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true }, viewport })
  expect(await ui.find({ type: 'Text', text: `engine: ${text}` })).toBeDefined()
  await ui.unmount()
})

test('the rules ride with the first message, then beside every fifth typed message', async ($, on) => {
  files(on)
  on('prompt.context', async (_$, e) => ({ blocks: e.blocks }))
  const sent: number[] = []
  on('prompt.submit', async (_$, e) => {
    sent.push(e.context?.length ?? 0)
    return { text: e.text, context: e.context }
  })
  const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: '2026-10-30' }] })
  expect(blocks.map(b => b.name)).toEqual(['currentDate', 'agentVisualRules'])
  expect(blocks[1]?.text).toBe('画图和贴图的规矩：用 Mermaid。')
  for (let i = 1; i <= 11; i++) await $.prompt.submit({ text: `第 ${i} 条`, wait: false, origin: { kind: 'composer' } })
  expect(sent).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
})

test('the cellSize option sets the pixels a cell holds', { options: { cellSize: '8x16' } }, async ($, on) => {
  engine(on)
  files(on)
  mock.env(on, ghostty)
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: `![图](${PIC})`, isFirstOfReply: true }, viewport })
  expect((await ui.findAll({ type: 'Image' })).map(p => [p.props.columns, p.props.rows])).toEqual([[40, 10]])
  await ui.unmount()
})

// Stands for a Rex pane: the pictures under /pictures/, the PNGs sips makes under TMPDIR, and `rex` reporting 22×48 px
// cells. `answer` may answer a command first: late, refused (as a call cut short is), or not at all to fall through.
const REX = { TERM_PROGRAM: 'rex', TERM: 'xterm-256color', HOME: '/Users/nobody', TMPDIR: '/tmp/t/', REX_BLOCK: 'block:b', REX_SESSION: 'session:s', REX_BIN_DIR: '/opt/rex' }
type Answer = { deny: string } | undefined
function rexPane(on: Parameters<Parameters<typeof test>[1]>[1], runs: string[][], answer?: (argv: string[]) => Promise<Answer>) {
  on('fs.stat', async (_$, e) => (e.path.startsWith('/pictures/') || e.path.startsWith('/tmp/t/agent-visual-') ? { value: { kind: 'file' as const, size: 550, mtimeMs: 1, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  on('fs.read', async (_$, e) => {
    if (e.path.startsWith('/pictures/')) return { value: { base64: PNG_HEAD } }
    if (e.path.startsWith('/tmp/t/agent-visual-') && e.path.endsWith('.png')) return { value: { base64: EXACT_HEAD } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    const answered = await answer?.([...e.argv])
    if (answered !== undefined) return answered
    const stdout = e.argv[0] === '/opt/rex/rex' ? '{"columns":53,"rows":37,"cell_width_px":22,"cell_height_px":48}' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}
const rexMount = ($: Parameters<Parameters<typeof test>[1]>[0], path: string) =>
  $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: `![图](${path})`, isFirstOfReply: true }, viewport })
const sizes = async (ui: Awaited<ReturnType<typeof rexMount>>) => (await ui.findAll({ type: 'Image' })).map(p => [p.props.columns, p.props.rows])
const isSize = (argv: string[]) => argv[0] === '/opt/rex/rex'

test('in Rex under CLAUDE_CODE_FORCE_TERMINAL_IMAGES a picture is made at the box pixels Rex reports', async ($, on) => {
  engine(on)
  mock.clock(on)
  const runs: string[][] = []
  rexPane(on, runs)
  mock.env(on, { ...REX, CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: `![图](${PIC})`, isFirstOfReply: true }, viewport })
  // 320×160 px at Rex's 22×48 is 13×3 cells, made at 286×144 px into a file Rex reads.
  const pics = await ui.findAll({ type: 'Image' })
  expect(pics.map(p => [p.props.columns, p.props.rows])).toEqual([[13, 3]])
  const source = pics[0]!.props.source as { file: string; format: string }
  expect(source.format).toBe('png')
  expect(source.file).toMatch(/^\/tmp\/t\/agent-visual-\w+\.png$/)
  expect(runs.find(r => r[0] === 'sips')?.at(-1)).toBe(source.file)
  expect(runs[0]).toEqual(['/opt/rex/rex', 'block', 'call', '-s', 'session:s', '-b', 'block:b', 'size'])
  expect(runs.find(r => r[0] === 'sips')?.slice(0, 7)).toEqual(['sips', '-s', 'format', 'png', '-z', '144', '286'])
  await ui.unmount()
})

// Five screenshots of 600 KB each: as bytes the reply's Images would hold 3 MB, past the engine's 2 MiB a drawing, and
// the engine would refuse the whole tree and draw the reply as text.
const BIG = PNG_HEAD + 'A'.repeat(800_000)
const FIVE = [1, 2, 3, 4, 5].map(k => `![第 ${k} 张](/pictures/big-${k}.png)`).join('\n\n')

test('in Rex a reply of five large pictures draws all five, each from a file, none as bytes', async ($, on) => {
  engine(on)
  mock.clock(on)
  on('fs.stat', async (_$, e) => (e.path.startsWith('/pictures/big-') || e.path.startsWith('/tmp/t/agent-visual-') ? { value: { kind: 'file' as const, size: 600_000, mtimeMs: 1, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  // The picture and the PNG sips makes of it at Rex's box pixels are both large.
  on('fs.read', async (_$, e) => (e.path.startsWith('/pictures/big-') || e.path.startsWith('/tmp/t/agent-visual-') ? { value: { base64: BIG } } : { deny: `ENOENT: ${e.path}` }))
  on('process.run', async (_$, e) => {
    const stdout = e.argv[0] === '/opt/rex/rex' ? '{"columns":53,"rows":37,"cell_width_px":22,"cell_height_px":48}' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  mock.env(on, { ...REX, REX_BLOCK: 'block:five', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: FIVE, isFirstOfReply: true }, viewport })
  const pics = await ui.findAll({ type: 'Image' })
  expect(pics).toHaveLength(5)
  expect(pics.every(p => 'file' in (p.props.source as object))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /engine:/ })).toBeUndefined()
  await ui.unmount()
})

test('across ssh the pictures go as bytes, shrunk to share the 2 MiB a drawing holds', async ($, on) => {
  engine(on)
  const runs: string[][] = []
  on('fs.stat', async (_$, e) => {
    if (e.path.startsWith('/pictures/big-')) return { value: { kind: 'file' as const, size: 900_000, mtimeMs: 1, isLink: false } }
    if (e.path.startsWith('/tmp/t/agent-visual-')) return { value: { kind: 'file' as const, size: 300_000, mtimeMs: 2, isLink: false } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', async (_$, e) => {
    if (e.path.startsWith('/pictures/big-')) return { value: { base64: BIG } }
    if (e.path.startsWith('/tmp/t/agent-visual-')) return { value: { base64: EXACT_HEAD } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('process.run', async (_$, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  mock.env(on, { ...ghostty, TMPDIR: '/tmp/t/', SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' })
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: FIVE, isFirstOfReply: true }, viewport })
  const pics = await ui.findAll({ type: 'Image' })
  // 900 KB each is past a fifth of 90% of 2 MiB (377 KB), so each goes as a copy sips shrank to 1600 px.
  expect(pics.map(p => p.props.source)).toEqual(Array(5).fill({ png: EXACT_HEAD }))
  expect(runs.filter(r => r[0] === 'sips' && r.includes('-Z') && r.includes('1600'))).toHaveLength(5)
  await ui.unmount()
})

test('in Rex without CLAUDE_CODE_FORCE_TERMINAL_IMAGES no Image is drawn and Rex is not asked', async ($, on) => {
  engine(on)
  const runs: string[][] = []
  rexPane(on, runs)
  mock.env(on, REX)
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: `![图](${PIC})`, isFirstOfReply: true }, viewport })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(runs.some(r => r[0] === '/opt/rex/rex')).toBe(false)
  await ui.unmount()
})

// Scrolling redraws a reply many times a second, and a newer drawing ends the calls of the one it replaces. Nothing a
// call cut short says is kept: a kept failure drew every picture in half blocks (or as its name alone) until the reply
// was drawn again.
test('in Rex a cell-size query cut short is not kept: the next drawing asks again and draws the picture', async ($, on) => {
  engine(on)
  mock.clock(on)
  const runs: string[][] = []
  let cut = true
  rexPane(on, runs, async argv => (cut && isSize(argv) ? { deny: 'aborted' } : undefined))
  mock.env(on, { ...REX, REX_BLOCK: 'block:cut', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  const first = await rexMount($, '/pictures/cut.png')
  expect(await first.find({ type: 'Image' })).toBeUndefined()
  await first.unmount()
  cut = false
  const second = await rexMount($, '/pictures/cut.png')
  expect(await sizes(second)).toEqual([[13, 3]])
  await second.unmount()
})

test('in Rex a failed cell-size query keeps the size Rex gave last', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const runs: string[][] = []
  let cut = false
  rexPane(on, runs, async argv => (cut && isSize(argv) ? { deny: 'aborted' } : undefined))
  mock.env(on, { ...REX, REX_BLOCK: 'block:kept', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  const first = await rexMount($, '/pictures/kept.png')
  expect(await sizes(first)).toEqual([[13, 3]])
  await first.unmount()
  // Past the few seconds a size is trusted, Rex is asked again and does not answer.
  await clock.advance(6000)
  cut = true
  const second = await rexMount($, '/pictures/kept.png')
  expect(await sizes(second)).toEqual([[13, 3]])
  expect(runs.filter(isSize)).toHaveLength(2)
  await second.unmount()
})

test('in Rex two drawings of one picture at once share one sips run; one cut short leaves the other to make it', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const runs: string[][] = []
  let cutRuns = 0
  rexPane(on, runs, async argv => {
    if (argv[0] !== 'sips' || argv[3] !== 'png') return undefined
    await clock.sleep(100)
    // The first run for cut.png ends with its drawing; any later one makes the PNG.
    if (argv.includes('/pictures/shared-cut.png') && cutRuns++ === 0) return { deny: 'aborted' }
    return undefined
  })
  mock.env(on, { ...REX, REX_BLOCK: 'block:shared', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  const pngRuns = (path: string) => runs.filter(r => r[0] === 'sips' && r[3] === 'png' && r.includes(path)).length

  const both = [rexMount($, '/pictures/shared.png'), rexMount($, '/pictures/shared.png')]
  await clock.advance(100)
  const drawn = await Promise.all(both)
  expect(await Promise.all(drawn.map(sizes))).toEqual([[[13, 3]], [[13, 3]]])
  expect(pngRuns('/pictures/shared.png')).toBe(1)
  for (const ui of drawn) await ui.unmount()

  const cutBoth = [rexMount($, '/pictures/shared-cut.png'), rexMount($, '/pictures/shared-cut.png')]
  await clock.advance(100)
  await clock.advance(100)
  const cutDrawn = await Promise.all(cutBoth)
  expect(await sizes(cutDrawn[1]!)).toEqual([[13, 3]])
  expect(pngRuns('/pictures/shared-cut.png')).toBe(2)
  for (const ui of cutDrawn) await ui.unmount()
})

test('a picture read cut short is not kept: the next drawing reads it again', async ($, on) => {
  engine(on)
  let cut = true
  on('fs.stat', async (_$, e) => (e.path === '/pictures/read-cut.png' ? { value: { kind: 'file' as const, size: 550, mtimeMs: 1, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  on('fs.read', async (_$, e) => (e.path === '/pictures/read-cut.png' && !cut ? { value: { base64: PNG_HEAD } } : { deny: 'aborted' }))
  mock.env(on, ghostty)
  const first = await rexMount($, '/pictures/read-cut.png')
  expect(await first.find({ type: 'Image' })).toBeUndefined()
  await first.unmount()
  cut = false
  const second = await rexMount($, '/pictures/read-cut.png')
  expect(await second.find({ type: 'Image' })).toBeDefined()
  await second.unmount()
})

test('without kitty graphics a picture is drawn in half blocks from a BMP sips made', async () => {
  // 2×4 pixels, 24-bit, bottom-up: rows (top to bottom) red, green, blue, white.
  const head = new Uint8Array(54)
  const dv = new DataView(head.buffer)
  head[0] = 0x42
  head[1] = 0x4d
  dv.setUint32(10, 54, true)
  dv.setInt32(18, 2, true)
  dv.setInt32(22, 4, true)
  dv.setUint16(28, 24, true)
  const row = (b: number, g: number, r: number) => [b, g, r, b, g, r, 0, 0]
  const body = [...row(255, 255, 255), ...row(255, 0, 0), ...row(0, 255, 0), ...row(0, 0, 255)]
  const bmp = new Uint8Array([...head, ...body])
  const cells = new Uint32Array((Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(bmpToHalfBlocks(bmp, 2, 2)!).buffer)
  expect([...cells.slice(0, 3)]).toEqual([0x2580, 0xff0000, 0x00ff00])
  expect([...cells.slice(6, 9)]).toEqual([0x2580, 0x0000ff, 0xffffff])
  expect(bmpToHalfBlocks(bmp, 3, 2)).toBeUndefined()
})
