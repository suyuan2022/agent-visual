import { expect, test } from 'claude-code/testing'

import { findDiagrams, fit, needsWholeMarkdown, plainRewrite, replyLang, topDown } from './core.ts'
import type { Fit } from './core.ts'
import { cellSize, findImages, imageBox } from '../claude-code/images.ts'
import { normalize } from './normalize.ts'

const TREE = [
  'flowchart TD',
  '  G["目标：少排队 > 早知道<br/>e2e 不让问题进 main"] --> R["路线甲：中间只跑单元<br/>合并前一次全量"]',
  '  R --> L["最后一次 = 转正式"]',
  '  R --> H["合并前全量硬挡"]',
  '  H --> M["mini 全挂：admin bypass"]',
  '  H --> F["偶发红：现有机制慢慢修"]',
].join('\n')

const WIDE_LR = [
  'flowchart LR',
  '  A[Parse the source] --> B{Supported?}',
  '  B -->|yes| C[Lay it out]',
  '  B -->|no| D[Show the framed source]',
  '  C --> E[Unicode art for the terminal]',
  '  D --> E',
].join('\n')

test('closed and streaming mermaid fences are found with their source', async () => {
  const text = `前言\n\n\`\`\`mermaid\n${TREE}\n\`\`\`\n\n中间\n\n~~~mermaid\ngraph TD\n  A --> B`
  const found = findDiagrams(text)
  expect(found.length).toBe(2)
  expect(found[0].source).toBe(TREE)
  expect(found[0].closed).toBe(true)
  expect(text.slice(found[0].start, found[0].end)).toBe(`\`\`\`mermaid\n${TREE}\n\`\`\``)
  expect(found[1].source).toBe('graph TD\n  A --> B')
  expect(found[1].closed).toBe(false)
})

test('a mermaid example inside another fence, an indented fence and inline code stay text', async () => {
  expect(findDiagrams('````markdown\n```mermaid\ngraph TD\n  A --> B\n```\n````')).toEqual([])
  expect(findDiagrams('1. 步骤\n   ```mermaid\n   graph TD\n   A --> B\n   ```')).toEqual([])
  expect(findDiagrams('```mermaid` 不是围栏\n```mermaid\ngraph TD\n```').length).toBe(1)
})

test('only left-right flowcharts turn top-down', async () => {
  expect(topDown('flowchart LR\n  A --> B')).toBe('flowchart TD\n  A --> B')
  expect(topDown('  graph RL\n  A --> B')).toBe('  graph TD\n  A --> B')
  expect(topDown('flowchart TD\n  A --> B')).toBeUndefined()
  expect(topDown('sequenceDiagram\n  A->>B: hi')).toBeUndefined()
})

test('the Chinese tree draws with every label, boxes as wide as their text', async () => {
  const f = fit(TREE, 120)
  expect(f.kind).toBe('art')
  const plain = f.kind === 'art' ? f.art.plain.join('\n') : ''
  for (const label of ['少排队 > 早知道', '中间只跑单元', '转正式', '合并前全量硬挡', 'admin bypass', '现有机制慢慢修']) {
    expect(plain).toContain(label)
  }
})

test('too wide left to right is drawn top-down, and too wide either way frames the source with a note', async () => {
  const lr = fit(WIDE_LR, 1000)
  const td = fit(WIDE_LR, 60)
  expect(lr.kind).toBe('art')
  expect(td.kind).toBe('art')
  const width = (f: Fit) => (f.kind === 'art' ? f.art.width : 0)
  expect(width(td) <= 60).toBe(true)
  expect(width(lr) > width(td)).toBe(true)
  const narrow = fit(WIDE_LR, 10)
  expect(narrow.kind).toBe('box')
  expect(narrow.kind === 'box' ? narrow.note : '').toContain("can't be displayed at this width")
  expect(narrow.art.plain[0]).toContain('mermaid: flowchart')
})

test('gantt is drawn by default, the uncommon types only when experimental; a dropped statement frames the source with a note', async () => {
  expect(fit('gantt\n  title 排期\n  dateFormat YYYY-MM-DD\n  需求 :d1, 2026-11-01, 3d', 120).kind).toBe('art')
  const journey = 'journey\n  title 一天\n  section 早\n    起床: 3: 我'
  const quiet = fit(journey, 120)
  expect(quiet.kind).toBe('box')
  expect(quiet.kind === 'box' ? quiet.note : '').toBeUndefined()
  expect(quiet.art.plain.join('\n')).toContain('起床: 3: 我')
  expect(fit(journey, 120, { experimental: true }).kind).toBe('art')
  expect(fit('swimlane-beta\n  subgraph 甲\n    A --> B\n  end', 120).kind).toBe('box')
  // The stricter grammars retry once without their last line, the one a half-typed source ends on.
  const broken = fit('stateDiagram-v2\n  A --> B\n  this is not a statement', 120)
  expect(broken.kind).toBe('box')
  expect(broken.kind === 'box' ? broken.note : '').toContain("Diagram can't be displayed:")
})

test('the colorless path swaps drawn blocks for text fences and leaves the rest', async () => {
  const text = `看图[^1]：\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n\n[^1]: 脚注`
  expect(needsWholeMarkdown(text)).toBe(true)
  expect(needsWholeMarkdown('普通回复')).toBe(false)
  const diagrams = findDiagrams(text)
  const out = plainRewrite(text, diagrams, new Map([[diagrams[0], fit(diagrams[0].source, 80)]]))
  expect(out).toContain('```text\n')
  expect(out).not.toContain('```mermaid')
  expect(out.endsWith('[^1]: 脚注')).toBe(true)
})

const plain = (src: string, columns = 120) => fit(src, columns).art.plain.join('\n')

test('mermaid.js spellings lovely-mermaid misreads are respelled before drawing', async () => {
  // Edge ids, invisible links, the double circle, Font Awesome icons and markdown strings over two lines.
  const flow = plain('flowchart LR\n  A e1@--> B\n  e1@{ animate: true }\n  B ~~~ C(((圆)))\n  C --> D["`**粗**\n  两行`"]\n  D --> E[fa:fa-camera 拍照]')
  expect(flow).toContain('粗 两行')
  expect(flow).toContain('拍照')
  expect(flow).not.toMatch(/e1|fa:|\*\*|~~~/)
  // mermaid's `#name;` entities, where lovely ends a statement at `;` and where it reads `&name;`.
  expect(plain('sequenceDiagram\n  A->>B: I #9829; you #quot;x#quot;<br/>again')).toContain('I ♥ you "x" again')
  expect(plain('flowchart LR\n  A["say #quot;hi#quot; #35;1"]')).toContain('say "hi" #1')
  // ER: written-out cardinalities, `direction`, `:::class` and subgraphs, the groups listed under the drawing.
  const er = fit('erDiagram\n  direction LR\n  subgraph 订单域\n    CAR:::hot 1 to zero or more DRIVER : allows\n  end', 120)
  expect(er.kind).toBe('art')
  expect(er.art.plain.join('\n')).toMatch(/allows[\s\S]*Groups\n订单域  CAR、DRIVER/)
  // class: backtick names, two-way relations, lollipops and inline stereotypes.
  const cls = plain('classDiagram\n  class `Animal Class!`\n  `Animal Class!` <|--|> Zebra\n  Zebra --() Walks\n  class Shape <<interface>>')
  expect(cls).toContain('Animal Class!')
  expect(cls).toMatch(/△[\s\S]*▽/)
  expect((cls.match(/«interface»/g) ?? []).length).toBe(2)
  // sequence: the newer participant shapes, named in the label.
  expect(plain('sequenceDiagram\n  participant DB@{ "type": "database" }\n  DB->>B: x')).toContain('DB [database]')
  expect(normalize('pie\n  "a" : 1').src).toBe('pie\n  "a" : 1')
})

test('two labeled edges into one node keep both labels, top-down and left-right', async () => {
  const td = plain('flowchart TD\n  A -->|是| C\n  B -->|否| C')
  expect(td).toMatch(/▼是 +▼否/)
  const lr = plain('flowchart LR\n  A -->|是| C\n  B -->|否| C')
  expect(lr).toContain('是')
  expect(lr).toContain('否')
  expect(td + lr).not.toContain('Labels not drawn')
})

// A model's own answer to 订单从下单到退款有哪些状态, in a fresh session with the plugin.
const ORDER_STATES = [
  'stateDiagram-v2',
  '    [*] --> 待支付',
  '    待支付 --> 已取消: 超时未付或用户取消',
  '    待支付 --> 已支付: 支付回调成功',
  '    已支付 --> 已发货: 商家发货',
  '    已发货 --> 已签收: 物流签收',
  '    已签收 --> 已完成: 确认收货或超时自动确认',
  '    已完成 --> [*]',
  '    已取消 --> [*]',
  '    已支付 --> 退款中: 发货前取消或退款',
  '    已发货 --> 退款中: 未收货，仅退款',
  '    已签收 --> 退货退款中: 申请退货退款',
  '    退货退款中 --> 退款中: 商家同意，退货入库',
  '    退货退款中 --> 已签收: 商家拒绝',
  '    已完成 --> 退款中: 售后窗口内申请',
  '    退款中 --> 已退款: 原路退回成功',
  '    退款中 --> 退款失败: 支付渠道失败',
  '    退款失败 --> 退款中: 重新发起',
  '    已退款 --> [*]',
].join('\n')

// A reply's refund flow: a fan-out with a long verb, and two skips converging with a forward edge.
const REFUND = `flowchart TD
    A[待支付] -->|支付成功| B[待发货]
    A -->|超时未付 / 用户取消| C[已取消]
    B -->|商家发货| D[已发货]
    B -->|未发货申请退款| R[退款中]
    D -->|用户签收| E[已完成]
    D -->|确认收货超时| E
    D -->|申请退货退款| R
    E -->|售后期内申请| R
    R -->|审核通过 原路退回| F[已退款]
    R -->|商家拒绝| G[退款失败]
    G -->|回到申请前状态| D`

test('labels keep to their own edge: source cards on their own runs, boxes spaced for their verbs, skips on entries of their own', async () => {
  // One entity fanning out: each source-end card rides its own run, left and right of the stub.
  expect(plain('erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER }|..|{ ADDRESS : uses')).toContain('┌────1┴1..*╌╌┐')
  // Two arrivals side by side: the left box sits far enough out for its verb to end before the next arrow.
  const states = plain(ORDER_STATES, 140)
  expect(states).toMatch(/▼超时未付或用户取消 +▼支付回调成功/)
  expect(states).not.toContain('Labels not drawn')
  // Two skips and a forward edge into one box: three arrows, three verbs, no line crossing another.
  const refund = plain(REFUND, 120)
  expect(refund).toMatch(/▼超时未付 \/ 用户取消 +▼支付成功/)
  expect(refund).toMatch(/▼未发货申请退款 +▼售后期内申请 +▼申请退货退款/)
  expect(refund).toMatch(/▼审核通过 原路退回 +▼商家拒绝/)
  expect(refund).not.toContain('┼')
  expect(refund).not.toContain('Labels not drawn')
})

// A reply's PR flow: Address comments loops back up, Merge gates met? only takes skips from above.
const PR_FLOW = `flowchart TD
    A[Branch off main] --> B[Push commits]
    B --> C[Open PR]
    C --> D[CI runs checks]
    C --> E[Code review]
    D -->|fails| F[Fix from CI logs]
    E -->|changes requested| G[Address comments]
    F --> P[Push new commit]
    G --> P
    P -->|retriggers| D
    P -->|may dismiss old approval| E
    D -->|all green| M{Merge gates met?}
    E -->|approved| M
    M -->|main moved ahead| U[Update branch]
    U --> D
    M -->|yes| X[Merge PR]
    X --> Y[Delete branch, deploy main]`

test('a box a back edge leaves by its side sits last in its rank, so the edge cuts through no box', async () => {
  const pr = plain(PR_FLOW, 106)
  const row = pr.split('\n').find(l => l.includes('Address comments')) ?? ''
  expect(row).toContain('Merge gates met?')
  expect(row.indexOf('Merge gates met?')).toBeLessThan(row.indexOf('Address comments'))
  expect(pr).not.toContain('Labels not drawn')
})

test('a label the layout still has no room for is listed under the drawing', async () => {
  // Right to left, two arrivals from one source: the second target-end card has no cell left.
  const cls = plain('classDiagram\n  direction RL\n  class Student {\n    -idCard : IdCard\n  }\n  class IdCard{\n    -id : int\n  }\n  class Bike{\n    -id : int\n  }\n  Student "1" --o "1" IdCard : carries\n  Student "1" --o "1" Bike : rides')
  expect(cls).toMatch(/Labels not drawn\nStudent → Bike  1$/)
  // An ER arrival with a skip entering just right of it: its card and verb go left of its line instead.
  const er = plain('erDiagram\n  USER ||--o{ ORDER : 下单\n  ORDER ||--|{ ORDER_ITEM : 包含\n  PRODUCT ||--o{ ORDER_ITEM : 被购买')
  expect(er).toMatch(/包含│ +┌/)
  expect(er).not.toContain('Labels not drawn')
})

test('pictures size like pi: own pixels at the cell size, capped at the width less 2 and 85% of the window', async () => {
  const LOW = { width: 8, height: 16 }
  // One picture pixel on one screen pixel: 14×28 on a Retina Mac, the `cellSize` setting when it reads WxH.
  expect(cellSize('auto', true)).toEqual({ width: 14, height: 28 })
  expect(cellSize('auto', false)).toEqual(LOW)
  expect(cellSize(' 16 x 32 ', true)).toEqual({ width: 16, height: 32 })
  expect(imageBox({ width: 1600, height: 900 }, { columns: 200, rows: 60 }, cellSize('auto', true))).toEqual({ columns: 115, rows: 32 })
  expect(imageBox({ width: 320, height: 160 }, { columns: 100, rows: 40 }, LOW)).toEqual({ columns: 40, rows: 10 })
  // A wide screenshot fills the width; a tall one stops at 85% of 40 rows and narrows to keep its shape.
  expect(imageBox({ width: 3000, height: 1000 }, { columns: 100, rows: 40 }, LOW)).toEqual({ columns: 98, rows: 16 })
  expect(imageBox({ width: 800, height: 3200 }, { columns: 100, rows: 40 }, LOW)).toEqual({ columns: 17, rows: 34 })
  // `w=` asks for columns, never past the width; a tiny picture still gets 10.
  expect(imageBox({ width: 320, height: 160 }, { columns: 100, rows: 40 }, LOW, 200)).toEqual({ columns: 98, rows: 25 })
  expect(imageBox({ width: 16, height: 16 }, { columns: 100, rows: 40 }, LOW)).toEqual({ columns: 10, rows: 5 })
  const lines = findImages('前\n![a](~/x.png "w=30 center")\n![b](rel.png)\n```\n![c](/y.png)\n```\n  ![d](file:///z%20z.png)', '/Users/me')
  expect(lines.map(l => [l.alt, l.path, l.width, l.center])).toEqual([['a', '/Users/me/x.png', 30, true], ['d', '/z z.png', undefined, false]])
})

test('notes and drawn words follow the reply language: Chinese prose gets Chinese, anything else English', () => {
  expect(replyLang('看这张图\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`')).toBe('zh')
  expect(replyLang('Here it is\n\n\`\`\`mermaid\ngraph TD\n  A[中文] --> B\n\`\`\`')).toBe('en')
  const wide = 'graph TD\n  A --> B & C & D & E & F & G & H'
  const zh = fit(wide, 10, { lang: 'zh' })
  expect(zh.kind === 'box' ? zh.note : '').toContain('当前宽度无法显示图表')
  const en = fit(wide, 10)
  expect(en.kind === 'box' ? en.note : '').toContain("can't be displayed at this width")
  const gantt = 'gantt\n  dateFormat YYYY-MM-DD\n  A :a, 2024-01-01, 3d\n  B :crit, 2024-01-02, 2d'
  expect(fit(gantt, 100, { lang: 'zh' }).art.plain.join('\n')).toContain('已完成')
  expect(fit(gantt, 100).art.plain.join('\n')).toContain('done')
})
