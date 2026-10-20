/**
 * 跨书分析：把「一本书学一次」升级成「一个书库一起学」。
 *
 * 为什么走报告而不是重读原文：
 * - 一本书精读下来 40—80 次模型调用，五本书重读就是几百次，作者付不起；
 * - 每本书的 `报告.md` 已经是那本书的结论（风格、说话、剧情、张力、设定），
 *   跨书比较真正需要的是「几本书的结论放在一起看差异」，不是再看一遍正文；
 * - 所以默认路径是「每本书的报告 → 一次跨书综合」，只有作者明确要求才回退到读原文。
 *
 * 这一层不做 I/O，只负责拼输入和解析输出，方便单独跑。
 */

/** 五个可勾选的维度；顺序即输出顺序 */
export const DIMS = [
  { key: 'style', label: '写作风格', hint: '句子长短、叙述视角、描写密度、口语还是书面' },
  { key: 'speech', label: '人物说话', hint: '台词习惯、称呼、语气词、谁对谁怎么说' },
  { key: 'plot', label: '剧情走向', hint: '开篇怎么起、冲突怎么升级、章末怎么钩' },
  { key: 'tension', label: '张力设计', hint: '高潮间隔、爆点密度、松紧节奏' },
  { key: 'setting', label: '设定', hint: '世界规则、能力体系、身份阶层、禁忌' },
]

export const dimLabel = (key) => {
  const d = DIMS.find((x) => x.key === key)
  return d === undefined ? String(key) : d.label
}

/**
 * 跨书分析的提示词。
 * 要求：每个维度分「共同点 / 分歧 / 可操作清单」三段，可操作清单必须能直接写进偏好档案。
 */
export const CROSS_SYSTEM = [
  '你在帮一位中文网文作者建「写作偏好档案」。他给了你几本书的分析报告（不是正文），',
  '目标是：把这批书揉成一套「照着写就能像它们」的写作标准——以后作者开新章，模型就是按你这套标准生成正文的。',
  '所以不要写书评、不要排名，要写能直接落地执行的东西：句子怎么断、对话怎么写、情绪怎么落、章末怎么钩、哪些事绝对不能做。',
  '',
  '输出格式（严格遵守，不要开场白、不要代码围栏）：',
  '',
  '## 一、共同的写法',
  '（按下面五个小节写，标题照抄，只写它们共同的做法）',
  '',
  '### 句子与段落',
  '- （2—4 条）',
  '',
  '### 对话',
  '- （2—4 条）',
  '',
  '### 情绪与动作',
  '- （2—4 条）',
  '',
  '### 场景与节奏',
  '- （2—4 条）',
  '',
  '### 人物与设定',
  '- （2—4 条）',
  '',
  '## 二、可以照着写的规律',
  '',
  '### 已验证偏好（这些做法在多本书里都出现，值得学）',
  '- （5—10 条，每条一个可执行的动作，不要抽象口号）',
  '',
  '### 避免的写法（多本书都没这么写，或者这么写的地方明显在灌水）',
  '- （3—8 条）',
  '',
  '规则：',
  '0. 这是一份「照着写」的标准，不是书评：不要出现任何书名，不要写「A 书这样、B 书那样」，也不要有「分歧」「差异」这种小节。',
  '0.1 多本书写法不一致时，只留出现次数更多的那种，另一种丢掉或放进「避免的写法」；读者不需要知道你参考了哪几本。',
  '1. 只依据材料，材料里没有的不要编；某本书缺某维度的材料就跳过，不要拿别的维度凑。',
  '2. 每条规律必须能落到「怎么写」上，写成「不要用 X」「用 Y 代替 X」这种程度；能给例子就给一句示范原文（不超过 20 字）。',
  '3. 不要写书评、不要打分、不要总结剧情本身。',
  '4. 用最普通的口语，不要书面词。',
].join('\n')

/** 单本书的材料上限：太大就截断，保证多本能一起放下 */
export const PER_BOOK_CAP = 6000

/** 所有书加起来的上限：超了从最后一本开始放弃，保证提示词不撑爆 */
export const TOTAL_CAP = 30000

/**
 * 把 N 本书的结论拼成一段输入。
 * @param {Array<{name: string, type?: string, author?: string, report?: string, digested?: number, chunks?: number}>} books
 * @param {string[]} dims 选中的维度 key
 * @param {number} cap 每本上限字数
 * @returns {{ text: string, used: Array<{name: string, source: string, chars: number}>, missing: string[] }}
 */
export function buildCrossInput(books, dims, cap = PER_BOOK_CAP) {
  const list = Array.isArray(books) ? books.filter((b) => b !== null && typeof b === 'object') : []
  const picked = Array.isArray(dims) && dims.length > 0 ? dims.filter((d) => DIMS.some((x) => x.key === d)) : DIMS.map((d) => d.key)
  const dimText = picked.map((d) => '「' + dimLabel(d) + '」' + (DIMS.find((x) => x.key === d) || {}).hint).join('；')
  const lines = []
  const used = []
  const missing = []

  lines.push('这次要横向比较的书一共 ' + String(list.length) + ' 本。')
  lines.push('重点看这几个维度：' + dimText + '。')
  lines.push('')

  for (const b of list) {
    const name = String(b.name === undefined ? '（未命名）' : b.name)
    const meta = [
      b.type === undefined || b.type === '' ? '' : '类型 ' + String(b.type),
      b.author === undefined || b.author === '' ? '' : '作者 ' + String(b.author),
      b.chunks === undefined ? '' : String(b.chunks) + ' 块',
      b.digested === undefined ? '' : '已精读 ' + String(b.digested) + ' 块',
    ].filter((x) => x !== '').join(' · ')

    const report = String(b.report === undefined || b.report === null ? '' : b.report).trim()
    if (report === '') {
      missing.push(name + '（还没有报告：先精读并汇总这本书再来）')
      continue
    }
    const body = report.length > cap ? report.slice(0, cap) + '\n（后略）' : report
    lines.push('=== 书：' + name + (meta === '' ? '' : '（' + meta + '）') + ' ===')
    lines.push(body)
    lines.push('')
    used.push({ name, source: 'report', chars: body.length })
  }

  return { text: lines.join('\n'), used, missing }
}

/**
 * 解析跨书报告：只需要把「已验证偏好 / 避免的写法」两段抓出来，
 * 供「追加到偏好档案」用；其余原样保留给人看。
 */
export function parseCrossReport(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const lines = raw.split(/\r?\n/u)
  const prefer = []
  const avoid = []
  let mode = ''
  for (const line of lines) {
    const t = line.trim()
    if (/已验证偏好/u.test(t)) {
      mode = 'prefer'
      continue
    }
    if (/避免的写法/u.test(t)) {
      mode = 'avoid'
      continue
    }
    if (/^#{1,3}\s/u.test(t)) {
      // 换到别的小节就停（只收这两段）
      if (mode !== '') mode = ''
      continue
    }
    if (mode === '' || !/^[-*]\s+/u.test(t)) continue
    const item = t.replace(/^[-*]\s+/u, '').trim()
    if (item === '') continue
    if (mode === 'prefer') prefer.push(item)
    else avoid.push(item)
  }
  return { prefer, avoid, text: raw.trim() }
}
