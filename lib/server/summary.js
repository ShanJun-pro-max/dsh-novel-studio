/**
 * 剧情总结的提示词、头部字段解析、输出清洗。
 *
 * 格式是 Markdown + YAML 头部：
 *
 *   ---
 *   chapter: 11
 *   characters: [陆铮, 萧烬, 闫振军]
 *   location: 城东老院子
 *   planted: [萧烬体质收不住]
 *   paid: []
 *   ---
 *
 *   # 第11章 剧情总结
 *   ...
 *
 * 头部 6 行给机器查（谁在哪章出场、伏笔埋收），正文照旧给人读和改。
 * 老的总结没有头部也能用 —— parseSummary 会从正文兜底提取。
 */

export const SUMMARY_SYSTEM = [
  '你是中文网文的责编，负责给作者整理每一章的剧情总结。',
  '总结是给「写下一章时的自己」看的：它要让人一眼想起这章发生了什么、留下了什么。',
  '',
  '严格按下面的格式输出，不要任何别的内容（不要开场白、不要解释）：',
  '',
  '---',
  'chapter: N',
  'characters: [出场人物名字，逗号分隔]',
  'location: [主要地点，逗号分隔；没有就写 无]',
  'planted: [本章新埋的伏笔或线索，一句话一个；没有就写 无]',
  'paid: [本章回收的前面埋的伏笔；没有就写 无]',
  '---',
  '',
  '# 第N章 剧情总结',
  '',
  '## 核心剧情点',
  '',
  '- 一句话一件事，按发生顺序',
  '- 8 到 12 条',
  '',
  '## 本章埋点',
  '',
  '- 伏笔、线索、留白、人物态度的转折',
  '- 没有就写：- 无',
  '',
  '## 本章结尾',
  '',
  '（一句话交代这章结束在哪个画面）',
  '',
  '## 出场人物',
  '',
  '- 名字（有台词 / 只是提及）',
  '',
  '要求：',
  '1. 用中文，第三人称一致：写「陆铮」，不写「主角」「他」。',
  '2. 头部的 characters 只写名字本身，不要加括号说明，不要写「主角」。',
  '3. 核心剧情点只写发生的事，不写评价（不要「写得很精彩」「节奏紧凑」）。',
  '4. 埋点写「之后可能要收的东西」，不是复述剧情。',
  '5. 不要抄原文句子，用自己的话概括。',
  '6. 出场人物包括被提到但没露面的，在正文那一节括号里注明。',
].join('\n')

export function buildSummaryUser(chapter, text) {
  return '下面是第' + String(chapter) + '章的正文，请写这一章的剧情总结。chapter 字段填 ' + String(chapter) + '：\n\n' + text
}

/** 反引号（避免在本文件里直接写出三连反引号） */
const TICK = String.fromCharCode(96)
const FENCE = TICK + TICK + TICK

/** 去掉首尾的代码围栏 */
function stripFence(raw) {
  let text = String(raw == null ? '' : raw).trim()
  if (text.startsWith(FENCE)) {
    const i = text.indexOf('\n')
    text = i === -1 ? '' : text.slice(i + 1)
  }
  const j = text.lastIndexOf(FENCE)
  if (j !== -1 && text.slice(j + FENCE.length).trim() === '') text = text.slice(0, j)
  return text.trim()
}

/**
 * 解析一行 `key: value`，value 支持 [a, b, c] 和裸字符串。
 */
function parseField(line) {
  const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line)
  if (m === null) return null
  const key = m[1]
  let value = m[2].trim()
  let list = null
  if (value.startsWith('[') && value.endsWith(']')) {
    list = value
      .slice(1, -1)
      .split(/[,，]/u)
      .map((x) => x.trim().replace(/^["'“”‘’]/u, '').replace(/["'“”‘’]$/u, ''))
      .filter((x) => x !== '' && x !== '无')
    value = list.join(',')
  }
  return { key, value, list }
}

/**
 * 从总结文本里解析头部字段。
 * 没有头部就返回空对象 —— 调用方自己再兜底。
 */
export function parseSummaryHead(text) {
  const src = String(text == null ? '' : text)
  const out = { chapter: null, characters: [], location: [], planted: [], paid: [] }
  const lines = src.split('\n')
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      if (start === -1) {
        start = i
        continue
      }
      end = i
      break
    }
  }
  if (start === -1 || end === -1) return out
  for (let i = start + 1; i < end; i += 1) {
    const f = parseField(lines[i].trim())
    if (f === null) continue
    if (f.key === 'chapter') {
      const n = Number(f.value)
      if (Number.isFinite(n)) out.chapter = n
    } else if (f.key === 'characters') {
      out.characters = f.list === null ? (f.value === '无' ? [] : [f.value]) : f.list
    } else if (f.key === 'location') {
      out.location = f.list === null ? (f.value === '无' ? [] : [f.value]) : f.list
    } else if (f.key === 'planted') {
      out.planted = f.list === null ? (f.value === '无' ? [] : [f.value]) : f.list
    } else if (f.key === 'paid') {
      out.paid = f.list === null ? (f.value === '无' ? [] : [f.value]) : f.list
    }
  }
  return out
}

/** 取某个 `## 标题` 下的列表项 */
export function sectionList(text, headingRe) {
  const lines = String(text == null ? '' : text).split('\n')
  const out = []
  let inside = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^#{1,6}\s/u.test(line)) {
      inside = headingRe.test(line)
      continue
    }
    if (!inside) continue
    const m = /^[-*•]\s*(.+)$/u.exec(line)
    if (m !== null) out.push(m[1].trim())
  }
  return out
}

/**
 * 解析一份总结：优先用头部，缺什么从正文兜底。
 * 老总结（没有头部）也能得到可用结果。
 */
export function parseSummary(chapter, text) {
  const head = parseSummaryHead(text)
  const bodyChars = sectionList(text, /出场人物/u)
  // 正文里的「陆铮（有台词）」→ 只要名字
  const bodyNames = bodyChars
    .map((x) => String(x).replace(/[（(].*$/u, '').trim())
    .filter((x) => x !== '' && x.length <= 12)
  const characters = head.characters.length > 0 ? head.characters : bodyNames
  const planted = head.planted.length > 0 ? head.planted : sectionList(text, /埋点|伏笔/u).filter((x) => x !== '无')
  return {
    chapter: head.chapter === null ? Number(chapter) : head.chapter,
    characters,
    location: head.location,
    planted,
    paid: head.paid,
    hasHead: head.characters.length > 0 || head.location.length > 0 || head.planted.length > 0,
  }
}

/** 清洗模型输出：去围栏、补标题、补头部 */
export function cleanSummaryOutput(chapter, raw) {
  let text = stripFence(raw)
  if (text === '') return ''
  const hasHead = text.startsWith('---')
  if (!hasHead) {
    // 模型没给头部：自己补一个空的，正文里能抽的后面再抽
    text = ['---', 'chapter: ' + String(chapter), 'characters: []', 'location: []', 'planted: []', 'paid: []', '---', '', text].join('\n')
  }
  // 头部之后必须跟标题
  const bodyStart = text.indexOf('---', text.indexOf('---') + 3)
  const body = bodyStart === -1 ? text : text.slice(bodyStart + 3)
  if (!/^\s*#\s*第/u.test(body)) {
    text = [text.slice(0, bodyStart + 3), '', '# 第' + String(chapter) + '章 剧情总结', ''].join('\n') + body
  }
  return text.trim()
}
