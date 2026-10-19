/**
 * dsh-novel-studio — 指令（硬约束）
 *
 * 为什么要有这一层：偏好档案是「这本书的口味」，靠模型从成品小说里学，
 * 一开始是空的；而作者第一次开写时最需要的是**不许犯的错**。
 * 指令就是这个底线：不看题材、每写一章都必须照做，用户可自行增删。
 *
 * 存哪儿：<作品>/.dsh-novel-studio/指令.json
 * 形状：{ items: [{ id, group, text, on }] }
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RULES_NAME = '指令.json'

const mk = (group, list) => list.map((text, i) => ({ id: 'd' + String(i + 1), group, text, on: true }))

/**
 * 出厂指令：分四组、共 25 条。
 *
 * 这不是某个题材的口味，而是「AI 写小说最容易犯的错」的清单——
 * 套路化、扁平人设、书面化对话、逻辑生硬、空洞文笔。新书第一次开写就靠它兜底。
 */
export const DEFAULT_RULES = [
  ...mk('一、全场景通用', [
    '摒弃套路：不堆空洞华丽的辞藻，不刻意煽情，不强行升华；不为凑字数写冗余描写和无意义的华丽修辞，不为冲突而制造冲突。',
    '人设真实：不写全能主角和工具人配角；每个人都要有性格缺陷、小习惯、潜意识反应和过往经历留下的烙印。',
    '逻辑自洽：不靠降智巧合和强行反转推进；每个转折都有前置伏笔，符合人物动机与世界观逻辑。',
    '细节饱满：用生活化细节与感官细节撑住场面，对话贴真实口语，情绪表达克制自然。',
    '风格统一：全书保持同一套文风，有烟火气和真实质感，看不出是 AI 写的。',
  ]),
  ...mk('二·1 人物塑造', [
    '赋予缺陷：主角必须有贴合人设的性格缺陷、心结或小毛病（紧张时抠手指、生气时沉默、挑食、路痴），并且真的影响情节推进和人际关系。',
    '配角独立：配角有自己的人生逻辑、私心杂念和情绪波动，不是只为主角服务；说话做事都有自身动机。',
    '间接表达情绪：不写「他很伤心」，用微动作、眼神、语气、肢体反应传递（攥紧的手指、沙哑的语气、泛红的眼角）。',
    '语言贴合身份：文化水平、性格、身份不同，说话方式就不同；文化水平低的角色不文绉绉，内敛的角色不长篇大论。',
  ]),
  ...mk('二·2 对话描写', [
    '真实口语化：对话不用完整长句，不生硬说教；要有语气词、停顿、口癖、打断和重复。',
    '短句为主：每句对话短，像真人当面说话。',
    '允许废话：不要求句句推动情节，允许聊天气、聊饭菜、抱怨小事的闲话，让对话有生活气。',
    '拒绝说教：对话里不许有说教意味，不许让人物说出不符合自身身份的哲理金句。',
  ]),
  ...mk('二·3 情节与节奏', [
    '反烂俗套路：不用「重生必复仇」「穿越必开挂」「偶遇必一见钟情」这类套路情节。',
    '合理铺垫：每个转折都有前置铺垫与细节暗示，每个人的选择都要贴合其性格与过往经历。',
    '控制节奏：不全程高能无停顿，适当留白；插入吃饭、发呆、和熟人闲聊这类闲笔，让故事有呼吸感。',
  ]),
  ...mk('二·4 文笔与叙述', [
    '重细节轻抒情：想写悲伤不写「他很伤心」，写他攥紧的手、沙哑的语气、脚下踢走的小石子。',
    '感官体验：少用全知视角交代，多用主角视角的所见所听所触所闻传递信息。',
    '文字质朴：叙述简洁克制，不堆成语与华丽形容词，不用「心如刀割」「泪如雨下」这类俗套比喻拟人。',
    '拒绝过度描写：环境、服饰、道具的描写必须为人物或情节服务，不铺排。',
  ]),
  ...mk('三、避坑禁令', [
    '禁用 AI 通用过渡句：「光阴似箭，日月如梭」「话说彼时」这类。',
    '禁止直白描写外貌：不写「他有一双深邃的眼眸，高挺的鼻梁，完美的唇形」，外貌靠细节侧面烘托。',
    '禁止主角光环：主角不许全程无失误、无挫折、一路开挂；配角不许全程无脑衬托主角。',
    '禁止快餐爽文模式：不是每段都要爽点、每章都要冲突。',
    '禁止机械情绪表达：不用「他冷冷地说」「他温柔地道」，情绪靠对话本身和微动作传递。',
  ]),
]

const MAX_ITEMS = 120
const MAX_TEXT = 300

const pathOf = (projectDir) => join(projectDir, '.dsh-novel-studio', RULES_NAME)

const clean = (raw) => String(raw === undefined || raw === null ? '' : raw).replace(/\r\n/g, '\n').trim()

const cloneDefaults = () => DEFAULT_RULES.map((x) => ({ ...x }))

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
      out.push({
        id: String(it.id === undefined ? 'd' + String(out.length + 1) : it.id),
        group: clean(it.group),
        text: body,
        on: it.on !== false,
      })
    }
    if (out.length === 0) return { items: cloneDefaults(), fromDefaults: true }
    return { items: out, fromDefaults: false }
  } catch {
    return { items: cloneDefaults(), fromDefaults: true }
  }
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
      group: clean(it.group),
      text: body,
      on: it.on !== false,
    })
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
 *
 * 编号是连续的（跨组一直往下数），组名只当小标题——
 * 这样「第 8 条」在作者和模型嘴里指的是同一条。
 */
export function rulesBlock(items) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x.on !== false && clean(x.text) !== '')
  if (list.length === 0) return ''
  const lines = ['', '【写作指令（硬约束）】', '']
  let n = 0
  let group = null
  for (const item of list) {
    const g = clean(item.group)
    if (g !== '' && g !== group) {
      if (group !== null) lines.push('')
      lines.push('〔' + g + '〕')
      group = g
    }
    n += 1
    lines.push(String(n) + '. ' + clean(item.text))
  }
  lines.push(
    '',
    '以上指令是作者定的硬约束，优先级高于写作包里的建议与风格说明：**每一条都必须遵守**。',
    '与写作包里任何写法冲突时，以这里为准。',
  )
  return lines.join('\n')
}
