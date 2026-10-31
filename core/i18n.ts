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
  'Image not found': '找不到图片',
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

/** Why a diagram is shown as source: state only, no instructions. */
export function tooWideNote(lang: Lang = current): string {
  return lang === 'zh' ? '当前宽度无法显示图表' : "Diagram can't be displayed at this width"
}

export function notDrawnNote(warning: string, more: number, lang: Lang = current): string {
  return lang === 'zh'
    ? `无法显示图表：${warning}${more > 0 ? `（另有 ${more} 处）` : ''}`
    : `Diagram can't be displayed: ${warning}${more > 0 ? ` (+${more} more)` : ''}`
}
