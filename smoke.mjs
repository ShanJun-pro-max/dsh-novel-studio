/**
 * 功能冒烟：用真实的 api 跑一遍只读操作，抓 handler 里的运行时错误。
 * 只读，不改任何文件。
 */
import { pathToFileURL } from 'node:url'

const ROOT = new URL('.', import.meta.url).href
const { createContext } = await import(ROOT + 'lib/server/context.js')
const { createApi } = await import(ROOT + 'lib/server/api.js')

const P = 'D:/18708/Documents/deepseek harness小说'
const api = createApi(createContext({ cfg: () => ({ projectDir: P, candidateDir: P, enabled: true, targetChapterWords: 2500 }), saveConfig: async () => {} }), {})

const calls = [
  ['state', {}],
  ['files.checklist', {}],
  ['files.dirs', {}],
  ['rules.get', {}],
  ['trash.list', {}],
  ['types.trashList', {}],
  ['profile.get', {}],
  ['drafts.list', {}],
  ['plot.analysis', {}],
  ['people.index', {}],
  ['summary.headsMissing', {}],
  ['consistency.check', { deep: false }],
  ['newchapter.status', { chapter: 12 }],
  ['newchapter.brief', { chapter: 13 }],

  ['setup.get', { chapter: 12 }],
  ['pack.preview', { chapter: 12 }],
]

let ok = 0
const bad = []
for (const [name, body] of calls) {
  const fn = api[name]
  if (typeof fn !== 'function') {
    bad.push(name + '：接口不存在')
    continue
  }
  try {
    const r = await fn(body)
    if (r === null || typeof r !== 'object' || r.ok !== true) bad.push(name + '：返回异常 ' + JSON.stringify(r).slice(0, 80))
    else {
      ok += 1
      const brief = Object.keys(r).filter((k) => k !== 'ok').slice(0, 4).join(',')
      console.log('  ✓ ' + name.padEnd(18) + brief)
    }
  } catch (e) {
    bad.push(name + '：' + String(e.message).slice(0, 120))
  }
}
// 开章体检那几块数据：张力曲线 / 结构问题 / 下一章往哪写 / 这一章要注意
const brief = await api['newchapter.brief']({ chapter: 13 })
const briefProblems = []
if (brief.tension === undefined || !Array.isArray(brief.tension.points)) briefProblems.push('张力曲线缺 points')
if (!Array.isArray(brief.issues)) briefProblems.push('结构问题缺 issues')
if (!Array.isArray(brief.checklist)) briefProblems.push('这一章要注意缺 checklist')
if (!Array.isArray(brief.debts)) briefProblems.push('欠账缺 debts')
if (!Array.isArray(brief.pacing)) briefProblems.push('节奏简报缺 pacing')
const total = calls.length + 1
if (briefProblems.length === 0) {
  ok += 1
  const nStruct = brief.issues.filter((x) => x.level !== 'ok').length
  const nAttn = brief.checklist.filter((x) => x.ok !== true).length
  console.log('  ✓ ' + '开章体检四块'.padEnd(18) + '张力 ' + brief.tension.points.length + ' 章 / 结构问题 ' + nStruct + ' 项 / 注意 ' + nAttn + ' 条待补 / 欠账 ' + brief.debts.length + ' 条')
} else {
  bad.push('开章体检：' + briefProblems.join('、'))
}

console.log(`\n接口合计 ${total}，通过 ${ok}，失败 ${bad.length}`)
for (const b of bad) console.log('  ✗ ' + b)

// 顺带看一眼写稿提示词里指令块还在不在
const RULES = await import(ROOT + 'lib/core/rules.js')
const DRAFT = await import(ROOT + 'lib/core/draft.js')
const r = await RULES.readRules(P)
const block = RULES.rulesBlock(r.items)
const prompt = DRAFT.buildDraftPrompt({ pack: '# 测试写作包\n\n② 偏好\n- 已验证：短句', direction: { letter: 'A', name: '测试', detail: 'x' }, others: [], chapter: 1 })
const full = prompt.text + '\n' + block
console.log(`\n指令：${r.items.length} 条（启用 ${RULES.activeCount(r.items)}），提示词块 ${block.length} 字`)
console.log('提示词末尾带指令 =', full.trim().endsWith('与写作包里任何写法冲突时，以这里为准。'))
process.exit(bad.length === 0 ? 0 : 1)
