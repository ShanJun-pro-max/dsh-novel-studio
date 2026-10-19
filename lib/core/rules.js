/**
 * dsh-novel-studio — 指令（硬约束）
 *
 * 为什么要有这一层：偏好档案是「这本书的口味」，靠模型从成品小说里学，
 * 一开始是空的；而作者第一次开写时最需要的是**不许犯的错**。
 * 指令就是这个底线：不看题材、每写一章都必须照做，用户可自行增删。
 *
 * 存哪儿：<作品>/.dsh-novel-studio/指令.json
 * 形状：{ items: [{ id, text, on }] }
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RULES_NAME = '指令.json'

/** 第一次用时的出厂指令：都是「AI 最容易犯、作者最常返工」的那几类。 */
export const DEFAULT_RULES = [
  '不解释动机：不写「他这么做是因为…」「原来是为了…」，让读者自己看出来。',
  '情绪不直接命名：不写「他很愤怒」「她心里一沉」，用动作、物件、话头承载。',
  '不用身体感受代替情节推进：心跳加速、呼吸一滞、血液沸腾、后背发凉这类描写，一章最多一处，且不能顶替事件。',
  '每段至少有一个具体的东西或动作，不写纯氛围空镜。',
  '对白按人分层，一个人一段；不用「他说道」「她问道」堆提示语，靠动作和语气区分是谁在说。',
  '不写总结式收尾：不出现「从此以后」「这就是…的开始」「而这一切才刚开始」这类句子。',
  '不堆比喻：明喻一章不超过三处，不连用「仿佛／似乎／宛如」。',
  '人称与时间线不跳：不随意插叙，除非这一章的结构需要；同一段里不混过去和现在。',
  '不复述设定：读者已经知道的世界观、人物关系不重复交代。',
  '段落长短交错：不整章都是三五行一断的碎段，也不整段两百字一口气到底。',
].map((text, i) => ({ id: 'd' + String(i + 1), text, on: true }))

const MAX_ITEMS = 80
const MAX_TEXT = 300

const pathOf = (projectDir) => join(projectDir, '.dsh-novel-studio', RULES_NAME)

const clean = (raw) => String(raw === undefined || raw === null ? '' : raw).replace(/\r\n/g, '\n').trim()

/** 读指令；文件不存在时返回出厂指令（不落盘，交给用户决定要不要改）。 */
export async function readRules(projectDir) {
  try {
    const text = await readFile(pathOf(projectDir), 'utf8')
    const data = JSON.parse(text)
    const items = Array.isArray(data === null || data === undefined ? null : data.items) ? data.items : []
    const out = []
    for (const it of items) {
      if (it === null || typeof it !== 'object') continue
      const body = clean(it.text)
      if (body === '') continue
      out.push({ id: String(it.id === undefined ? 'd' + String(out.length + 1) : it.id), text: body, on: it.on !== false })
    }
    if (out.length === 0) return { items: DEFAULT_RULES.map((x) => ({ ...x })), fromDefaults: true }
    return { items: out, fromDefaults: false }
  } catch {
    return { items: DEFAULT_RULES.map((x) => ({ ...x })), fromDefaults: true }
  }
}

export async function writeRules(projectDir, items) {
  const list = []
  const list2 = Array.isArray(items) ? items : []
  for (const it of list2) {
    if (it === null || typeof it !== 'object') continue
    const body = clean(it.text).slice(0, MAX_TEXT)
    if (body === '') continue
    list.push({ id: String(it.id === undefined ? 'd' + String(list.length + 1) : it.id), text: body, on: it.on !== false })
    if (list.length >= MAX_ITEMS) break
  }
  await writeFile(pathOf(projectDir), JSON.stringify({ items: list }, null, 2) + '\n', 'utf8')
  return list
}

/** 只要启用的那几条，保持顺序。 */
export function activeRules(items) {
  const list = Array.isArray(items) ? items : []
  return list.filter((x) => x.on !== false && clean(x.text) !== '').map((x) => clean(x.text))
}

/**
 * 拼成写进提示词的一段。
 *
 * 位置很关键：放在**最后**，紧挨着「请写出…」那句。
 * 写作包三四千字，塞在中间会被后面的大纲、前情冲淡。
 */
export function rulesBlock(items) {
  const list = activeRules(items)
  if (list.length === 0) return ''
  return [
    '',
    '【写作指令（硬约束）】',
    '',
    ...list.map((rule, i) => String(i + 1) + '. ' + rule),
    '',
    '以上指令是作者定的硬约束，优先级高于写作包里的建议与风格说明：**每一条都必须遵守**。',
    '与写作包里任何写法冲突时，以这里为准。',
  ].join('\n')
}
