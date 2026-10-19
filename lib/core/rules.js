/**
 * dsh-novel-workbench — 指令（硬约束）
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
 * 出厂指令：禁止 8 条 + 要做 3 条（共 11 条）。
 *
 * 为什么退回到这一版：按对照实验长到 25 / 31 / 32 条后，稿子反而僵了——
 * 句子生硬、为了躲规则绕成「像是…」的比喻句。留下的是最要命的那几类，
 * 外加作者亲自读稿后点名的一条：「不用书面词、雅词」。
 *
 * 那条特意和「用词挑最普通的」合成一句：分两条写，模型会当成两条任务分别
 * 去执行，反而更容易绕。合成一句，它记住的是「口语怎么说就怎么写」。
 */
export const DEFAULT_RULES = [
  ...DONT([
    '不解释动机：不写「他这么做是因为…」「原来是为了…」，让读者自己看出来。',
    '情绪不直接命名：不写「他很愤怒」「她心里一沉」，用动作、物件、话头承载。',
    '不用身体感受代替情节推进：心跳加速、呼吸一滞、血液沸腾、后背发凉这类描写，一章最多一处，且不能顶替事件。',
    '不写总结式收尾：不出现「从此以后」「这就是…的开始」「而这一切才刚开始」这类句子。',
    '不堆比喻：明喻一章不超过三处，不连用「仿佛／似乎／宛如」。',
    '不用书面词、雅词：日常口语怎么说就怎么写——写「靠过去」不写「倾过去」，写「问一句」不写「询问」，写「走之前说了句」不写「道别」；动词挑最普通的（看、走、拿、放、说、靠），能具体就不抽象。',
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

const MAX_TRASH = 100

const normItem = (it, fallbackId) => {
  if (it === null || typeof it !== 'object') return null
  const body = clean(it.text)
  if (body === '') return null
  return {
    id: String(it.id === undefined ? fallbackId : it.id),
    side: it.side === 'do' || it.side === 'dont' ? it.side : inferSide(body),
    text: body,
    on: it.on !== false,
  }
}

const normTrash = (it, fallbackId) => {
  const base = normItem(it, fallbackId)
  if (base === null) return null
  return { ...base, deletedAt: typeof it.deletedAt === 'string' ? it.deletedAt : '' }
}

/** 读整份文件（items + trash）；文件不在就给出厂那几条。 */
const loadStore = async (projectDir) => {
  let raw = null
  try {
    raw = await readFile(pathOf(projectDir), 'utf8')
  } catch {
    return { items: cloneDefaults(), trash: [], fromDefaults: true }
  }
  let data = {}
  try {
    data = JSON.parse(raw) === null ? {} : JSON.parse(raw)
  } catch {
    return { items: cloneDefaults(), trash: [], fromDefaults: true }
  }
  const items = []
  for (const it of Array.isArray(data.items) ? data.items : []) {
    const n = normItem(it, 'd' + String(items.length + 1))
    if (n !== null) items.push(n)
  }
  const trash = []
  for (const it of Array.isArray(data.trash) ? data.trash : []) {
    const n = normTrash(it, 't' + String(trash.length + 1))
    if (n !== null) trash.push(n)
  }
  if (items.length === 0) return { items: cloneDefaults(), trash, fromDefaults: true }
  return { items, trash, fromDefaults: false }
}

const saveStore = async (projectDir, store) => {
  const items = []
  for (const it of Array.isArray(store.items) ? store.items : []) {
    const n = normItem(it, 'd' + String(items.length + 1))
    if (n === null) continue
    n.text = n.text.slice(0, MAX_TEXT)
    items.push(n)
    if (items.length >= MAX_ITEMS) break
  }
  const trash = []
  for (const it of Array.isArray(store.trash) ? store.trash : []) {
    const n = normTrash(it, 't' + String(trash.length + 1))
    if (n === null) continue
    trash.push(n)
    if (trash.length >= MAX_TRASH) break
  }
  await writeFile(pathOf(projectDir), JSON.stringify({ items, trash }, null, 2) + '\n', 'utf8')
  return { items, trash }
}

export async function readRules(projectDir) {
  return loadStore(projectDir)
}

export async function writeRules(projectDir, items) {
  const store = await loadStore(projectDir)
  const saved = await saveStore(projectDir, { items, trash: store.trash })
  return saved.items
}

/** 删一条 → 进回收站（不真删）。 */
export async function deleteRule(projectDir, id) {
  const store = await loadStore(projectDir)
  const hit = store.items.find((x) => x.id === id)
  if (hit === undefined) throw new Error('没有这条指令：' + id)
  const trash = [{ ...hit, deletedAt: new Date().toISOString() }, ...store.trash]
  return await saveStore(projectDir, { items: store.items.filter((x) => x.id !== id), trash })
}

/** 从回收站恢复一条。 */
export async function restoreRule(projectDir, id) {
  const store = await loadStore(projectDir)
  const hit = store.trash.find((x) => x.id === id)
  if (hit === undefined) throw new Error('回收站里没有这条：' + id)
  const back = { id: hit.id, side: hit.side, text: hit.text, on: true }
  return await saveStore(projectDir, { items: [...store.items, back], trash: store.trash.filter((x) => x.id !== id) })
}

/** 彻底删一条（不可恢复）。 */
export async function purgeRule(projectDir, id) {
  const store = await loadStore(projectDir)
  return await saveStore(projectDir, { items: store.items, trash: store.trash.filter((x) => x.id !== id) })
}

/** 清空回收站。 */
export async function purgeAllRules(projectDir) {
  const store = await loadStore(projectDir)
  const n = store.trash.length
  const saved = await saveStore(projectDir, { items: store.items, trash: [] })
  return { ...saved, removed: n }
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
