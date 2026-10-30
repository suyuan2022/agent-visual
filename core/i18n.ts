// The few words the plugin itself prints, in the reply's language: a reply written in Chinese gets
// Chinese notes, any other reply English. Set per fit() call (fit is synchronous).
export type Lang = 'en' | 'zh'

const ZH: Record<string, string> = {
  'Labels not drawn': '没画上的标签',
  Groups: '分组',
  Notes: '说明',
  Data: '数据',
  ' planned / active  ': ' 计划/进行中  ',
  ' done  ': ' 已完成  ',
  ' critical': ' 关键',
  'Open image': '打开原图',
  'Image not found': '图片不存在',
}

let current: Lang = 'en'

export function withLang<T>(lang: Lang, run: () => T): T {
  const before = current
  current = lang
  try {
    return run()
  } finally {
    current = before
  }
}

/** A fixed word in the current language. */
export function t(word: string, lang: Lang = current): string {
  return lang === 'zh' ? (ZH[word] ?? word) : word
}

/** Chinese when the reply's prose (outside code fences) has any Han character, else English. */
export function replyLang(text: string): Lang {
  const prose = text.replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\2[ \t]*$/gm, '')
  return /[\u4e00-\u9fff]/.test(prose) ? 'zh' : 'en'
}

/** Why a diagram was not drawn, as one line the user can act on. */
export function tooWideNote(width: number, columns: number, lang: Lang = current): string {
  return lang === 'zh'
    ? `这张图要 ${width} 列宽，窗口只有 ${columns} 列，放不下。把窗口拉宽到 ${width} 列以上就会画出来。`
    : `This diagram needs ${width} columns; the window has ${columns}. Widen the window past ${width} columns and it will be drawn.`
}

export function notDrawnNote(warning: string, more: number, lang: Lang = current): string {
  return lang === 'zh'
    ? `这张图没画出来：${warning}${more > 0 ? `（另有 ${more} 条）` : ''}`
    : `This diagram was not drawn: ${warning}${more > 0 ? ` (+${more} more)` : ''}`
}
