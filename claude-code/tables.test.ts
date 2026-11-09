import { expect, test } from 'claude-code/testing'

import { liftTables } from './tables.ts'

const TABLE = ['| 选法 | 好处 |', '|---|---|', '| A | 能进记忆 |']
const indent = (n: number, lines: string[]) => lines.map(l => ' '.repeat(n) + l)

test('a table in a numbered item comes to the top level with the rest of its item, the next item keeping its number', () => {
  const text = ['1. 修不修', '2. 怎么处理', '', ...indent(3, TABLE), '', '   ➡️ 建议 A。', '   - 花费有上限', '3. 关键词', '', '❓ 都照建议？'].join('\n')
  expect(liftTables(text)).toBe(['1. 修不修', '2. 怎么处理', '', ...TABLE, '', '➡️ 建议 A。', '- 花费有上限', '', '3. 关键词', '', '❓ 都照建议？'].join('\n'))
})

test('a table right under its bullet, last in the reply, gets its blank line and nothing after it', () => {
  const text = ['- 方案', ...indent(2, TABLE)].join('\n')
  expect(liftTables(text)).toBe(['- 方案', '', ...TABLE].join('\n'))
})

test('a table in a nested item comes all the way out', () => {
  const text = ['1. 外层', '   - 里层', '', ...indent(5, TABLE), '2. 下一项'].join('\n')
  expect(liftTables(text)).toBe(['1. 外层', '   - 里层', '', ...TABLE, '', '2. 下一项'].join('\n'))
})

test('a table at the top level, one indented under a paragraph, and one inside a code fence stay as written', () => {
  const texts = [
    ['开头', '', ...TABLE, '', '结束'].join('\n'),
    ['一段话', '', ...indent(2, TABLE)].join('\n'),
    ['1. 例子', '', '   ```markdown', ...indent(3, TABLE), '   ```', '2. 下一项'].join('\n'),
    '没有表格的回复，只有一个 | 竖线。',
  ]
  for (const text of texts) expect(liftTables(text)).toBe(text)
})
