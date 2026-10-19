/**
 * 整本小说提炼：两阶段。
 *
 * 为什么两阶段：一本书 20 万字塞给模型，它只会记住开头和结尾。
 * 所以先粗扫（每块只给首尾几百字）让模型自己判断哪块值得精读，
 * 再只对重要的块喂全文。这样「给的内容多」和「每个字真被读到」能同时成立。
 */

/** 粗扫：一次扫一批块，让模型挑出值得精读的 */
export const SCAN_SYSTEM = `你在通读一部小说的片段摘要，判断哪些片段值得精读。

每一段会给你：序号、小标题、开头几百字、结尾一两百字。

你要判断：这一段的写法有没有「可学的价值」——具体看这几件事：
- 冲突和情绪怎么推向高潮
- 对话怎么带出人物性格
- 场景转折怎么处理
- 有没有独特的句式、节奏、比喻
- 有没有交代世界观/设定的硬功夫

跳过这些：纯过渡（赶路、吃饭、睡觉）、重复的日常、大段景物铺陈没有信息量的。

输出 JSON 数组，每个元素：
{"i": 序号, "keep": true/false, "why": "一句话说为什么值得精读（keep 为 false 时写为什么跳过）"}

规则：
1. 只输出 JSON，不要解释，不要代码围栏。
2. 你不需要回答所有序号，只回答你判断过的。
3. 全书大约有 N 块，你要挑出 10%-25% 值得精读的——太少了学不到东西，太多了浪费。
4. why 要具体：「打斗节奏快，短句连打」比「写得好」有用。

这次给你的是第 X 块到第 Y 块。`

export const SCAN_SYSTEM_TAIL = '这次给你的是第 {from} 块到第 {to} 块，全书共 {total} 块。'

/** 精读：对单个重要块做深度提炼 */
export const DIGEST_SYSTEM = `你在精读一部小说的一段正文，任务是从中提炼「可复用的写作手法」。

只输出这个结构（纯文本，不要 markdown 标题，不要寒暄）：

STYLE: 这一段在句子/段落/节奏上的特点（一两句，要具体到能照做）
STRENGTH: 这一段好在哪（一两句，说清手法）
PREFER: 值得学的写法，每条一行，以「- 」开头，3-6 条
AVOID: 这段里出现的不值得学的成分（如果有），每条一行，以「- 」开头，0-3 条

规则：
1. 每一条都要能当写作指令用，不要「描写生动」这种空话。
2. 举出原文里的具体做法：「伤痛先写醒来的钝感，再写翻身试探」而不是「细节描写好」。
3. 不评价剧情好坏，只看写法。
4. PREFER 和 AVOID 加起来不超过 9 条。`

/** 汇总：把所有精读结果合成一份报告 */
export const SUMMARIZE_SYSTEM = `你在汇总对一部小说的分析，给出一份「这本书的写法」报告。

材料是很多段精读结果。你要归纳，不是罗列。

输出这个结构（纯文本，不要代码围栏）：

## 风格
这一段讲这本书的句子、段落、叙述上的稳定特征。
- 用 4-8 条，每条一行，以「- 」开头。

## 水准
这一段讲这本书好在哪、短板在哪。
- 用 3-5 条，每条一行，以「- 」开头。
- 要说清楚「强在哪」的具体表现，和「弱在哪」的具体表现。

## 可复用规律
这一段是可以直接拿去写新章的指令。
- 用 8-20 条，每条一行，以「- 」开头。
- 每条必须是「怎么做」，不是「要怎样」。
- 优先保留出现次数多的规律。

## 避坑
这一段是这本书里不值得学的成分。
- 用 2-6 条，每条一行，以「- 」开头。

规则：宁可具体，不要漂亮话。「对话简短有力」不如「对话很少超过两句话，情绪靠动作而不靠说」。`

/** 拼粗扫的输入 */
export const buildScanInput = (chunks, outlineOf, head = 200, tail = 100) => {
  const list = Array.isArray(chunks) ? chunks : []
  return list
    .map((c) => '【' + String(c.index + 1) + '】' + (c.title === undefined ? '' : String(c.title)) + '（' + String(c.chars) + ' 字）\n' + outlineOf(c.text, { head, tail }))
    .join('\n\n---\n\n')
}

/** 解析粗扫结果 */
export const parseScan = (text) => {
  let s = String(text == null ? '' : text).trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/u)
  if (fence !== null) s = fence[1].trim()
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let arr
  try {
    arr = JSON.parse(s.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out = []
  for (const item of arr) {
    if (item === null || typeof item !== 'object') continue
    const i = Number(item.i)
    if (!Number.isInteger(i)) continue
    out.push({ i: i - 1, keep: item.keep === true, why: String(item.why == null ? '' : item.why).trim() })
  }
  return out
}

/** 解析单块精读结果 */
export const parseDigest = (text) => {
  const s = String(text == null ? '' : text)
  const grab = (key) => {
    const re = new RegExp('^' + key + '\\s*[:：]\\s*(.+)$', 'mu')
    const m = s.match(re)
    return m === null ? '' : m[1].trim()
  }
  // 按行扫：找到 key 行，收集其后的「- 」行，遇到下一个 key 就停。
  // 用正则会因为懒惰匹配 + 多行标志的交互吞掉整段，这里手写更可靠。
  const KEYS = ['STYLE', 'STRENGTH', 'PREFER', 'AVOID']
  const bullets = (key) => {
    const lines = s.split('\n')
    const out = []
    let on = false
    for (const raw of lines) {
      const line = raw.trim()
      const isKey = KEYS.some((k) => new RegExp('^' + k + '\\s*[:：]', 'u').test(line))
      if (isKey) {
        on = line.startsWith(key)
        continue
      }
      if (!on) continue
      if (line.startsWith('-') || line.startsWith('•')) {
        const v = line.replace(/^[-•]\s*/u, '').trim()
        if (v !== '') out.push(v)
      } else if (line !== '' && !line.startsWith('-')) {
        // 空行不断，纯文本行也不再收集
        continue
      }
    }
    return out
  }
  return {
    style: grab('STYLE'),
    strength: grab('STRENGTH'),
    prefer: bullets('PREFER'),
    avoid: bullets('AVOID'),
  }
}

/** 把精读结果压成给汇总用的材料 */
export const buildSummarizeInput = (digests, meta) => {
  const list = Array.isArray(digests) ? digests : []
  const head = [
    '书名：' + String(meta.name == null ? '未命名' : meta.name),
    '总块数：' + String(meta.total == null ? 0 : meta.total) + '，精读了 ' + String(list.length) + ' 块',
    '',
    '以下是各块的精读结果：',
    '',
  ]
  const parts = list.map((d, k) => {
    const lines = ['【' + String(k + 1) + '】' + String(d.title == null ? '' : d.title)]
    if (d.style !== '') lines.push('风格：' + d.style)
    if (d.strength !== '') lines.push('好在：' + d.strength)
    if (d.prefer.length > 0) lines.push('可学：\n' + d.prefer.map((x) => '  - ' + x).join('\n'))
    if (d.avoid.length > 0) lines.push('避坑：\n' + d.avoid.map((x) => '  - ' + x).join('\n'))
    return lines.join('\n')
  })
  return head.concat(parts).join('\n')
}

/** 把汇总报告拆成结构化 */
export const parseSummaryReport = (text) => {
  const s = String(text == null ? '' : text)
  const section = (title) => {
    const lines = s.split('\n')
    const out = []
    let on = false
    for (const raw of lines) {
      const line = raw.trim()
      if (line.startsWith('##')) {
        on = line.replace(/^##\s*/u, '').trim() === title
        continue
      }
      if (!on) continue
      if (line.startsWith('-') || line.startsWith('•')) {
        const v = line.replace(/^[-•]\s*/u, '').trim()
        if (v !== '') out.push(v)
      }
    }
    return out
  }
  return {
    style: section('风格'),
    level: section('水准'),
    prefer: section('可复用规律'),
    avoid: section('避坑'),
    raw: s.trim(),
  }
}
