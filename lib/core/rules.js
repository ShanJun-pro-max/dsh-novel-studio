/**
 * dsh-novel-studio — 指令（硬约束）
 *
 * 为什么要有这一层：偏好档案是「这本书的口味」，靠模型从成品小说里学，
 * 一开始是空的；而作者第一次开写时最需要的是**不许犯的错**。
 * 指令就是这个底线：不看题材、每写一章都必须照做，用户可自行增删。
 *
 * 只留一面墙不好用，所以分两边：
 *   do   —— 需要 AI 做的（人设真实、细节饱满、短句为主…）
 *   dont —— 禁止 AI 做的（不解释动机、不写总结式收尾、AI 过渡句…）
 *
 * 存哪儿：<作品>/.dsh-novel-studio/指令.json
 * 形状：{ items: [{ id, side: 'do' | 'dont', text, on }] }
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RULES_NAME = '指令.json'

const DO = (list) => list.map((text) => ({ side: 'do', text, on: true }))
const DONT = (list) => list.map((text) => ({ side: 'dont', text, on: true }))

/**
 * 出厂指令：禁止 7 条 + 要做 3 条（共 10 条）。
 *
 * 为什么退回到这 10 条：后来按对照实验长到 25 / 31 / 32 条，
 * 试下来反而把稿子压僵了——句子生硬、为了躲规则绕成「像是…」的比喻句。
 * 这 10 条是最初那一版，只治最要命的几类：解释动机、情绪直白、
 * 身体感受顶替情节、总结式收尾、比喻堆砌、段落失衡。
 * 嫌不够的自己往两栏里加，别塞回出厂。
 */
export const DEFAULT_RULES = [
  ...DONT([
    '不解释动机：不写「他这么做是因为…」「原来是为了…」，让读者自己看出来。',
    '情绪不直接命名：不写「他很愤怒」「她心里一沉」，用动作、物件、话头承载。',
    '不用身体感受代替情节推进：心跳加速、呼吸一滞、血液沸腾、后背发凉这类描写，一章最多一处，且不能顶替事件。',
    '不写总结式收尾：不出现「从此以后」「这就是…的开始」「而这一切才刚开始」这类句子。',
    '不堆比喻：明喻一章不超过三处，不连用「仿佛／似乎／宛如」。',
    '人称与时间线不跳：不随意插叙，除非这一章的结构需要；同一段里不混过去和现在。',
    '不复述设定：读者已经知道的世界观、人物关系不重复交代。',
  ]),
  ...DO([
    '每段至少有一个具体的东西或动作，不写纯氛围空镜。',
    '对白按人分层，一个人一段；不用「他说道」「她问道」堆提示语，靠动作和语气区分是谁在说。',
    '段落长短交错：不整章都是三五行一断的碎段，也不整段两百字一口气到底。',
  ]),
].map((x, i) => ({ id: 'd' + String(i + 1), side: x.side, text: x.text, on: x.on }))

const MAX_ITEMS = 120
const MAX_TEXT = 300

const pathOf = (projectDir) => join(projectDir, '.dsh-novel-studio', RULES_NAME)

const clean = (raw) => String(raw === undefined || raw === null ? '' : raw).replace(/\r\n/g, '\n').trim()

const cloneDefaults = () => DEFAULT_RULES.map((x) => ({ ...x }))

/** 老数据没有 side 时按措辞猜：开头是这些字样的算「禁止」。 */
const inferSide = (text) => (/^(不|禁|杜绝|避免|拒绝|摒弃|不要|别)/u.test(text) ? 'dont' : 'do')

export async function readRules(projectDir) {
  let raw = null
  try {
    raw = await readFile(pathOf(projectDir), 'utf8')
  } catch {
    return { items: cloneDefaults(), fromDefaults: true }
  }
  let items = []
  try {
    const data = JSON.parse(raw)
    items = Array.isArray(data === null || data === undefined ? null : data.items) ? data.items : []
  } catch {
    return { items: cloneDefaults(), fromDefaults: true }
  }
  const out = []
  for (const it of items) {
    if (it === null || typeof it !== 'object') continue
    const body = clean(it.text)
    if (body === '') continue
    const side = it.side === 'do' || it.side === 'dont' ? it.side : inferSide(body)
    out.push({ id: String(it.id === undefined ? 'd' + String(out.length + 1) : it.id), side, text: body, on: it.on !== false })
  }
  if (out.length === 0) return { items: cloneDefaults(), fromDefaults: true }
  return { items: out, fromDefaults: false }
}

export async function writeRules(projectDir, items) {
  const list = []
  const list2 = Array.isArray(items) ? items : []
  for (const it of list2) {
    if (it === null || typeof it !== 'object') continue
    const body = clean(it.text).slice(0, MAX_TEXT)
    if (body === '') continue
    list.push({
      id: String(it.id === undefined ? 'd' + String(list.length + 1) : it.id),
      side: it.side === 'dont' ? 'dont' : 'do',
      text: body,
      on: it.on !== false,
    })
    if (list.length >= MAX_ITEMS) break
  }
  await writeFile(pathOf(projectDir), JSON.stringify({ items: list }, null, 2) + '\n', 'utf8')
  return list
}

const pickSide = (items, side) =>
  (Array.isArray(items) ? items : [])
    .filter((x) => x.on !== false && clean(x.text) !== '' && (side === 'dont' ? x.side === 'dont' : x.side !== 'dont'))
    .map((x) => clean(x.text))

export const mustDo = (items) => pickSide(items, 'do')
export const mustNot = (items) => pickSide(items, 'dont')
export const activeCount = (items) => mustDo(items).length + mustNot(items).length

/**
 * 拼成写进提示词的一段。
 *
 * 位置很关键：放在**最后**，紧挨着「请写出…」那句。
 * 写作包三四千字，塞在中间会被后面的大纲、前情冲淡。
 */
export function rulesBlock(items) {
  const yes = mustDo(items)
  const no = mustNot(items)
  if (yes.length === 0 && no.length === 0) return ''
  const lines = ['', '【写作指令（硬约束）】', '']
  if (yes.length > 0) {
    lines.push('必须做到：')
    yes.forEach((t, i) => lines.push(String(i + 1) + '. ' + t))
  }
  if (no.length > 0) {
    if (yes.length > 0) lines.push('')
    lines.push('禁止出现：')
    no.forEach((t, i) => lines.push(String(i + 1) + '. ' + t))
  }
  lines.push(
    '',
    '以上是作者定的硬约束，优先级高于写作包里的建议与风格说明：**每一条都必须遵守**。',
    '与写作包里任何写法冲突时，以这里为准。',
  )
  return lines.join('\n')
}
