/**
 * 提炼规律：把作者在候选稿上标的「好 / 坏」压成可复用的写作规律。
 *
 * 这是整个偏好档案的源头——没有它，档案只能手写。
 * 设计上分三步，UI 也对应三步：
 *   1. pending  看有多少待提炼的标注
 *   2. run       调一次模型，产出候选规律（不落盘）
 *   3. apply     作者勾选采纳的，写进档案
 */
import { basename } from 'node:path'

export const DISTILL_LIMITS = {
  maxSegments: 40,
  maxCharsPerSegment: 240,
  maxInputBytes: 20000,
  maxOutputTokens: 2200,
  timeoutMs: 90000,
}

export const DISTILL_SYSTEM = [
  '你是中文网文的老责编。作者在一批候选稿上手工标了"好"和"坏"的段落，',
  '你的活是把这些标注压成可复用的写作规律，供下一轮改稿直接照做。',
  '',
  '严格按下面的格式输出，不要任何别的内容（不要开场白、不要解释、不要总结）：',
  '',
  '喜欢：',
  '- 让在场群像先静默再爆响（来自 2、5、9）',
  '- 危险降临先写器物异动，再写人的闷哼（来自 1、7）',
  '避免：',
  '- 不要用比喻堆砌来写人群的恐惧（来自 3、4、11）',
  '- 不要在施法后补旁白解释动机（来自 6、10）',
  '',
  '每条规律的要求：',
  '1. 不超过 40 个字；"喜欢"写要怎么做，"避免"写不要怎么做。',
  '2. 一条只讲一件事，不要写成"A，别 B"这种对比句；避免项直接用"不要"或"别"开头。',
  '3. 严禁抄原文、严禁引用原句、严禁出现"这段/该段/第X段/作者"这类指代。',
  '4. 不要评价（"写得很好""节奏不错"），要写做法（"用干巴巴的一句话接住重击"）。',
  '5. 规律要能同时解释好几条标注；只出现一次的偶然现象不要写。',
  '6. 每节最多 8 条；证据不够就少写，不凑数。',
  '7. 每条末尾必须用「（来自 3、7）」注明它是从输入里哪几条标注看出来的——只写编号，',
  '   不要写文件名、不要抄原文。作者会点开这条规律回看那几段原文，编号错了他一眼就发现。',
].join('\n')

/** 小节标题：`喜欢：` / `避免：`（允许 # 号、粗体、全角冒号） */
function sectionKindOf(line) {
  const flat = line.replace(/[#*\s]/g, '')
  if (!/[：:]$/.test(flat)) return null
  const label = flat.replace(/[：:]$/, '')
  if (label === '' || label.length > 12) return null
  if (/避免|别|忌|不要|不喜欢|删|扣分/.test(label)) return 'bad'
  if (/喜欢|偏好|要学|保留|加分|优点/.test(label)) return 'good'
  return null
}

/** 条目行：`- xxx`、`+ xxx`、`1. xxx`、`• xxx` */
function bulletOf(line) {
  const matched = /^([-*•·+]|[＋−－–]|\d+[.、)])\s*(.*)$/.exec(line)
  if (matched === null) return { marker: '', text: line }
  return { marker: matched[1], text: matched[2] }
}

/** 规律末尾的来源标注：`（来自 3、7）` / `(来源：3,7)` / `【证据 3、7】` */
const SOURCE_RE = /[（(【\[]\s*(?:来自|来源|证据|依据)\s*[:：]?\s*([0-9,，、\s]+)\s*[）)】\]]\s*$/

function splitSources(text) {
  const raw = String(text)
  const matched = SOURCE_RE.exec(raw)
  if (matched === null) return { text: raw, sources: [] }
  const sources = matched[1]
    .split(/[,，、\s]+/)
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1)
  return { text: raw.slice(0, matched.index).trim(), sources }
}

const cleanRule = (text) =>
  String(text)
    .replace(/[`*]/g, '')
    .replace(/^\d{1,3}\s*[.、)]\s*/, '')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/^规律[一二三四五六七八九十\d]*[：:、.]?\s*/, '')
    .replace(/\s*[（(]第[^）)]*[）)]\s*$/, '')
    .trim()

/**
 * 把模型输出解析成规律条目。
 * 分节优先（`喜欢：`/`避免：`），模型自作主张用 `+`/`-` 标记时也能救回来。
 */
export function parseDistillOutput(text) {
  const items = []
  let section = null
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/u, '').trim()
    if (line === '' || /^```/u.test(line)) continue
    const heading = sectionKindOf(line)
    if (heading !== null) {
      section = heading
      continue
    }
    const bullet = bulletOf(line)
    if (bullet.marker === '') continue
    const { text: body, sources } = splitSources(bullet.text)
    const cleaned = cleanRule(body)
    if (cleaned === '' || cleaned.length < 4) continue
    // 没有小节时，靠标记方向猜：`+`/＋ 是喜欢，`-` 是避免
    let mark = section
    if (mark === null) {
      const m = bullet.marker
      if (m === '+' || m === '＋') mark = 'good'
      else if (m === '-' || m === '−' || m === '－') mark = 'bad'
      else continue
    }
    items.push({ mark, text: cleaned.slice(0, 80), sources })
  }
  return items
}

/**
 * 把待提炼的标注拼成有界输入。
 * 每行带序号，模型被要求在规律末尾写「（来自 3、7）」，
 * refs 就是序号 → 标注 的对照表。
 */
export function buildDistillInput(entries) {
  const picked = entries.slice(0, DISTILL_LIMITS.maxSegments)
  const lines = []
  const refs = []
  let bytes = 0
  for (const entry of picked) {
    const clipped = String(entry.text).replace(/\s+/gu, ' ').slice(0, DISTILL_LIMITS.maxCharsPerSegment)
    const n = lines.length + 1
    const line = `${n}. ${entry.mark === 'good' ? '[好]' : '[坏]'} ${basename(entry.file)}：${clipped}`
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > DISTILL_LIMITS.maxInputBytes) break
    lines.push(line)
    refs.push({ file: entry.file, chapter: entry.chapter, index: entry.index, mark: entry.mark, text: clipped })
    bytes += size
  }
  return { text: lines.join('\n'), used: refs.length, total: entries.length, refs }
}

// ── 档案写入 ──────────────────────────────────────────────

export const GOOD_HEADING = '## 已验证偏好（作者喜欢什么）'
export const BAD_HEADING = '## 避免的写法（作者不喜欢什么）'

const normRule = (text) => String(text).replace(/\s+/gu, '').replace(/[。，,.]$/u, '')

/**
 * 把选中的规律并进档案文本。
 * 已有的不重复加（按去空白后比对），返回新文本与新增条数。
 */
export function mergeRulesIntoProfile(profileText, items) {
  let text = typeof profileText === 'string' ? profileText : ''
  const existing = new Set(
    text
      .split('\n')
      .map((l) => l.replace(/^[-*•]\s*/u, '').trim())
      .filter((l) => l !== '')
      .map(normRule),
  )

  const add = (heading, want) => {
    const lines = items.filter((x) => x.mark === want && !existing.has(normRule(x.text))).map((x) => '- ' + x.text)
    if (lines.length === 0) return 0
    for (const l of lines) existing.add(normRule(l.slice(2)))
    const idx = text.indexOf(heading)
    if (idx === -1) {
      // 没有这个节就补在末尾
      text = text.replace(/\s+$/u, '') + '\n\n' + heading + '\n' + lines.join('\n') + '\n'
      return lines.length
    }
    // 插在这一节的最后一个列表项之后
    const start = idx + heading.length
    const nextHeading = text.indexOf('\n## ', start)
    const end = nextHeading === -1 ? text.length : nextHeading
    const block = text.slice(start, end)
    const trimmed = block.replace(/\s+$/u, '')
    const insertAt = start + trimmed.length
    text = text.slice(0, insertAt) + '\n' + lines.join('\n') + text.slice(insertAt)
    return lines.length
  }

  const g = add(GOOD_HEADING, 'good')
  const b = add(BAD_HEADING, 'bad')
  return { text, added: g + b, addedGood: g, addedBad: b }
}
