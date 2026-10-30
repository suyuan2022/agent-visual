import { expect, mock, test } from 'claude-code/testing'

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

test('too narrow frames the source and says why', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text: REPLY, isFirstOfReply: true }, viewport: { columns: 14, rows: 40 } })
  expect(await ui.find({ type: 'Markdown', text: /```mermaid/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /mermaid: flowchart/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /the terminal has 10\./ })).toBeDefined()
  await ui.unmount()
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

// Stands for the files the hooks read: the picture, and rules.md under the plugin's root.
function files(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('fs.stat', async (_$, e) => (e.path === PIC ? { value: { kind: 'file' as const, size: 550, mtimeMs: 1, isLink: false } } : { deny: `ENOENT: ${e.path}` }))
  on('fs.read', async (_$, e) => {
    if (e.path === PIC) return { value: { base64: PNG_HEAD } }
    if (e.path.endsWith('/rules.md')) return { value: '画图和贴图的规矩：用 Mermaid。\n' }
    return { deny: `ENOENT: ${e.path}` }
  })
}

test('a line that is only a local image is drawn as the picture, sized like pi, with a link to it', async ($, on) => {
  engine(on)
  files(on)
  mock.env(on, ghostty)
  const text = `截图如下：\n\n![首页](${PIC})\n\n![小图](${PIC} "w=20 center")\n\n完。`
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true }, viewport })
  const pics = await ui.findAll({ type: 'Image' })
  // On macOS, 320×160 px at 14×28 px a cell is 23×6 cells; `w=20` keeps the shape at 20×5.
  expect(pics.map(p => [p.props.columns, p.props.rows])).toEqual([[23, 6], [20, 5]])
  expect(await ui.find({ type: 'Link', text: 'Open image: 首页' })).toMatchObject({ props: { href: `file://${PIC}` } })
  expect(await ui.find({ type: 'Markdown', text: '截图如下：' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /!\[/ })).toBeUndefined()
  await ui.unmount()
})

test('a missing image says so; a terminal without pictures gets the link alone', async ($, on) => {
  engine(on)
  files(on)
  mock.env(on, { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color', HOME: '/Users/nobody' })
  const text = `![没有](/no/such/file.png)\n\n![有](${PIC})`
  const ui = await $.ui.mount({ plugin: 'agent-visual', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true }, viewport })
  expect(await ui.find({ type: 'Text', text: 'Image not found: /no/such/file.png' })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Link', text: 'Open image: 有' })).toBeDefined()
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
