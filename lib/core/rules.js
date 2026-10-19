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
 * 出厂指令：禁止 14 条 + 要做 17 条。
 *
 * 不是某个题材的口味，而是「AI 写小说最容易犯的错」的清单——
 * 套路化、扁平人设、书面化对话、逻辑生硬、空洞文笔。
 *
 * 其中 4 条是拿第13章做过 A/B 对照后补的（同一章、同方向、只差指令开关）：
 * 不解释动机、旁白不说教、明喻不超三处、结尾不抒情不点题；
 * 以及「段落 35–45 字」「情绪落到具体的东西上」这两条做法。
 */
export const DEFAULT_RULES = [
  ...DONT([
    '摒弃套路：不堆空洞华丽的辞藻，不刻意煽情，不强行升华；不为凑字数写冗余描写，不为冲突而制造冲突。',
    '不写全能主角和工具人配角：主角不许全程无失误、一路开挂，配角不许全程无脑衬托主角。',
    '不靠降智巧合和强行反转推进：不用「重生必复仇」「穿越必开挂」「偶遇必一见钟情」这类套路。',
    '不直白点明情绪：不写「他很伤心」「他很愤怒」「他心里发闷」，也不用「他冷冷地说」「他温柔地道」标注语气。',
    '不直白描写外貌：不写「他有一双深邃的眼眸，高挺的鼻梁，完美的唇形」，外貌靠细节侧面烘托。',
    '不用 AI 通用过渡句：「光阴似箭，日月如梭」「话说彼时」这类。',
    '不写总结式收尾：不出现「从此以后」「而这一切才刚开始」这类句子。',
    '不解释动机：不写「他这么做是因为…」「原来是为了…」，动机让读者从动作和话里看出来。',
    '旁白不说教：不写「他终于懂得」「他明白了一个道理」「人总是这样」这类替读者总结人生的话。',
    '对话不说教：不许人物说不符合自身身份的哲理金句，不许长篇大论讲道理。',
    '不堆成语与华丽形容词：不用「心如刀割」「泪如雨下」这类俗套比喻拟人。',
    '明喻不超三处：「像／像是／仿佛／似乎／宛如」一章之内最多三次，不连着用。',
    '不过度描写环境、服饰、道具：所有细节必须为人物或情节服务，不为好看而铺排。',
    '结尾不抒情不点题：最后一段不写象征性动作，也不替读者下结论，落到一件具体的事或一句话上就停。',
  ]),
  ...DO([
    '人设真实：每个人都要有性格缺陷、小习惯、潜意识反应和过往经历留下的烙印。',
    '赋予缺陷：主角要有贴合人设的性格缺陷、心结或小毛病（抠手指、生气时沉默、挑食、路痴），并且真的影响情节和人际关系。',
    '配角独立：配角有自己的人生逻辑、私心杂念和情绪波动，不是只为主角服务；说话做事都有自身动机。',
    '间接表达情绪：用微动作、眼神、语气、肢体反应传递（攥紧的手指、沙哑的语气、泛红的眼角）。',
    '情绪落到具体的东西上：写他手里攥着的东西、桌上吃剩的半瓣橘子、鞋跟敲地的声音，代替形容词。',
    '语言贴合身份：文化水平、性格、身份不同，说话方式就不同；文化水平低的角色不文绉绉，内敛的角色不长篇大论。',
    '逻辑自洽：每个转折都有前置伏笔，符合人物动机与世界观逻辑；每个人的选择都要贴合其性格与过往。',
    '细节饱满：用生活化细节与服务情节的感官细节撑住场面，多写主角视角的所见所听所触所闻。',
    '风格统一：全书保持同一套文风，有烟火气和真实质感，看不出是 AI 写的。',
    '控制节奏：不全程高能无停顿，适当留白；插入吃饭、发呆、和熟人闲聊这类闲笔，让故事有呼吸感。',
    '段落 35–45 字：一个意思合成一段，不写一句话一行；对白按人换气，一个人说的话单独成段。',
    '对话真实口语化：不用完整长句；要有语气词、停顿、口癖、打断和重复。',
    '对话短句为主：每句短，像真人当面说话。',
    '允许废话：不要求句句推动情节，允许聊天气、聊饭菜、抱怨小事的闲话，让对话有生活气。',
    '文字质朴：叙述简洁克制；想写悲伤就写他攥紧的手、沙哑的语气、脚下踢走的小石子。',
    '不追爽文节奏：不是每段都要爽点、每章都要冲突；该慢的时候敢慢。',
    '写景写物时有人的动作：读者要能同时知道人物在干什么、在想什么。',
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
