/**
 * 写作包组装：近处给全，远处给摘要，遇到熟人就回查。
 *
 * 规则（作者定的）：
 * 1. 最近 N 章剧情总结 —— 全文，一个字不删（写这一章最需要的就是这几章的细节）
 * 2. N 章之前的 —— 每章只给一句（核心剧情点第一条），知道大概发生了什么
 * 3. 例外：本章要出场的人物，如果在早期章节里出现过，把那些章节的总结升级成全文
 *    ——「这个人在前面干过什么」比「第 3 章大概写了什么」重要得多
 * 4. 大纲同理：本章前后几章给全字段；更远的只在提到相关人物时，带「目标 + 埋」
 * 5. 上一章正文只给结尾一段，用来接话
 *
 * 上限都留了硬顶，避免一本书写到 100 章时包又涨回去。
 */

export const PACK_POLICY = {
  /** 最近几章给全文 */
  recentSummaries: 10,
  /** 更早的章给几条核心剧情点 */
  olderSummaryLines: 1,
  /** 上一章正文给多少字（取结尾） */
  previousTailChars: 1400,
  /** 大纲节点向前后各带几章（全字段） */
  outlineWindow: 1,
  /** 因人物相关性升级为全文的早期章节，最多几章 */
  maxUpgrade: 6,
  /** 早期大纲节点里，因提到相关人物而带进来的，最多几个 */
  maxRelatedOutline: 8,
}

const clip = (text, max) => {
  const s = String(text == null ? '' : text)
  return s.length <= max ? s : s.slice(s.length - max)
}

/**
 * 从人物卡里挑出本章要用的。
 * @param {Array} people W.readPeople 的返回
 * @param {string} scanText 用来找名字的文本
 */
export function pickPeople(people, scanText) {
  const text = String(scanText == null ? '' : scanText)
  const picked = []
  const skipped = []
  for (const p of people) {
    const name = String(p.name == null ? '' : p.name).trim()
    if (name === '') continue
    // 认别名：「小陆」「陆哥」出现也算这个人要出场。
    // allNames 由上层（api.js 的 enrichPeople）算好；没有就退回只用姓名。
    const names = Array.isArray(p.allNames) && p.allNames.length > 0 ? p.allNames : [name]
    const hit = names.some((n) => String(n).length >= 2 && text.includes(String(n)))
    if (hit) {
      picked.push(p)
      continue
    }
    if (/主角|男主|女主/.test(String(p.importance == null ? '' : p.importance))) {
      picked.push(p)
      continue
    }
    skipped.push(p)
  }
  return { picked, skipped }
}

/** 取「核心剧情点」下的前几条，给早期章节做摘要 */
export function digestOf(summaryText, lines) {
  const want = Number.isInteger(lines) && lines > 0 ? lines : 1
  const out = []
  let inCore = false
  for (const raw of String(summaryText == null ? '' : summaryText).split('\n')) {
    const line = raw.trim()
    if (/^#{1,6}\s*.*核心剧情点/u.test(line)) {
      inCore = true
      continue
    }
    if (inCore) {
      if (/^#{1,6}\s/u.test(line)) break
      const m = /^[-*•]\s*(.+)$/u.exec(line)
      if (m !== null) {
        out.push(m[1].trim())
        if (out.length >= want) break
      }
    }
  }
  if (out.length > 0) return out
  const flat = String(summaryText == null ? '' : summaryText).replace(/\s+/g, ' ').trim()
  return flat === '' ? [] : [flat.slice(0, 60)]
}

export function firstPointOf(summaryText) {
  const d = digestOf(summaryText, 1)
  return d.length === 0 ? '' : d[0]
}

/**
 * 组装写作包。
 * @returns {{ pack: object, info: object, setup: string }}
 */
export async function assemblePack({
  chapter,
  setupText,
  outlineNodes,
  summaries,
  previousChapterText,
  previousChapter,
  people,
  buildPack,
  policy,
  targetChapterWords,
  projectDir,
  // 情节体检的结论：未收伏笔 + 没建卡的角色
  debts,
  missingCards,
}) {
  const P = { ...PACK_POLICY, ...(policy == null ? {} : policy) }
  const nodes = Array.isArray(outlineNodes) ? outlineNodes : []
  const sums = Array.isArray(summaries) ? summaries : []
  const folks = Array.isArray(people) ? people : []
  const openDebts = Array.isArray(debts) ? debts : []
  const noCards = Array.isArray(missingCards) ? missingCards : []

  const chapterOfNode = (n) => {
    const v = Number(n == null ? NaN : n.chapter)
    return Number.isFinite(v) ? v : null
  }

  // ── 大纲分两档 ──
  const nearNodes = nodes.filter((n) => {
    const c = chapterOfNode(n)
    return c !== null && c >= chapter - P.outlineWindow && c <= chapter + P.outlineWindow
  })
  const thisNode = nearNodes.find((n) => chapterOfNode(n) === chapter) || null
  const nextNode = nearNodes.find((n) => chapterOfNode(n) === chapter + 1) || null
  const farNodes = nodes.filter((n) => {
    const c = chapterOfNode(n)
    return c !== null && (c < chapter - P.outlineWindow || c > chapter + P.outlineWindow)
  })

  // ── 剧情总结分三档 ──
  const ordered = sums.slice().sort((a, b) => Number(a.chapter) - Number(b.chapter))
  const recentCut = chapter - P.recentSummaries
  const recentSums = ordered.filter((s) => Number(s.chapter) >= recentCut && Number(s.chapter) < chapter)
  const olderSums = ordered.filter((s) => Number(s.chapter) < recentCut)

  // ── 人物：先定「这一章谁会出场」 ──
  const nodeText = (n) => (n === null ? '' : JSON.stringify(n))
  const lastRecent = recentSums.length === 0 ? null : recentSums[recentSums.length - 1]
  const scanText = [
    String(setupText == null ? '' : setupText),
    nodeText(thisNode),
    nodeText(nextNode),
    lastRecent === null ? '' : String(lastRecent.text == null ? '' : lastRecent.text),
  ].join('\n')
  const { picked, skipped } = pickPeople(folks, scanText)
  const names = picked.map((p) => String(p.name).trim()).filter((n) => n !== '')

  // 回查名单：只放配角。
  // 主角几乎每章都在，拿他去做「早期章节相关性」判断，会把所有旧章都升级成全文，
  // 越写越贵、正好背离初衷。配角才是「这次又出现了，得回去看看他上次干了什么」的信号。
  const sideNames = picked
    .filter((p) => !/主角|男主|女主/.test(String(p.importance == null ? '' : p.importance)))
    .map((p) => String(p.name).trim())
    .filter((n) => n !== '')

  /**
   * 大纲里「埋：」后面往往是整句，解析器按标点切开会留下碎片：
   * 「脖子上的浅旧疤（来历不明」和「他自己说不上来）」本来是同一句。
   * 碎片对写稿没用，反而干扰，这里滤掉。
   */
  const tidyDebtName = (raw) => {
    const t = String(raw == null ? '' : raw).trim()
    if (t.length < 5) return ''
    if (/^[）)】」』"'"'、，,。.；;：:…—]/u.test(t)) return ''
    const open = (t.match(/[（(]/gu) || []).length
    const close = (t.match(/[）)]/gu) || []).length
    if (open !== close) return ''
    if (/^["'"'"]/u.test(t) && !/["'"'"]$/u.test(t)) return ''
    return t
  }

  // 伏笔只挑和本章沾边的：本章人物名出现在伏笔文本里，或已经欠了很久
  const debtLines = openDebts
    .filter((d) => {
      if (d === null || typeof d !== 'object') return false
      if (Number.isInteger(d.paidChapter)) return false
      const text = tidyDebtName(d.name)
      if (text === '') return false
      const hitPerson = sideNames.length > 0 && sideNames.some((n) => text.includes(n))
      const overdue = Number(d.openChapters == null ? 0 : d.openChapters) >= 10
      return hitPerson || overdue
    })
    .map((d) => ({ ...d, name: tidyDebtName(d.name) }))
    .sort((a, b) => Number(b.openChapters || 0) - Number(a.openChapters || 0))
    .slice(0, 12)

  // ── 早期总结：提到相关人物的升级成全文 ──
  const upgraded = []
  const digested = []
  if (sideNames.length === 0) {
    digested.push(...olderSums)
  } else {
    for (const s of olderSums) {
      const t = String(s.text == null ? '' : s.text)
      if (sideNames.some((n) => t.includes(n))) upgraded.push(s)
      else digested.push(s)
    }
  }
  // 升级太多会失控：只保留离现在最近的几章，其余退回摘要
  upgraded.sort((a, b) => Number(b.chapter) - Number(a.chapter))
  const upKept = upgraded.slice(0, P.maxUpgrade).sort((a, b) => Number(a.chapter) - Number(b.chapter))
  const upDropped = upgraded.slice(P.maxUpgrade)
  if (upDropped.length > 0) {
    digested.push(...upDropped)
    digested.sort((a, b) => Number(a.chapter) - Number(b.chapter))
  }

  // 摘要组装
  const digestSums = digested.map((s) => {
    const lines = digestOf(s.text, P.olderSummaryLines)
    return {
      chapter: s.chapter,
      text: ['# 第' + String(s.chapter) + '章（早前，只给要点）', '', ...lines.map((x) => '- ' + x)].join('\n'),
    }
  })

  // 最终给模型的总结：早前摘要 → 升级全文 → 近 10 章全文（时间顺序）
  // full: true 告诉 pack.js「这章给全部剧情点，别压成 5 条」
  const usedSums = [
    ...digestSums,
    ...upKept.map((s) => ({ chapter: s.chapter, text: s.text, full: true })),
    ...recentSums.map((s) => ({ chapter: s.chapter, text: s.text, full: true })),
  ]

  // ── 远期大纲：只在提到相关人物时带「目标 + 埋」 ──
  const relatedFar = []
  if (sideNames.length > 0) {
    for (const n of farNodes) {
      const raw = JSON.stringify(n)
      if (!sideNames.some((name) => raw.includes(name))) continue
      relatedFar.push({
        chapter: chapterOfNode(n),
        title: n.title === undefined ? '' : n.title,
        goal: n.goal === undefined ? '' : n.goal,
        plant: n.plant === undefined ? '' : n.plant,
        note: '（此节点因提到本章相关人物而带回，只给目标与埋点）',
      })
    }
    relatedFar.sort((a, b) => Math.abs(Number(a.chapter) - chapter) - Math.abs(Number(b.chapter) - chapter))
  }
  const relatedKept = relatedFar.slice(0, P.maxRelatedOutline)
  const allNodes = [...nearNodes, ...relatedKept]

  // ── 上一章正文：只取结尾 ──
  const prevFull = String(previousChapterText == null ? '' : previousChapterText)
  const prevTail = clip(prevFull, P.previousTailChars)

  const pack = await buildPack({
    projectDir,
    chapter,
    people: picked,
    outlineNodes: allNodes,
    summaries: usedSums,
    previousChapterText: prevTail,
    previousChapter,
    setupText,
    targetChapterWords,
    debts: debtLines,
    missingCards: noCards,
  })

  const info = {
    chapter,
    packChars: pack.chars === undefined ? 0 : pack.chars,
    setupChars: String(setupText == null ? '' : setupText).length,
    outline: {
      near: nearNodes.length,
      related: relatedKept.length,
      total: nodes.length,
      window: P.outlineWindow,
    },
    summaries: {
      recent: recentSums.length,
      upgraded: upKept.length,
      upgradedChapters: upKept.map((s) => Number(s.chapter)),
      digested: digestSums.length,
      total: sums.length,
    },
    previous: { used: prevTail.length, original: prevFull.length },
    plotBrief: { debts: debtLines.length, debtsTotal: openDebts.length, missingCards: noCards.length },
    people: {
      used: picked.map((p) => p.name),
      sideNames,
      usedCount: picked.length,
      skippedCount: skipped.length,
      total: folks.length,
    },
  }
  return { pack, info, setup: setupText }
}
