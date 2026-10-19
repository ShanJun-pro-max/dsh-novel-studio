/**
 * 业务 API：所有操作都挂在一个对象上，由入口按 `body.a` 分发。
 *
 * 为什么用单端点：原来的插件给每个动作注册一个 HTTP 路由，几十个路由散在各处，
 * 加一个功能就要多改一处。这里统一成 `POST /api` + `{ a: '模块.动作' }`，
 * 后端只注册一个路由，新增功能只加一个方法。
 */
import { join, dirname, extname, basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { readFile, writeFile, mkdir, rename, rm, readdir, stat, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import * as W from '../core/workspace.js'
import * as DRAFT from '../core/draft.js'
import * as PACK from '../core/pack.js'
import * as PIPE from '../core/pipeline.js'
import * as PLOT from '../core/plot.js'
import * as RULES from '../core/rules.js'
import { assemblePack } from './pack-assemble.js'
import { readNovelFile, chunkNovel, outlineOf } from './novel-import.js'
import {
  SCAN_SYSTEM,
  SCAN_SYSTEM_TAIL,
  DIGEST_SYSTEM,
  SUMMARIZE_SYSTEM,
  buildScanInput,
  parseScan,
  parseDigest,
  buildSummarizeInput,
  parseSummaryReport,
  dedupeProfile,
} from './novel-learn.js'
import { SUMMARY_SYSTEM, buildSummaryUser, cleanSummaryOutput, parseSummary, sectionList } from './summary.js'
import { callModel, resolveRoute, finishReason } from '../core/llm.js'
import {
  DISTILL_SYSTEM,
  DISTILL_LIMITS,
  parseDistillOutput,
  buildDistillInput,
  mergeRulesIntoProfile,
} from './distill.js'
import { charCount, splitSegments, readTextSafe, readJsonSafe, statSafe } from '../core/text.js'
import {
  PROFILE_FILE,
  BOOK_CONF,
  TRASH_DIR,
  TRASH_DRAFT_SUB,
  STATE_DIR,
  typesRoot,
  safeTypeName,
  safeFileName,
  stampNow,
  readdir as _readdir,
} from './context.js'

// 同一路径的写入串行化：连点保存时，后一次不会踩到前一次半写完的文件。
const writeQueues = new Map()
const enqueueWrite = (path, task) => {
  const key = String(path)
  const prev = writeQueues.get(key) ?? Promise.resolve()
  const next = prev.then(task, task)
  writeQueues.set(
    key,
    next.catch(() => {}),
  )
  next
    .finally(() => {
      if (writeQueues.get(key) === next) writeQueues.delete(key)
    })
    .catch(() => {})
  return next
}
/** 候选目录里那份标注文件 */
const marksPathOf = (dir) => join(dir, STATE_DIR, 'marks.json')

const readMarks = async (dir) => {
  const data = await readJsonSafe(marksPathOf(dir))
  return data !== null && typeof data === 'object' ? data : {}
}

const writeMarks = async (dir, marks) => {
  await mkdir(dirname(marksPathOf(dir)), { recursive: true })
  await writeFile(marksPathOf(dir), JSON.stringify(marks, null, 2) + '\n', 'utf8')
}

/**
 * 合稿勾选单独存一份。
 *
 * 以前 👍 一个动作管两件事：喂偏好档案 + 进合稿。但「这句写得漂亮」和
 * 「这段我要用」不是一回事——一句好句子可能来自一个不选它做本章的候选稿。
 * 所以勾选拆出来：picks.json 决定进不进合稿，👍/👎 只决定喂不喂偏好。
 *
 * 兼容：picks.json 不存在时，退回按 good 标注推导（老数据行为不变）。
 */
const picksPathOf = (dir) => join(dir, STATE_DIR, 'picks.json')

const readPicks = async (dir) => {
  const data = await readJsonSafe(picksPathOf(dir))
  return data !== null && typeof data === 'object' ? data : null
}

const writePicks = async (dir, picks) => {
  await mkdir(dirname(picksPathOf(dir)), { recursive: true })
  await writeFile(picksPathOf(dir), JSON.stringify(picks, null, 2) + '\n', 'utf8')
}

/**
 * 被勾选进合稿的段落，按稿件顺序。
 *
 * 只认 picks.json（勾选框）。**不再**从 👍 推导——
 * 作者明确：勾选才是合稿材料，👍/👎 只喂偏好档案。老数据里
 * 只有 marks 没有 picks 的章，合稿会提示「还没有勾选任何段落」，
 * 按提示勾一遍即可，不会静默把 👍 当成选中。
 */
const picksOf = async (dir, candidates) => {
  const picked = await readPicks(dir)
  const picks = []
  if (picked === null) return picks
  for (const c of candidates) {
    const listed = picked[c.name]
    if (!Array.isArray(listed)) continue
    const idxs = listed.filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b)
    for (const i of idxs) {
      const text = c.segments[i]
      if (text === undefined) continue
      picks.push({ file: c.name, index: i, text })
    }
  }
  return picks
}

/** 读一整个候选目录：每篇的分段 + 标注 */
const readCandidateDir = async (dir) => {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const marks = await readMarks(dir)
  const pickedData = await readPicks(dir)
  const out = []
  for (const e of entries) {
    if (!e.isFile() || extname(e.name).toLowerCase() !== '.txt') continue
    const text = await readTextSafe(join(dir, e.name))
    const segments = splitSegments(text)
    const entry = marks[e.name]
    const segMarks = segments.map((_, i) => {
      const v = entry !== null && entry !== undefined && typeof entry === 'object' ? entry[String(i)] : undefined
      return v === 'good' ? 'good' : v === 'bad' ? 'bad' : ''
    })
    // 合稿勾选：独立于 👍/👎，只认 picks.json。
    // 不再回退「👍 即勾选」——那会把标注和取材混成一件事。
    const listed = pickedData === null ? undefined : pickedData[e.name]
    let segPicks
    if (Array.isArray(listed)) {
      const set = new Set(listed)
      segPicks = segments.map((_, i) => set.has(i))
    } else {
      segPicks = segments.map(() => false)
    }
    const info = await statSafe(join(dir, e.name))
    out.push({
      name: e.name,
      path: join(dir, e.name),
      text,
      segments,
      segMarks,
      segPicks,
      picksMode: pickedData !== null,
      chars: charCount(text),
      bytes: info.bytes,
      mtime: info.mtime,
      goodCount: segMarks.filter((m) => m === 'good').length,
      badCount: segMarks.filter((m) => m === 'bad').length,
      pickCount: segPicks.filter(Boolean).length,
    })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

/**
 * 建 API。
 * @param {object} cx createContext 的返回值
 */
export function createApi(cx, hostCtx) {
  const ensureProject = () => cx.requireProject()

  // ══════════════════════════════════════════════════════════
  // 全局状态
  // ══════════════════════════════════════════════════════════
  const state = async (body) => {
    // force=true 时丢掉 30 秒项目缓存——「刷新」按钮要真的重读磁盘，
    // 否则外部改过文件后点刷新看不出任何变化。
    if (body !== null && body !== undefined && body.force === true) cx.resetProject()
    const project = await cx.projectOf(false)
    const dir = cx.dirOf()
    const cfg = cx.cfg()
    if (project === null) {
      return {
        ok: true,
        project: null,
        candidateDir: dir,
        config: {
          candidateDir: cfg.candidateDir,
          projectDir: cfg.projectDir,
          targetChapterWords: cfg.targetChapterWords,
          readFontSize: cfg.readFontSize === undefined ? 13.5 : cfg.readFontSize,
          uiScale: cfg.uiScale === undefined ? 1 : cfg.uiScale,
        },
        hint: dir === '' ? '先选一个候选目录，或在设置里填作品根' : '候选目录已设，但还没认出作品根',
        chapters: [],
        totals: { chapters: 0, chars: 0, words: 0 },
        profile: { text: '', path: '', chars: 0, type: '' },
        types: [],
      }
    }
    const ws = await W.readWorkspace(project.projectDir, { name: project.name, runsRoot: project.runsRoot })
    const chapters = []
    for (const r of ws.chapters || []) {
      // 自己 stat 一次，别指望 workspace 一定带 summary 字段
      const sumInfo = await statSafe(join(project.projectDir, '剧情', '第' + String(r.chapter) + '章 剧情总结.md'))
      chapters.push({
        chapter: r.chapter,
        title: r.title,
        chars: r.chars,
        status: r.status,
        path: r.path,
        hasSummary: sumInfo.exists,
      })
    }
    const totalChars = chapters.reduce((s, c) => s + (Number(c.chars) || 0), 0)

    // 偏好档案 + 类型
    const profilePath = await cx.profilePath(project.projectDir)
    const prof = await cx.readProfile(profilePath)
    const conf = await cx.readBookConf(project.projectDir)
    const currentType = typeof conf.类型 === 'string' ? conf.类型 : ''
    const typeNames = await cx.listDirs(typesRoot())
    const types = []
    for (const name of typeNames) {
      if (name.startsWith('.')) continue
      const p = cx.typeProfilePath(name)
      const info = await cx.readProfile(p)
      types.push({ name, chars: info.chars, updatedAt: info.updatedAt })
    }
    types.sort((a, b) => (a.name < b.name ? -1 : 1))

    return {
      ok: true,
      project: { dir: project.projectDir, name: project.name, source: project.source },
      candidateDir: dir,
      config: {
        candidateDir: cfg.candidateDir,
        projectDir: cfg.projectDir,
        targetChapterWords: cfg.targetChapterWords,
        readFontSize: cfg.readFontSize === undefined ? 13.5 : cfg.readFontSize,
        uiScale: cfg.uiScale === undefined ? 1 : cfg.uiScale,
      },
      chapters,
      totals: { chapters: chapters.length, chars: totalChars },
      profile: { text: prof.text, path: prof.path, chars: prof.chars, updatedAt: prof.updatedAt, type: currentType },
      types,
    }
  }

  // ══════════════════════════════════════════════════════════
  // 章节
  // ══════════════════════════════════════════════════════════
  const chapterGet = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const detail = await W.readChapter(project.projectDir, chapter)
    if (!detail.found) throw new Error(`没有第${chapter}章的正文`)
    return {
      ok: true,
      chapter,
      title: detail.title,
      file: detail.file,
      path: detail.path,
      text: detail.text,
      chars: charCount(detail.text),
      segments: splitSegments(detail.text).length,
    }
  }

  const chapterSave = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    if (typeof body.text !== 'string') throw new Error('正文必须是字符串')
    const next = body.text
    if (next.trim() === '') throw new Error('正文是空的，拒绝写入')
    const detail = await W.readChapter(project.projectDir, chapter)
    if (!detail.found) throw new Error(`没有第${chapter}章的正文`)
    // 备份原稿
    const stamp = stampNow()
    const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
    await mkdir(bakDir, { recursive: true })
    const bak = join(bakDir, `第${chapter}章 ${stamp}.txt`)
    await writeFile(bak, detail.text, 'utf8')
    await enqueueWrite(detail.path, () => writeFile(detail.path, next, 'utf8'))
    return { ok: true, chapter, chars: charCount(next), backup: bak }
  }

  const chapterDelete = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const detail = await W.readChapter(project.projectDir, chapter)
    if (!detail.found) throw new Error(`没有第${chapter}章的正文`)
    const stamp = stampNow()
    const trash = cx.trashDir(project.projectDir)
    await mkdir(trash, { recursive: true })
    const dest = join(trash, `${stamp} 第${chapter}章 ${basename(detail.path)}`)
    await rename(detail.path, dest)
    // 剧情总结一起挪走，免得前情提要里留着一个已经不存在的章
    const sum = join(project.projectDir, '剧情', `第${chapter}章 剧情总结.md`)
    let summary = ''
    if (existsSync(sum)) {
      summary = join(trash, `${stamp} 第${chapter}章 剧情总结.md`)
      await rename(sum, summary)
    }
    return { ok: true, chapter, deleted: detail.file, trash: dest, summary }
  }

  // ══════════════════════════════════════════════════════════
  // 候选稿
  // ══════════════════════════════════════════════════════════
  /** 候选稿根：.dsh-novel-studio/候选稿/第N章/ */
  const draftsRoot = (projectDir) => join(cx.stateDirOf(projectDir), '候选稿')
  const draftChapterDir = (projectDir, chapter) => join(draftsRoot(projectDir), `第${chapter}章`)

  const draftsList = async () => {
    const project = await ensureProject()
    const root = draftsRoot(project.projectDir)
    const dirs = await cx.listDirs(root)
    const groups = []
    let totalFiles = 0
    let totalBytes = 0
    for (const d of dirs) {
      const m = /第\s*([0-9]+)\s*章/u.exec(d)
      if (m === null) continue
      const chapter = Number(m[1])
      const dir = join(root, d)
      const items = await readCandidateDir(dir)
      if (items.length === 0) continue
      const brief = items.map((x) => ({
        name: x.name,
        chapter,
        bytes: x.bytes,
        mtime: x.mtime,
        chars: x.chars,
        marked: x.goodCount + x.badCount,
        good: x.goodCount,
        bad: x.badCount,
      }))
      totalFiles += brief.length
      totalBytes += brief.reduce((s, x) => s + x.bytes, 0)
      groups.push({ chapter, dir, items: brief })
    }
    groups.sort((a, b) => a.chapter - b.chapter)
    return { ok: true, root, groups, totalFiles, totalBytes }
  }

  const draftRead = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const name = safeFileName(body.name)
    const dir = draftChapterDir(project.projectDir, chapter)
    const full = join(dir, name)
    const info = await statSafe(full)
    if (!info.exists) throw new Error('候选稿不存在：' + name)
    const items = await readCandidateDir(dir)
    const hit = items.find((x) => x.name === name)
    if (hit === undefined) throw new Error('候选稿读不出来：' + name)
    return {
      ok: true,
      chapter,
      name,
      path: full,
      text: hit.text,
      segments: hit.segments,
      segMarks: hit.segMarks,
      segPicks: hit.segPicks,
      pickCount: hit.pickCount,
      chars: hit.chars,
      goodCount: hit.goodCount,
      badCount: hit.badCount,
    }
  }

  /** 标段：index 单段；whole=true 整篇 */
  const draftMark = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const name = safeFileName(body.name)
    const dir = draftChapterDir(project.projectDir, chapter)
    const info = await statSafe(join(dir, name))
    if (!info.exists) throw new Error('候选稿不存在：' + name)
    const mark = body.mark === 'good' || body.mark === 'bad' ? body.mark : null
    const text = await readTextSafe(join(dir, name))
    const segments = splitSegments(text)
    let idxs
    if (body.whole === true) {
      idxs = segments.map((_, i) => i)
    } else {
      const i = Number(body.index)
      if (!Number.isInteger(i) || i < 0 || i >= segments.length) throw new Error('段落序号不合法')
      idxs = [i]
    }
    const marks = await readMarks(dir)
    const entry = marks[name] !== undefined && typeof marks[name] === 'object' ? marks[name] : {}
    for (const i of idxs) {
      if (mark === null) delete entry[String(i)]
      else entry[String(i)] = mark
    }
    if (Object.keys(entry).length === 0) delete marks[name]
    else marks[name] = entry
    await writeMarks(dir, marks)
    const segMarks = segments.map((_, i) => {
      const v = entry[String(i)]
      return v === 'good' ? 'good' : v === 'bad' ? 'bad' : ''
    })
    return { ok: true, chapter, name, segMarks, goodCount: segMarks.filter((x) => x === 'good').length, badCount: segMarks.filter((x) => x === 'bad').length }
  }

  /**
   * 切换一段的「进不进合稿」。
   * 和 👍/👎 完全分开：那个只管偏好档案，这个只管合稿。
   */
  const draftPick = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const name = String(body.name == null ? '' : body.name).trim()
    if (name === '') throw new Error('要指定候选稿')
    const dir = draftChapterDir(project.projectDir, chapter)
    const items = await readCandidateDir(dir)
    const cand = items.find((c) => c.name === name)
    if (cand === undefined) throw new Error('候选稿不存在：' + name)
    const idx = Number(body.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= cand.segments.length) throw new Error('段号越界')

    const cur = (await readPicks(dir)) || {}
    // 第一次动勾选时，先把老数据（good 即勾选）落实成显式列表，避免一改全空
    if (cur[name] === undefined && Object.keys(cur).length === 0) {
      for (const c of items) {
        if (c.picksMode === false) {
          cur[c.name] = c.segments.map((_, i) => i).filter((i) => c.segMarks[i] === 'good')
        }
      }
    }
    const list = new Set(Array.isArray(cur[name]) ? cur[name] : [])
    const want = body.picked === true
    if (want) list.add(idx)
    else list.delete(idx)
    cur[name] = [...list].sort((a, b) => a - b)
    await writePicks(dir, cur)
    const afterPick = await readCandidateDir(dir)
    const cPick = afterPick.find((c) => c.name === name)
    return {
      ok: true,
      name,
      index: idx,
      picked: want,
      count: cur[name].length,
      segPicks: cPick === undefined ? [] : cPick.segPicks,
      pickCount: cPick === undefined ? 0 : cPick.pickCount,
    }
  }

  /** 一篇候选稿的勾选：全勾 / 全不勾 */
  const draftPickAll = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const name = String(body.name == null ? '' : body.name).trim()
    if (name === '') throw new Error('要指定候选稿')
    const dir = draftChapterDir(project.projectDir, chapter)
    const items = await readCandidateDir(dir)
    const cand = items.find((c) => c.name === name)
    if (cand === undefined) throw new Error('候选稿不存在：' + name)
    const cur = (await readPicks(dir)) || {}
    if (cur[name] === undefined && Object.keys(cur).length === 0) {
      for (const c of items) {
        cur[c.name] = c.segments.map((_, i) => i).filter((i) => c.segMarks[i] === 'good')
      }
    }
    const want = body.picked === true
    cur[name] = want ? cand.segments.map((_, i) => i) : []
    await writePicks(dir, cur)
    const afterAll = await readCandidateDir(dir)
    const cAll = afterAll.find((c) => c.name === name)
    return {
      ok: true,
      name,
      picked: want,
      count: cur[name].length,
      segPicks: cAll === undefined ? [] : cAll.segPicks,
      pickCount: cAll === undefined ? 0 : cAll.pickCount,
    }
  }

  /** 合稿定稿：把这一章所有候选稿里标好的段拼起来，写进正文 */
  const draftMerge = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const dir = draftChapterDir(project.projectDir, chapter)
    const items = await readCandidateDir(dir)
    if (items.length === 0) throw new Error(`第${chapter}章还没有候选稿`)
    const picks = await picksOf(dir, items)
    if (picks.length === 0) throw new Error('这一章还没有勾选任何段落：先在候选稿里勾上要进合稿的段（左边那个方框）')
    const merged = DRAFT.mergeSelection({ picks })
    const detail = await W.readChapter(project.projectDir, chapter)
    const title = detail.found ? detail.title : ''
    const normalized = DRAFT.normalizeChapterText(merged.text, { chapter, title })
    // 备份原稿
    let backup = ''
    if (detail.found && detail.text.trim() !== '') {
      const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
      await mkdir(bakDir, { recursive: true })
      backup = join(bakDir, `第${chapter}章 ${stampNow()}.txt`)
      await writeFile(backup, detail.text, 'utf8')
    }
    let target = detail.found ? detail.path : ''
    if (!detail.found) {
      // 新章落盘：文件名必须带「第」和章号，否则章节解析认不出来
      //（v2.21.1 及以前写成 `012章-未命名.txt`，结果合稿完在章节页「不见了」）。
      const head = String(normalized).split('\n')[0].replace(/^第\s*\d+\s*章/u, '').trim()
      const nameTitle = (head !== '' ? head : title !== '' ? title : '未命名').replace(/[\\/:*?"<>|]/gu, '').slice(0, 40)
      target = join(project.projectDir, '正文', `第${String(chapter).padStart(3, '0')}章-${nameTitle}.txt`)
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, normalized, 'utf8')
    // 顺手留一份合并稿
    const versionDir = join(dir, '定稿候选')
    await mkdir(versionDir, { recursive: true })
    await writeFile(join(versionDir, `第${chapter}章-合并稿.txt`), normalized, 'utf8')
    return {
      ok: true,
      chapter,
      path: target,
      backup,
      chars: charCount(normalized),
      picked: picks.length,
      created: !detail.found,
    }
  }

  const draftDelete = async (body) => {
    const project = await ensureProject()
    const list = Array.isArray(body.items) ? body.items : []
    if (list.length === 0) throw new Error('没有选中候选稿')
    const stamp = stampNow()
    const trash = cx.trashDraftDir(project.projectDir)
    await mkdir(trash, { recursive: true })
    const moved = []
    const failed = []
    for (const it of list) {
      const chapter = Number(it.chapter)
      const name = String(it.name ?? '')
      if (!Number.isInteger(chapter) || chapter <= 0 || name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
        failed.push({ name, why: '参数不合法' })
        continue
      }
      const dir = draftChapterDir(project.projectDir, chapter)
      const src = join(dir, name)
      const info = await statSafe(src)
      if (!info.exists) {
        failed.push({ name, why: '文件不存在' })
        continue
      }
      try {
        await rename(src, join(trash, `${stamp} 第${chapter}章 ${name}`))
        const marks = await readMarks(dir)
        if (marks[name] !== undefined) {
          delete marks[name]
          await writeMarks(dir, marks)
        }
        moved.push({ chapter, name })
      } catch (e) {
        failed.push({ name, why: e instanceof Error ? e.message : String(e) })
      }
    }
    return { ok: true, moved, failed, movedCount: moved.length }
  }

  // ══════════════════════════════════════════════════════════
  // 回收站（章节 + 候选稿）
  // ══════════════════════════════════════════════════════════
  /** 解析回收站文件名：`2026-10-18T12-00-00 第12章 原名.txt` */
  const parseTrashName = (name, kind) => {
    const m = /^(\S+)\s+第\s*([0-9]+)\s*章\s*(.*)$/u.exec(name)
    const isSummary = extname(name).toLowerCase() === '.md'
    if (m === null) return { name, kind, stamp: '', chapter: null, title: name, isSummary }
    const raw = m[3]
    const title = kind === 'draft' ? raw.replace(/\.txt$/iu, '') : raw.replace(/^第\s*[0-9]+\s*章[-_ ]*/u, '').replace(/\.(txt|md)$/iu, '')
    return { name, kind, stamp: m[1], chapter: Number(m[2]), title, isSummary }
  }

  const scanTrash = async (dir, kind) => {
    const files = await cx.listFiles(dir, ['.txt', '.md'])
    return files.map((f) => {
      const base = parseTrashName(f.name, kind)
      return { ...base, path: f.path, bytes: f.bytes, mtime: f.mtime }
    })
  }

  const trashList = async () => {
    const project = await ensureProject()
    const texts = await scanTrash(cx.trashDir(project.projectDir), 'text')
    const drafts = await scanTrash(cx.trashDraftDir(project.projectDir), 'draft')
    const sortByTime = (a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0)
    texts.sort(sortByTime)
    drafts.sort(sortByTime)
    const files = await scanTrashFiles(project.projectDir)
    files.sort(sortByTime)
    return { ok: true, trash: cx.trashDir(project.projectDir), texts, drafts, files }
  }

  // ── 设定文件那一栏 ────────────────────────────────────────
  const trashFilesDirOf = (projectDir) => join(cx.stateDirOf(projectDir), '回收站', '设定文件')
  const trashFilesIndexOf = (projectDir) => join(trashFilesDirOf(projectDir), '索引.json')

  /** 读「回收站/设定文件/索引.json」：{ 回收站文件名: { rel, at } } */
  const readTrashFilesIndex = async (projectDir) => {
    const data = await readJsonSafe(trashFilesIndexOf(projectDir))
    return data !== null && typeof data === 'object' ? data : {}
  }

  const writeTrashFilesIndex = async (projectDir, index) => {
    await mkdir(trashFilesDirOf(projectDir), { recursive: true })
    await writeFile(trashFilesIndexOf(projectDir), JSON.stringify(index, null, 2) + '\n', 'utf8')
  }

  const scanTrashFiles = async (projectDir) => {
    const dir = trashFilesDirOf(projectDir)
    const index = await readTrashFilesIndex(projectDir)
    const list = await cx.listFiles(dir, ['.md', '.txt', '.json'])
    const out = []
    for (const f of list) {
      if (f.name === '索引.json') continue
      const hit = index[f.name]
      // 索引里没有历史记录（老版本删的）就从文件名反推：去掉时间戳，下划线还原成斜杠
      const rel = hit !== undefined && typeof hit.rel === 'string' ? hit.rel : String(f.name).replace(/^\S+\s+/u, '').replace(/_/gu, '/')
      out.push({
        kind: 'file',
        name: f.name,
        title: basename(rel),
        rel,
        path: f.path,
        bytes: f.bytes,
        mtime: f.mtime,
      })
    }
    return out
  }

  const trashBaseOf = (projectDir, kind) => (kind === 'draft' ? cx.trashDraftDir(projectDir) : cx.trashDir(projectDir))

  const trashRead = async (body) => {
    const project = await ensureProject()
    const name = safeFileName(body.name)
    const kind = String(body.kind ?? 'text') === 'draft' ? 'draft' : 'text'
    const full = join(trashBaseOf(project.projectDir, kind), name)
    const info = await statSafe(full)
    if (!info.exists) throw new Error('回收站里没有：' + name)
    const text = await readTextSafe(full)
    return { ok: true, name, kind, text, chars: charCount(text) }
  }

  const trashRestore = async (body) => {
    const project = await ensureProject()
    const name = safeFileName(body.name)
    const kind = String(body.kind ?? 'text') === 'draft' ? 'draft' : 'text'
    const src = join(trashBaseOf(project.projectDir, kind), name)
    const info = await statSafe(src)
    if (!info.exists) throw new Error('回收站里没有：' + name)
    const parsed = parseTrashName(name, kind)
    if (parsed.chapter === null) throw new Error('认不出这是第几章')

    // 候选稿：回 .dsh-novel-studio/候选稿/第N章/，同名加序号
    if (kind === 'draft') {
      const dir = draftChapterDir(project.projectDir, parsed.chapter)
      await mkdir(dir, { recursive: true })
      const original = String(/^(\S+)\s+第\s*[0-9]+\s*章\s*(.*)$/u.exec(name)?.[2] ?? name)
      let target = join(dir, original)
      let n = 2
      while (existsSync(target)) {
        const stem = original.replace(/\.txt$/iu, '')
        target = join(dir, `${stem}-恢复${n}.txt`)
        if (++n > 99) throw new Error('同名文件太多')
      }
      await rename(src, target)
      return { ok: true, kind, chapter: parsed.chapter, path: target }
    }

    // 正文 / 剧情总结
    if (parsed.isSummary) {
      const target = join(project.projectDir, '剧情', `第${parsed.chapter}章 剧情总结.md`)
      await mkdir(dirname(target), { recursive: true })
      await rename(src, target)
      return { ok: true, kind, chapter: parsed.chapter, path: target }
    }
    const detail = await W.readChapter(project.projectDir, parsed.chapter)
    if (detail.found) throw new Error(`第${parsed.chapter}章已经有正文了（${detail.file}）：先移除再恢复`)
    const title = String(/^(\S+)\s+第\s*[0-9]+\s*章\s*(.*)$/u.exec(name)?.[2] ?? '').replace(/^第\s*[0-9]+\s*章[-_ ]*/u, '').replace(/\.txt$/iu, '')
    const target = join(project.projectDir, '正文', `第${String(parsed.chapter).padStart(3, '0')}章-${title}.txt`)
    await mkdir(dirname(target), { recursive: true })
    await rename(src, target)
    return { ok: true, kind, chapter: parsed.chapter, path: target }
  }

  const trashPurge = async (body) => {
    const project = await ensureProject()
    const name = safeFileName(body.name)
    const kind = String(body.kind ?? 'text') === 'draft' ? 'draft' : 'text'
    const full = join(trashBaseOf(project.projectDir, kind), name)
    const info = await statSafe(full)
    if (!info.exists) throw new Error('回收站里没有：' + name)
    await rm(full, { force: true })
    return { ok: true, name, kind }
  }

  /** 把回收站里的设定文件还回原路径 */
  const trashRestoreFile = async (body) => {
    const project = await ensureProject()
    const name = safeFileName(body.name)
    const dir = trashFilesDirOf(project.projectDir)
    const src = join(dir, name)
    const info = await statSafe(src)
    if (!info.exists) throw new Error('回收站里没有：' + name)
    const index = await readTrashFilesIndex(project.projectDir)
    const hit = index[name]
    const rel = hit !== undefined && typeof hit.rel === 'string' ? hit.rel : String(name).replace(/^\S+\s+/u, '').replace(/_/gu, '/')
    if (rel === '' || rel.startsWith('..') || rel.includes('..')) throw new Error('这个文件的原路径不可用，只能手动取回：' + src)
    const target = join(project.projectDir, rel)
    if ((await statSafe(target)).exists) throw new Error('原位置已经有同名文件：' + rel + '（先改名或手动取回）')
    await mkdir(dirname(target), { recursive: true })
    await rename(src, target)
    delete index[name]
    await writeTrashFilesIndex(project.projectDir, index)
    return { ok: true, name, path: target, rel }
  }

  const trashPurgeFile = async (body) => {
    const project = await ensureProject()
    const name = safeFileName(body.name)
    const full = join(trashFilesDirOf(project.projectDir), name)
    const info = await statSafe(full)
    if (!info.exists) throw new Error('回收站里没有：' + name)
    await rm(full, { force: true })
    const index = await readTrashFilesIndex(project.projectDir)
    if (index[name] !== undefined) {
      delete index[name]
      await writeTrashFilesIndex(project.projectDir, index)
    }
    return { ok: true, name }
  }

  const trashPurgeAll = async () => {
    const project = await ensureProject()
    const removed = []
    const sweep = async (dir, kind) => {
      const files = await cx.listFiles(dir, ['.txt', '.md'])
      for (const f of files) {
        try {
          await rm(f.path, { force: true })
          removed.push({ kind, name: f.name })
        } catch {
          // 单个失败不影响其它
        }
      }
    }
    await sweep(cx.trashDir(project.projectDir), 'text')
    await sweep(cx.trashDraftDir(project.projectDir), 'draft')
    // 设定文件那一栏也一起清（索引文件最后删）
    const fileDir = trashFilesDirOf(project.projectDir)
    const fileList = await cx.listFiles(fileDir, ['.md', '.txt', '.json'])
    for (const f of fileList) {
      if (f.name === '索引.json') continue
      try {
        await rm(f.path, { force: true })
        removed.push({ kind: 'file', name: f.name })
      } catch {
        /* 单个失败不影响其它 */
      }
    }
    await rm(trashFilesIndexOf(project.projectDir), { force: true })
    return { ok: true, removedCount: removed.length, removed }
  }

  // ══════════════════════════════════════════════════════════
  // 偏好档案 + 类型库
  // ══════════════════════════════════════════════════════════
  const profileGet = async () => {
    const project = await ensureProject()
    const path = await cx.profilePath(project.projectDir)
    const prof = await cx.readProfile(path)
    const conf = await cx.readBookConf(project.projectDir)
    return { ok: true, text: prof.text, path, chars: prof.chars, updatedAt: prof.updatedAt, type: typeof conf.类型 === 'string' ? conf.类型 : '' }
  }

  const profileSave = async (body) => {
    const project = await ensureProject()
    if (typeof body.text !== 'string') throw new Error('档案必须是字符串')
    if (body.text.length > 1024 * 1024) throw new Error('档案太大（上限 1MB）')

    // dedupe=true 时，保存前把「- 」条目里重复的删掉。
    // 只动列表项，标题、引用、正文一概不碰。
    let text = body.text
    let removed = []
    if (body.dedupe === true) {
      const r = dedupeProfile(text)
      text = r.text
      removed = r.removed
    }

    const path = await cx.profilePath(project.projectDir)
    await mkdir(dirname(path), { recursive: true })
    // 覆盖前备份，万一去重删错了还能找回
    const cur = await cx.readProfile(path)
    if (cur.text.trim() !== '' && cur.text !== text) {
      const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
      await mkdir(bakDir, { recursive: true })
      await writeFile(join(bakDir, '作者偏好档案 ' + stampNow() + '.md'), cur.text, 'utf8')
    }
    await writeFile(path, text, 'utf8')
    return { ok: true, path, chars: charCount(text), removed }
  }

  /**
   * 往档案末尾追加一段内容并立即落盘。
   *
   * 为什么不前端拼好再调 profile.save：那样只改了编辑框，文件没变。
   * 接着如果用「提炼规律」写入（它读文件、合并、写回），编辑框里还没保存的
   * 那部分就被覆盖掉了——表现就是「先加的小说分析，下次提炼后消失了」。
   */
  const profileAppend = async (body) => {
    const project = await ensureProject()
    const block = typeof body.text === 'string' ? body.text.trim() : ''
    if (block === '') throw new Error('要追加的内容是空的')

    const path = await cx.profilePath(project.projectDir)
    const cur = await cx.readProfile(path)
    let base = cur.text

    // 第一次追加时给个标题，避免内容悬空
    if (base.trim() === '') {
      base = '# 作者偏好档案\n'
    }

    // 已经包含同一段就不重复加
    if (base.includes(block)) {
      return { ok: true, path, chars: charCount(base), skipped: true }
    }

    const separator = base.endsWith('\n') ? '\n' : '\n\n'
    const next = base.replace(/\s+$/u, '') + separator + block + '\n'

    const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
    await mkdir(bakDir, { recursive: true })
    if (cur.text.trim() !== '') {
      await writeFile(join(bakDir, '作者偏好档案 ' + stampNow() + '.md'), cur.text, 'utf8')
    }
    await writeFile(path, next, 'utf8')
    return { ok: true, path, chars: charCount(next), added: block.length }
  }

  const profileClear = async () => {
    const project = await ensureProject()
    const path = await cx.profilePath(project.projectDir)
    const cur = await cx.readProfile(path)
    let backup = ''
    if (cur.text.trim() !== '') {
      const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
      await mkdir(bakDir, { recursive: true })
      backup = join(bakDir, `作者偏好档案 ${stampNow()}.md`)
      await writeFile(backup, cur.text, 'utf8')
    }
    const conf = await cx.readBookConf(project.projectDir)
    const typeName = typeof conf.类型 === 'string' ? conf.类型.trim() : ''
    const title = typeName === '' ? '作者偏好档案' : `作者偏好档案 · ${typeName}`
    const template = [
      `# ${title}`,
      '',
      '> 这里只放**能复用的写作规律**，不放原文摘录。',
      '> 写稿时读这一份就够。',
      '',
      '## 已验证偏好（作者喜欢什么）',
      '',
      '## 避免的写法（作者不喜欢什么）',
      '',
    ].join('\n')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, template, 'utf8')
    return { ok: true, path, backup, chars: charCount(template) }
  }

  const typesList = async () => {
    const project = await cx.projectOf(false)
    const conf = project === null ? {} : await cx.readBookConf(project.projectDir)
    const current = typeof conf.类型 === 'string' ? conf.类型 : ''
    const names = await cx.listDirs(typesRoot())
    const types = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      const info = await cx.readProfile(cx.typeProfilePath(name))
      types.push({ name, chars: info.chars, updatedAt: info.updatedAt })
    }
    types.sort((a, b) => (a.name < b.name ? -1 : 1))
    return { ok: true, root: typesRoot(), current, types }
  }

  const typesCreate = async (body) => {
    const project = await ensureProject()
    const name = safeTypeName(body.name)
    if (name === '') throw new Error('类型名不能为空')
    const path = cx.typeProfilePath(name)
    if (existsSync(path)) throw new Error('已经有这个类型了：' + name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `# 作者偏好档案 · ${name}\n\n## 已验证偏好（作者喜欢什么）\n\n## 避免的写法（作者不喜欢什么）\n`, 'utf8')
    const conf = await cx.readBookConf(project.projectDir)
    await cx.writeBookConf(project.projectDir, { ...conf, 类型: name })
    return { ok: true, name, path }
  }

  const typesBind = async (body) => {
    const project = await ensureProject()
    const name = safeTypeName(body.name)
    const conf = await cx.readBookConf(project.projectDir)
    // 换绑前把当前档案写回原处，不丢东西
    const before = await cx.profilePath(project.projectDir)
    const prof = await cx.readProfile(before)
    if (prof.text.trim() !== '' && before !== '') {
      await mkdir(dirname(before), { recursive: true })
      await writeFile(before, prof.text, 'utf8')
    }
    if (name === '') {
      delete conf.类型
      await cx.writeBookConf(project.projectDir, conf)
      return { ok: true, type: '' }
    }
    if (!existsSync(cx.typeProfilePath(name))) throw new Error('没有这个类型：' + name)
    await cx.writeBookConf(project.projectDir, { ...conf, 类型: name })
    const after = await cx.readProfile(cx.typeProfilePath(name))
    return { ok: true, type: name, chars: after.chars }
  }

  const typesSaveAs = async (body) => {
    const project = await ensureProject()
    const name = safeTypeName(body.name)
    if (name === '') throw new Error('类型名不能为空')
    const cur = await cx.readProfile(await cx.profilePath(project.projectDir))
    if (cur.text.trim() === '') throw new Error('当前档案是空的')
    const path = cx.typeProfilePath(name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, cur.text, 'utf8')
    return { ok: true, name, path, chars: cur.chars }
  }

  const typesDelete = async (body) => {
    const project = await ensureProject()
    const name = safeTypeName(body.name)
    const dir = join(typesRoot(), name)
    if (!existsSync(dir)) throw new Error('没有这个类型：' + name)
    const trash = cx.typesTrashDir()
    await mkdir(trash, { recursive: true })
    const dest = join(trash, `${stampNow()} ${name}`)
    await rename(dir, dest)
    const conf = await cx.readBookConf(project.projectDir)
    if (conf.类型 === name) {
      delete conf.类型
      await cx.writeBookConf(project.projectDir, conf)
    }
    return { ok: true, name, trash: dest }
  }

  const typesTrashList = async () => {
    const trash = cx.typesTrashDir()
    const dirs = await cx.listDirs(trash)
    const items = []
    for (const d of dirs) {
      const m = /^(\S+)\s+(.+)$/u.exec(d)
      const info = await cx.readProfile(join(trash, d, PROFILE_FILE))
      items.push({
        dirName: d,
        typeName: m === null ? d : String(m[2]).trim(),
        stamp: m === null ? '' : m[1],
        path: join(trash, d),
        chars: info.chars,
      })
    }
    items.sort((a, b) => (a.dirName < b.dirName ? 1 : -1))
    return { ok: true, trash, items }
  }

  const typesTrashRestore = async (body) => {
    const dirName = safeFileName(body.name)
    const src = join(cx.typesTrashDir(), dirName)
    if (!existsSync(src)) throw new Error('回收站里没有：' + dirName)
    const m = /^(\S+)\s+(.+)$/u.exec(dirName)
    const name = safeTypeName(m === null ? dirName : String(m[2]))
    if (name === '') throw new Error('认不出类型名')
    const dest = join(typesRoot(), name)
    if (existsSync(dest)) throw new Error('已经有一个叫「' + name + '」的类型了')
    await rename(src, dest)
    return { ok: true, typeName: name, path: dest }
  }

  const typesTrashPurge = async (body) => {
    const dirName = safeFileName(body.name)
    const full = join(cx.typesTrashDir(), dirName)
    if (!existsSync(full)) throw new Error('回收站里没有：' + dirName)
    await rm(full, { recursive: true, force: true })
    return { ok: true, name: dirName }
  }

  const typesTrashPurgeAll = async () => {
    const trash = cx.typesTrashDir()
    const dirs = await cx.listDirs(trash)
    let n = 0
    for (const d of dirs) {
      try {
        await rm(join(trash, d), { recursive: true, force: true })
        n += 1
      } catch {
        // 单个失败跳过
      }
    }
    return { ok: true, removedCount: n }
  }

  // ══════════════════════════════════════════════════════════
  // 开新章：本章设定 → 模型给方向 → 逐篇写候选
  // ══════════════════════════════════════════════════════════
  const setupPathOf = (projectDir, chapter) => join(cx.stateDirOf(projectDir), '章节设定', `第${chapter}章.md`)

  const SETUP_TEMPLATE = (chapter) =>
    [
      `# 第${chapter}章 本章设定`,
      '',
      '> 这里写「这一章要干什么」。写作包会把它放在最前面，写稿会话第一眼就看它。',
      '> 下面四节可以留空，留空的节不会进包。',
      '',
      '## 本章目标（必须发生）',
      '- ',
      '',
      '## 禁止发生',
      '- ',
      '',
      '## 出场人物',
      '- ',
      '',
      '## 本章要求',
      '- 字数：',
      '',
    ].join('\n')

  const setupGet = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const path = setupPathOf(project.projectDir, chapter)
    const text = await readTextSafe(path)
    return { ok: true, chapter, path, text: text === '' ? SETUP_TEMPLATE(chapter) : text, exists: text !== '' }
  }

  const setupSave = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    if (typeof body.text !== 'string') throw new Error('设定必须是字符串')
    const path = setupPathOf(project.projectDir, chapter)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body.text, 'utf8')
    return { ok: true, chapter, path, chars: charCount(body.text) }
  }

  /** 组装写作包：给模型看的那一份。缺什么就少给什么，不抛错。 */
  const packFor = async (project, chapter, setupText) => {
    const ws = await W.readWorkspace(project.projectDir, { name: project.name, runsRoot: project.runsRoot })
    const rows = (ws.chapters || []).slice().sort((a, b) => a.chapter - b.chapter)

    // 上一章正文
    const prevRow = rows.filter((r) => r.chapter < chapter).pop()
    const previousChapterText = prevRow === undefined ? '' : await readTextSafe(prevRow.path)

    // 剧情总结
    const summaries = []
    for (const r of rows) {
      if (r.chapter >= chapter) continue
      const p = join(project.projectDir, '剧情', `第${r.chapter}章 剧情总结.md`)
      const t = await readTextSafe(p)
      if (t !== '') summaries.push({ chapter: r.chapter, title: r.title, text: t })
    }

    // 大纲节点
    const outlineText = await readTextSafe(join(project.projectDir, '大纲.md'))
    let outlineNodes = []
    try {
      outlineNodes = outlineText === '' ? [] : PIPE.parseOutlineNodes(outlineText)
    } catch {
      outlineNodes = []
    }

    // 人物卡（带别称，供 pickPeople 认小名）
    let people = []
    try {
      people = enrichPeople(await W.readPeople(project.projectDir))
    } catch {
      people = []
    }

    const setup = typeof setupText === 'string' ? setupText : await readTextSafe(setupPathOf(project.projectDir, chapter))

    // ── 情节体检的结论也带进包 ──
    // 伏笔：从大纲「埋/收」配对里算出还欠着的
    let debts = []
    try {
      debts = PLOT.foreshadowDebts({ outline: outlineText, chapters: rows, summaries })
    } catch {
      debts = []
    }

    // 无卡角色：在总结里出现过、但人物卡里没有的
    const cardNames = new Set(people.map((x) => String(x.name).trim()))
    const aliasNames = new Set()
    for (const x of people) for (const a of x.aliases) aliasNames.add(a)
    const seenNames = new Set()
    for (const s of summaries) {
      let parsed
      try {
        parsed = parseSummary(s.chapter, s.text)
      } catch {
        continue
      }
      for (const c of parsed.characters || []) {
        const nm = String(c).trim()
        if (nm !== '') seenNames.add(nm)
      }
    }
    const missingCards = [...seenNames].filter((n) => !cardNames.has(n) && !aliasNames.has(n))

    // ── 节奏简报：把情节体检的结论带进包 ──
    // 不然模型每章都从零开始，前面写得再平它也不知道。
    let pacing = []
    try {
      // 张力必须喂带正文的 chapters，否则每章都估成 1 分
      const pi = await plotInputs(project)
      const series = PLOT.buildTensionSeries({
        chapters: pi.chapters,
        outline: pi.outline,
        summaries: pi.summaries,
      })
      const real = (series || []).filter((s) => s !== null && typeof s === 'object' && Number.isFinite(Number(s.value)))
      const before = real.filter((s) => Number(s.chapter) < chapter)
      const recent = before.slice(-6)
      const lines = []

      if (recent.length >= 3) {
        const last3 = recent.slice(-3).map((s) => Number(s.value))
        const avg = last3.reduce((a, b) => a + b, 0) / last3.length
        if (avg <= 2) {
          lines.push(
            '- 最近三章张力只有 ' +
              last3.join('/') +
              '，偏低。这一章别再靠对话和铺垫推进——安排一个当场就炸的冲突，或者让某个一直在忍的人翻脸。',
          )
        } else if (avg >= 3.5) {
          lines.push('- 最近三章张力 ' + last3.join('/') + '，一直很高。这一章可以稍微缓一口气，但别彻底松掉，留个钩子。')
        }
      }

      if (real.length >= 10) {
        const maxAll = Math.max(...real.map((s) => Number(s.value)))
        if (maxAll <= 3) {
          lines.push(
            '- 全书还没有一章张力到 4（最高 ' +
              String(maxAll) +
              ' 分）。读者容易觉得「一直在铺垫」，这一章挑最该爆的那个点明显加码。',
          )
        }
      }

      if (recent.length > 0) {
        lines.push('- 最近章节张力：' + recent.map((s) => '第' + String(s.chapter) + '章 ' + String(s.value) + '分').join('，'))
      }

      pacing = lines
    } catch {
      pacing = []
    }

    // 走按需取材：近10章全文 / 早期摘要 / 配角回查升级 / 大纲窗口
    const built = await assemblePack({
      chapter,
      setupText: setup,
      outlineNodes,
      summaries,
      previousChapterText,
      previousChapter: chapter - 1,
      people,
      buildPack: PACK.buildPack,
      targetChapterWords: cx.cfg().targetChapterWords,
      projectDir: project.projectDir,
      debts,
      missingCards,
      pacing,
    })
    return { pack: built.pack, setup, info: built.info }
  }

  /**
   * 预览写作包：不调模型，只装配。
   * 给作者看「这一章到底读了什么」，也方便排查取材问题。
   */
  const packPreview = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const setupText = typeof body.setupText === 'string' ? body.setupText : undefined
    const built = await packFor(project, chapter, setupText)
    const out = {
      ok: true,
      chapter,
      chars: built.pack.chars === undefined ? 0 : built.pack.chars,
      info: built.info === undefined ? null : built.info,
    }
    if (body.full === true) out.text = built.pack.text
    return out
  }

  /** 拿模型路由 + llm 服务 */
  const modelRoute = () => {
    if (hostCtx === undefined || hostCtx === null) throw new Error('宿主上下文缺失')
    const llm = hostCtx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') throw new Error('这个 dsh 没挂 LLM 服务，这一步要模型')
    const route = resolveRoute(hostCtx, {
      provider: String(cx.cfg().distillProvider ?? ''),
      model: String(cx.cfg().distillModel ?? ''),
    })
    if (route === null) throw new Error('没有可用的模型路由：在设置里填 distillProvider / distillModel，或先选默认模型')
    return { llm, route }
  }

  const newchapterStatus = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const detail = await W.readChapter(project.projectDir, chapter)
    const dir = draftChapterDir(project.projectDir, chapter)
    const items = await readCandidateDir(dir)
    const setupText = await readTextSafe(setupPathOf(project.projectDir, chapter))
    return {
      ok: true,
      chapter,
      hasChapter: detail.found,
      chapterChars: detail.found ? charCount(detail.text) : 0,
      candidates: items.length,
      candidateNames: items.map((x) => x.name),
      setupExists: setupText !== '',
      setupText: setupText === '' ? SETUP_TEMPLATE(chapter) : setupText,
    }
  }

  const newchapterDirections = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const count = Number.isInteger(body.count) ? Math.min(Math.max(body.count, DRAFT.MIN_DIRECTIONS), DRAFT.MAX_DIRECTIONS) : DRAFT.DEFAULT_DIRECTION_COUNT
    const extra = typeof body.extra === 'string' ? body.extra : ''
    // 设定先落盘，写作包与之后的写稿都用同一份
    if (typeof body.setupText === 'string' && body.setupText.trim() !== '') {
      const path = setupPathOf(project.projectDir, chapter)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body.setupText, 'utf8')
    }

    const { pack } = await packFor(project, chapter)
    const prompt = DRAFT.buildDirectionsPrompt({ pack: pack.text, extra, count, chapter })
    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: DRAFT.directionsSystemPrompt(),
      user: prompt.text,
      maxTokens: 1800,
      timeoutMs: 120000,
    })

    // 原始输出留档：解析失败时作者能看原话
    const rawPath = join(cx.stateDirOf(project.projectDir), '开新章原始输出', `第${chapter}章-方向.md`)
    await mkdir(dirname(rawPath), { recursive: true })
    await writeFile(
      rawPath,
      [`# 第${chapter}章 方向 · 原始输出`, '', `> 模型：${route.provider}/${route.model} · 结束原因：${answer.finish}`, '', answer.text === '' ? '（模型没有输出正文）' : answer.text, ''].join('\n'),
      'utf8',
    )

    const directions = DRAFT.parseDirections(answer.text)
    if (directions.length === 0) {
      throw new Error('没解析出方向（' + (finishReason(answer.finish, answer.text) || '格式没对上') + '）：原话见 ' + rawPath)
    }
    return {
      ok: true,
      chapter,
      directions,
      model: route.provider + '/' + route.model,
      packChars: charCount(pack.text || ''),
      rawPath,
      warnings: Array.isArray(pack.warnings) ? pack.warnings : [],
    }
  }

  const newchapterDraft = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const direction = body.direction
    if (direction === null || typeof direction !== 'object' || typeof direction.detail !== 'string') {
      throw new Error('要指定这一篇的写法方向')
    }
    const index = Number.isInteger(body.index) ? body.index : 0

    const { pack } = await packFor(project, chapter)
    const prompt = DRAFT.buildDraftPrompt({
      pack: pack.text,
      direction,
      others: Array.isArray(body.others) ? body.others : [],
      chapter,
    })
    // 指令是硬约束：放在提示词最末尾（紧挨「请写出…」），优先级高于写作包
    const rules = await RULES.readRules(project.projectDir)
    const block = RULES.rulesBlock(rules.items)
    const userText = block === '' ? prompt.text : prompt.text + '\n' + block
    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: DRAFT.draftSystemPrompt(),
      user: userText,
      maxTokens: 6000,
      timeoutMs: 300000,
    })
    const cleaned = DRAFT.cleanDraftText(answer.text)
    if (cleaned.trim() === '') {
      throw new Error('这一篇没写出正文（' + (finishReason(answer.finish, answer.text) || '模型空输出') + '）')
    }

    const dir = draftChapterDir(project.projectDir, chapter)
    await mkdir(dir, { recursive: true })
    const fileName = DRAFT.candidateFileName({ chapter, index, name: direction.name })
    const target = join(dir, fileName)
    await writeFile(target, cleaned, 'utf8')

    return {
      ok: true,
      chapter,
      index,
      name: fileName,
      path: target,
      chars: charCount(cleaned),
      model: route.provider + '/' + route.model,
    }
  }
  // ══════════════════════════════════════════════════════════
  // 剧情总结：读正文 → 模型写总结 → 落到 剧情/第N章 剧情总结.md
  // ══════════════════════════════════════════════════════════
  const summaryPathOf = (projectDir, chapter) => join(projectDir, '剧情', '第' + String(chapter) + '章 剧情总结.md')

  /** 缺失清单：哪些章有正文却没有总结 */
  /**
   * 角色出场索引：扫全书剧情总结，统计每个角色出现在哪几章。
   * 这是「他上次出场是什么时候」的唯一可靠来源——比翻正文快，比翻大纲准。
   */
  const peopleIndex = async () => {
    const project = await ensureProject()
    const dir = join(project.projectDir, '剧情')
    const files = await cx.listFiles(dir, ['.md'])
    const rows = []
    for (const f of files) {
      const m = /第\s*([0-9]+)\s*章/u.exec(f.name)
      if (m === null) continue
      const chapter = Number(m[1])
      const text = await readTextSafe(f.path)
      const parsed = parseSummary(chapter, text)
      rows.push(parsed)
    }
    rows.sort((a, b) => a.chapter - b.chapter)

    // 手上有卡的（带别称）
    let people = []
    try {
      people = enrichPeople(await W.readPeople(project.projectDir))
    } catch {
      people = []
    }
    // 别称 → 正式名。总结里写「萧先生」，索引要归到萧烬名下。
    const aliasToName = new Map()
    for (const p of people) {
      for (const a of p.aliases) {
        if (!aliasToName.has(a)) aliasToName.set(a, p.name)
      }
    }
    const cardNames = new Set(people.map((p) => String(p.name).trim()))

    // 人物 → 章节列表
    const map = new Map()
    for (const s of rows) {
      for (const raw of s.characters) {
        const trimmed = String(raw).trim()
        if (trimmed === '') continue
        // 别称归一到正式名；认不出就原样记
        const key = aliasToName.get(trimmed) || trimmed
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(s.chapter)
      }
    }

    const characters = []
    for (const [name, chapters] of map) {
      const sorted = [...new Set(chapters)].sort((a, b) => a - b)
      const card = people.find((p) => String(p.name).trim() === name)
      characters.push({
        name,
        chapters: sorted,
        first: sorted[0],
        last: sorted[sorted.length - 1],
        count: sorted.length,
        hasCard: cardNames.has(name),
        aliases: card === undefined ? [] : card.aliases,
      })
    }
    characters.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))

    // 有卡但从没在总结里出现过（可能是还没登场的人物）
    const silent = [...cardNames].filter((n) => n !== '' && !map.has(n))

    // 出现了但没卡的（模型容易瞎编的人）
    const unknown = characters.filter((c) => c.hasCard !== true).map((c) => c.name)

    const headCount = rows.filter((r) => r.hasHead === true).length
    return {
      ok: true,
      summaryCount: rows.length,
      headCoverage: rows.length === 0 ? 0 : headCount / rows.length,
      characters,
      unknown,
      silent,
      missingSummary: (await W.readWorkspace(project.projectDir, { name: project.name, runsRoot: project.runsRoot })).chapters.length - rows.length,
    }
  }

  const summaryMissing = async () => {
    const project = await ensureProject()
    const ws = await W.readWorkspace(project.projectDir, { name: project.name, runsRoot: project.runsRoot })
    const rows = (ws.chapters || []).slice().sort((a, b) => a.chapter - b.chapter)
    const missing = []
    let done = 0
    for (const r of rows) {
      const info = await statSafe(summaryPathOf(project.projectDir, r.chapter))
      if (info.exists) done += 1
      else missing.push({ chapter: r.chapter, title: r.title, chars: r.chars })
    }
    return { ok: true, total: rows.length, doneCount: done, missing }
  }

  /** 读某一章的剧情总结 */
  const summaryGet = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const path = summaryPathOf(project.projectDir, chapter)
    const info = await statSafe(path)
    if (!info.exists) return { ok: true, chapter, exists: false, text: '', path }
    const text = await readTextSafe(path)
    return { ok: true, chapter, exists: true, text, path, chars: charCount(text), mtime: info.mtime }
  }

  /** 手改剧情总结后保存 */
  const summarySave = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    if (typeof body.text !== 'string') throw new Error('总结必须是字符串')
    if (body.text.trim() === '') throw new Error('总结是空的，拒绝写入')
    const path = summaryPathOf(project.projectDir, chapter)
    const existed = await statSafe(path)
    if (existed.exists) {
      const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
      await mkdir(bakDir, { recursive: true })
      await writeFile(join(bakDir, '第' + String(chapter) + '章 剧情总结 ' + stampNow() + '.md'), await readTextSafe(path), 'utf8')
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body.text, 'utf8')
    return { ok: true, chapter, path, chars: charCount(body.text) }
  }

  const HEAD_SYSTEM = [
    '你是小说资料整理员。作者有一份已经写好的章节剧情总结，但缺结构化头部。',
    '你的活：只从这份总结里提取头部字段，不要改写、不要补充总结里没有的内容。',
    '',
    '只输出下面这几行，不要别的内容，不要代码围栏：',
    '---',
    'chapter: N',
    'characters: [总结里出现的人物名字，逗号分隔]',
    'location: [主要地点；没有就写 无]',
    'planted: [总结里提到的、还没收的伏笔或线索；没有就写 无]',
    'paid: [总结里明确回收的旧伏笔；没有就写 无]',
    '---',
    '',
    '规则：',
    '1. characters 只写名字，不要「主角」「他」，不要括号说明。',
    '2. 只提取总结里明确写了的人和事，不要推测。',
    '3. 拿不准的字段留空数组 []。',
  ].join('\n')

  /**
   * 给一份已有总结补结构化头部（不重写正文）。
   *
   * 纯规则，不调模型：
   * - characters ← 扫这一章正文里出现了哪些「已知角色名 + 别称」
   * - planted    ← 抄总结正文「本章埋点」节
   * - paid       ← 抄明确写了「回收/兑现」的那几条
   * - location   ← 留空（规则猜不准，宁可空着）
   *
   * 比模型准：模型会把「提到」的人也算成出场，还会漏；规则只认卡里有的名字，宁缺勿滥。
   */
  const summaryFillHead = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const path = summaryPathOf(project.projectDir, chapter)
    const info = await statSafe(path)
    if (!info.exists) throw new Error('第' + String(chapter) + '章还没有剧情总结')
    const text = await readTextSafe(path)
    const parsed = parseSummary(chapter, text)
    if (parsed.hasHead && body.overwrite !== true) {
      return { ok: true, chapter, skipped: true, reason: '已经有头部了' }
    }

    let people = []
    try {
      people = enrichPeople(await W.readPeople(project.projectDir))
    } catch {
      people = []
    }
    const detail = await W.readChapter(project.projectDir, chapter)
    const bodyText = detail.found ? detail.text : ''
    const chars = []
    for (const p of people) {
      const hit = p.allNames.some((n) => String(n).length >= 2 && bodyText.includes(String(n)))
      if (hit) {
        const nm = String(p.name).trim()
        if (nm !== '' && !chars.includes(nm)) chars.push(nm)
      }
    }
    if (chars.length === 0) {
      const fromSum = sectionList(text, /出场人物/u)
      for (const line of fromSum) {
        const nm = String(line).replace(/[（(].*$/u, '').trim()
        if (nm !== '' && nm.length <= 12 && !chars.includes(nm)) chars.push(nm)
      }
    }
    if (chars.length === 0) {
      throw new Error('第' + String(chapter) + '章正文里没有出现任何已知角色，规则认不出来——先给新角色建卡，或手动补这一章的头部')
    }

    const planted = sectionList(text, /埋点|伏笔/u).filter((x) => x !== '无')
    const paid = sectionList(text, /埋点|伏笔|回收/u).filter((x) => /回收|收线|兑现|还了/u.test(String(x)))

    const headLines = [
      '---',
      'chapter: ' + String(chapter),
      'characters: [' + chars.join(', ') + ']',
      'location: []',
      'planted: [' + planted.map((x) => String(x).replace(/\n/gu, ' ')).join(', ') + ']',
      'paid: [' + paid.map((x) => String(x).replace(/\n/gu, ' ')).join(', ') + ']',
      '---',
    ]
    let bodyOnly = text
    if (text.trim().startsWith('---')) {
      const tl = text.split('\n')
      let s2 = -1
      let e2 = -1
      for (let i = 0; i < tl.length; i += 1) {
        if (tl[i].trim() === '---') {
          if (s2 === -1) { s2 = i; continue }
          e2 = i
          break
        }
      }
      if (s2 !== -1 && e2 !== -1) bodyOnly = tl.slice(e2 + 1).join('\n').trim()
    }
    const next = headLines.join('\n') + '\n\n' + bodyOnly + '\n'

    const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
    await mkdir(bakDir, { recursive: true })
    await writeFile(join(bakDir, '第' + String(chapter) + '章 剧情总结 ' + stampNow() + '.md'), text, 'utf8')
    await writeFile(path, next, 'utf8')

    return { ok: true, chapter, characters: chars, plantedCount: planted.length, paidCount: paid.length, byRule: true }
  }
  /** 找出所有缺头部的总结 */
  const summaryHeadsMissing = async () => {
    const project = await ensureProject()
    const dir = join(project.projectDir, '剧情')
    const files = await cx.listFiles(dir, ['.md'])
    const missing = []
    const okList = []
    for (const f of files) {
      const m = /第\s*([0-9]+)\s*章/u.exec(f.name)
      if (m === null) continue
      const chapter = Number(m[1])
      const text = await readTextSafe(f.path)
      const parsed = parseSummary(chapter, text)
      if (parsed.hasHead) okList.push(chapter)
      else missing.push({ chapter, name: f.name, chars: charCount(text) })
    }
    missing.sort((a, b) => a.chapter - b.chapter)
    return { ok: true, missing, doneCount: okList.length }
  }

  const summaryGenerate = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const detail = await W.readChapter(project.projectDir, chapter)
    if (!detail.found) throw new Error('第' + String(chapter) + '章还没有正文，没法总结')
    if (charCount(detail.text) < 200) throw new Error('第' + String(chapter) + '章正文太短（不到 200 字），先写完再总结')

    const target = summaryPathOf(project.projectDir, chapter)
    const existed = await statSafe(target)
    if (existed.exists && body.overwrite !== true) {
      throw new Error('第' + String(chapter) + '章已经有剧情总结；要重写请先删掉，或带上覆盖标记')
    }

    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: SUMMARY_SYSTEM,
      user: buildSummaryUser(chapter, detail.text),
      maxTokens: 2000,
      timeoutMs: 120000,
    })
    const clean = cleanSummaryOutput(chapter, answer.text)
    if (clean.trim() === '' || clean.split('\n').length < 3) {
      throw new Error('模型没有给出可用总结（' + (finishReason(answer.finish, answer.text) || '空输出') + '）')
    }

    // 覆盖前备份旧的
    let backup = ''
    if (existed.exists) {
      const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
      await mkdir(bakDir, { recursive: true })
      backup = join(bakDir, '第' + String(chapter) + '章 剧情总结 ' + stampNow() + '.md')
      await writeFile(backup, await readTextSafe(target), 'utf8')
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, clean + '\n', 'utf8')

    return { ok: true, chapter, path: target, chars: charCount(clean), backup, model: route.provider + '/' + route.model }
  }
  // ══════════════════════════════════════════════════════════
  // 一致性检查：纯规则，不调模型
  // ══════════════════════════════════════════════════════════
  const consistencyCheck = async () => {
    const project = await ensureProject()
    const ws = await W.readWorkspace(project.projectDir, { name: project.name, runsRoot: project.runsRoot })
    const rows = (ws.chapters || []).slice().sort((a, b) => a.chapter - b.chapter)

    // 人物卡
    let people = []
    try {
      people = await W.readPeople(project.projectDir)
    } catch {
      people = []
    }
    // 用「姓名 + 别称」去匹配正文：只认全名的话，写「李哥」就查不出来
    const armed = enrichPeople(people)
    const cardNames = armed.map((p) => String(p.name).trim()).filter((n) => n !== '')
    const checkPairs = []
    for (const p of armed) {
      for (const n of p.allNames) {
        if (String(n).length >= 2) checkPairs.push({ name: p.name, token: String(n) })
      }
    }

    const issues = []

    for (const r of rows) {
      const text = await readTextSafe(r.path)
      if (text === '') continue
      const sumPath = summaryPathOf(project.projectDir, r.chapter)
      const sumInfo = await statSafe(sumPath)
      const sumText = sumInfo.exists ? await readTextSafe(sumPath) : ''
      const parsed = sumInfo.exists ? parseSummary(r.chapter, sumText) : { characters: [], hasHead: false }
      const recorded = new Set(parsed.characters.map((x) => String(x).trim()))

      // ① 正文里出现、总结却没记
      // 只在总结「有结构化头部」时才查：老总结没有 characters 字段，
      // 拿它比对必然全报漏记——那是索引没建起来，不是总结写漏了。
      if (sumInfo.exists && parsed.hasHead === true) {
        const missed = [...new Set(checkPairs.filter((p) => text.includes(p.token) && !recorded.has(p.name)).map((p) => p.name))]
        if (missed.length > 0) {
          issues.push({
            level: 'info',
            code: '总结漏记',
            chapter: r.chapter,
            message: '第' + String(r.chapter) + '章正文出现了「' + missed.join('、') + '」，但该章总结的出场人物里没有。要么总结该补，要么这个名字只是碰巧同字。',
          })
        }
      }

      // ② 有卡的角色在正文出现，但这一章没有总结
      if (!sumInfo.exists) {
        const appeared = [...new Set(checkPairs.filter((p) => text.includes(p.token)).map((p) => p.name))]
        if (appeared.length > 0) {
          issues.push({
            level: 'warn',
            code: '缺总结',
            chapter: r.chapter,
            message: '第' + String(r.chapter) + '章还没写剧情总结，这一章的出场人物与伏笔都没进索引。',
          })
        }
      }
    }

    // ③ 总结里出现但没卡的人
    const index = await peopleIndex()
    const unknown = index.unknown
    if (unknown.length > 0) {
      issues.push({
        level: 'info',
        code: '无卡角色',
        names: unknown.slice(0, 20),
        message: '这些人在剧情总结里反复出现，但没有角色卡：' + unknown.slice(0, 12).join('、') + (unknown.length > 12 ? ' 等 ' + String(unknown.length) + ' 人' : '') + '。开新章时模型没有他们的资料，容易前后编得不一样。',
      })
    }

    // ④ 有卡但从没在总结里出场
    // 索引不完整时这条必然是误报（人都没被索引到，当然显示"未登场"），
    // 等头部补齐到六成以上再报。
    if (index.silent.length > 0 && index.headCoverage > 0.6) {
      issues.push({
        level: 'info',
        code: '未登场',
        message: '这些角色有卡，但在已有总结里一次都没出场：' + index.silent.slice(0, 12).join('、') + (index.silent.length > 12 ? ' 等' : '') + '。',
      })
    }

    // ⑤ 总结缺头部（索引不全的直接原因）
    const headMissing = await summaryHeadsMissing()
    if (headMissing.missing.length > 0) {
      issues.push({
        level: 'warn',
        code: '总结缺索引头',
        message: '有 ' + String(headMissing.missing.length) + ' 章总结没有结构化头部（第 ' + headMissing.missing.map((x) => x.chapter).slice(0, 10).join('、') + (headMissing.missing.length > 10 ? '…' : '') + ' 章），这些章的人物与伏笔索引不到。用「补全索引头」可以只补头部、不重写正文。',
      })
    }

    return {
      ok: true,
      issues,
      names: unknown,
      peopleCount: cardNames.length,
      chapterCount: rows.length,
    }
  }

  // ══════════════════════════════════════════════════════════
  // 情节体检：张力曲线 / 伏笔欠账 / 结构问题
  // ══════════════════════════════════════════════════════════
  /** 把全书材料读成 plot 模块要的形状 */
  const plotInputs = async (project) => {
    const ws = await W.readWorkspace(project.projectDir, { name: project.name, runsRoot: project.runsRoot })
    const rows = (ws.chapters || []).slice().sort((a, b) => a.chapter - b.chapter)
    const chapters = []
    let totalChars = 0
    for (const r of rows) {
      if (totalChars > 3_000_000) break
      const text = await readTextSafe(r.path)
      totalChars += charCount(text)
      chapters.push({ chapter: r.chapter, title: r.title, text })
    }
    const outlineText = await readTextSafe(join(project.projectDir, '大纲.md'))
    // parseOutline 返回 { chapters }，不是数组
    let outline = []
    try {
      const parsed = outlineText === '' ? { chapters: [] } : PLOT.parseOutline(outlineText)
      outline = Array.isArray(parsed.chapters) ? parsed.chapters : []
    } catch {
      outline = []
    }
    const summaries = []
    for (const r of rows) {
      const t = await readTextSafe(join(project.projectDir, '剧情', '第' + String(r.chapter) + '章 剧情总结.md'))
      if (t !== '') summaries.push({ chapter: r.chapter, text: t })
    }
    return { chapters, outline, summaries, outlineChars: charCount(outlineText) }
  }

  const plotAnalysis = async () => {
    const project = await ensureProject()
    const input = await plotInputs(project)
    const tensions = PLOT.buildTensionSeries({
      chapters: input.chapters,
      outline: input.outline,
      summaries: input.summaries,
    })
    let debts = []
    let issues = []
    try {
      debts = PLOT.foreshadowDebts({ outline: input.outline, chapters: input.chapters, summaries: input.summaries })
    } catch {
      debts = []
    }
    // 伏笔名字清洗：大纲里「埋：」后面往往是一整句，解析器会按标点切碎，
    // 切出来的碎片（半个括号、只有右引号）对作者没用，这里过滤掉。
    const tidyDebts = (raw) => {
      const out = []
      const seen = new Set()
      for (const d of raw) {
        if (d === null || typeof d !== 'object') continue
        let name = String(d.name ?? '')
          .replace(/^["'“”‘’\s]+/u, '')
          .replace(/["'“”‘’\s]+$/u, '')
          .replace(/[，。；、,;]+$/u, '')
          .trim()
        // 括号必须成对，否则是切碎的残片
        const left = (name.match(/[（(]/gu) || []).length
        const right = (name.match(/[）)]/gu) || []).length
        if (left !== right) continue
        if (name.length < 2 || name.length > 24) continue
        if (seen.has(name)) continue
        seen.add(name)
        out.push({ ...d, name })
      }
      // 超期的排前面，同状态按埋下的章号
      out.sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
        return (a.plantedChapter || 0) - (b.plantedChapter || 0)
      })
      return out
    }

    let metrics = null
    try {
      // detectPlotIssues 返回 { findings, metrics }
      const diag = PLOT.detectPlotIssues({
        chapters: input.chapters,
        outline: input.outline,
        summaries: input.summaries,
        tensions,
      })
      issues = Array.isArray(diag.findings) ? diag.findings : []
      metrics = diag.metrics === undefined ? null : diag.metrics
    } catch {
      issues = []
    }
    const cleanDebts = tidyDebts(debts)

    // 结构问题分两类：
    // - 「伏笔超期」原本是一条伏笔一个问题，几百条会淹掉真正重要的（中段塌陷、全程平缓），
    //   这里合并成一条汇总，细目交给下面的伏笔清单。
    // - 其余问题原样保留，按严重程度排序。
    const overdue = cleanDebts.filter((d) => d.overdue === true)
    const others = issues.filter((x) => x !== null && typeof x === 'object' && x.code !== '伏笔超期')
    const rank = (lv) => (lv === 'warn' ? 0 : lv === 'info' ? 1 : 2)
    others.sort((a, b) => rank(a.level) - rank(b.level))
    const summary =
      overdue.length === 0
        ? []
        : [
            {
              level: 'warn',
              code: '伏笔超期',
              chapter: overdue[0].plantedChapter === undefined ? null : overdue[0].plantedChapter,
              message:
                '有 ' +
                String(overdue.length) +
                ' 条伏笔还没收，最早的一条在第 ' +
                String(overdue[0].plantedChapter) +
                ' 章埋下。在下方「伏笔」清单里逐条看。',
            },
          ]
    return {
      ok: true,
      tensions,
      debts: cleanDebts,
      overdueCount: overdue.length,
      rawDebtCount: debts.length,
      issues: [...summary, ...others],
      metrics,
      stats: {
        chapters: input.chapters.length,
        summaries: input.summaries.length,
        outlineChars: input.outlineChars,
        outlineNodes: input.outline.length,
      },
    }
  }

  // ══════════════════════════════════════════════════════════
  // 提炼规律：标注 → 模型压成规律 → 采纳进档案
  // ══════════════════════════════════════════════════════════
  const DISTILL_FILE = 'distill.json'
  const distillPathOf = (projectDir) => join(cx.stateDirOf(projectDir), DISTILL_FILE)

  const markKeyOf = (chapter, file, index) => String(chapter) + '|' + String(file) + '|' + String(index)

  const readDistilled = async (projectDir) => {
    const data = await readJsonSafe(distillPathOf(projectDir))
    const marks = data !== null && Array.isArray(data.marks) ? data.marks : []
    return { marks, history: data !== null && Array.isArray(data.history) ? data.history : [] }
  }

  /** 全书所有候选稿上的好/坏标注，按章序、稿件名、段序排列 */
  const collectMarked = async (projectDir) => {
    const root = draftsRoot(projectDir)
    const dirs = await cx.listDirs(root)
    const out = []
    const chapters = []
    for (const d of dirs) {
      const m = /第\s*([0-9]+)\s*章/u.exec(d)
      if (m !== null) chapters.push({ chapter: Number(m[1]), dirName: d })
    }
    chapters.sort((a, b) => a.chapter - b.chapter)
    for (const c of chapters) {
      const items = await readCandidateDir(join(root, c.dirName))
      for (const it of items) {
        for (let i = 0; i < it.segments.length; i += 1) {
          const mk = it.segMarks[i]
          if (mk !== 'good' && mk !== 'bad') continue
          out.push({ file: it.name, chapter: c.chapter, index: i, mark: mk, text: it.segments[i] })
        }
      }
    }
    return out
  }

  const distillPending = async () => {
    const project = await ensureProject()
    const all = await collectMarked(project.projectDir)
    const { marks, history } = await readDistilled(project.projectDir)
    const done = new Set(marks.map((x) => String(x)))
    const pending = all.filter((x) => !done.has(markKeyOf(x.chapter, x.file, x.index)))
    return {
      ok: true,
      total: all.length,
      good: all.filter((x) => x.mark === 'good').length,
      bad: all.filter((x) => x.mark === 'bad').length,
      pending: pending.length,
      pendingGood: pending.filter((x) => x.mark === 'good').length,
      pendingBad: pending.filter((x) => x.mark === 'bad').length,
      lastRun: history.length === 0 ? '' : history[history.length - 1].at,
    }
  }

  const distillRun = async () => {
    const project = await ensureProject()
    const all = await collectMarked(project.projectDir)
    if (all.length === 0) throw new Error('全书还没有标注：先在候选稿里逐段点 👍 / 👎')
    const { marks } = await readDistilled(project.projectDir)
    const done = new Set(marks.map((x) => String(x)))
    const pending = all.filter((x) => !done.has(markKeyOf(x.chapter, x.file, x.index)))
    // 没有新标注时，退回用全部标注重来一次（作者可能想换个说法重提）
    const source = pending.length > 0 ? pending : all

    const input = buildDistillInput(source)
    if (input.text.trim() === '') throw new Error('没有可提炼的段落')

    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: DISTILL_SYSTEM,
      user: '以下是作者标注的段落，请压成规律：\n\n' + input.text,
      maxTokens: DISTILL_LIMITS.maxOutputTokens,
      timeoutMs: DISTILL_LIMITS.timeoutMs,
    })

    const rawPath = join(cx.stateDirOf(project.projectDir), '开新章原始输出', '提炼规律.md')
    await mkdir(dirname(rawPath), { recursive: true })
    await writeFile(rawPath, ['# 提炼规律 · 原始输出', '', '> 模型：' + route.provider + '/' + route.model + ' · 结束原因：' + answer.finish, '', answer.text === '' ? '（模型没有输出）' : answer.text, ''].join('\n'), 'utf8')

    const items = parseDistillOutput(answer.text)
    if (items.length === 0) {
      throw new Error('没解析出规律（' + (finishReason(answer.finish, answer.text) || '格式没对上') + '）：原话见 ' + rawPath)
    }
    // 把「（来自 3、7）」的编号翻译成具体段落，作者能回看
    const withEvidence = items.map((it, i) => ({
      id: 'r' + String(i),
      mark: it.mark,
      text: it.text,
      evidence: it.sources
        .map((n) => input.refs[n - 1])
        .filter((x) => x !== undefined)
        .map((x) => ({ chapter: x.chapter, file: x.file, index: x.index, text: x.text })),
    }))
    // 把这次用到的标注记为已提炼，下次只提新的
    const usedKeys = input.refs.map((x) => markKeyOf(x.chapter, x.file, x.index))
    const nextMarks = [...new Set([...marks, ...usedKeys])]
    const prev = await readDistilled(project.projectDir)
    await writeFile(
      distillPathOf(project.projectDir),
      JSON.stringify({ marks: nextMarks, history: [...prev.history, { at: new Date().toISOString(), model: route.provider + '/' + route.model, used: input.refs.length, produced: items.length }] }, null, 2) + '\n',
      'utf8',
    )

    return {
      ok: true,
      rules: withEvidence,
      model: route.provider + '/' + route.model,
      usedSegments: input.used,
      totalSegments: input.total,
      rawPath,
    }
  }

  const distillApply = async (body) => {
    const project = await ensureProject()
    const picked = Array.isArray(body.rules) ? body.rules : []
    const items = picked.filter((x) => x !== null && typeof x === 'object' && typeof x.text === 'string' && (x.mark === 'good' || x.mark === 'bad'))
    if (items.length === 0) throw new Error('没有勾选任何规律')

    const path = await cx.profilePath(project.projectDir)
    const prof = await cx.readProfile(path)
    const merged = mergeRulesIntoProfile(prof.text, items)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, merged.text, 'utf8')

    return { ok: true, path, added: merged.added, addedGood: merged.addedGood, addedBad: merged.addedBad, chars: charCount(merged.text) }
  }
  // ══════════════════════════════════════════════════════════
  // 设定文件（大纲 / 设定 / 人物 / 剧情总结）
  // ══════════════════════════════════════════════════════════

  // ── 文件归属：把清单项绑到具体文件上 ──
  const FILE_MAP = '文件归属.json'
  const fileMapPathOf = (projectDir) => join(cx.stateDirOf(projectDir), FILE_MAP)

  const readFileMap = async (projectDir) => {
    const data = await readJsonSafe(fileMapPathOf(projectDir))
    return data !== null && typeof data === 'object' ? data : {}
  }

  const writeFileMap = async (projectDir, map) => {
    const p = fileMapPathOf(projectDir)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify(map, null, 2) + '\n', 'utf8')
    return p
  }

  // ══════════════════════════════════════════════════════════
  // 角色别称：一个小名认不出，整条索引就漏人
  // ══════════════════════════════════════════════════════════
  /** 角色卡里可能写别称的字段名 */
  const ALIAS_KEYS = ['别称', '别名', '小名', '曾用名', '外号', '称呼', 'aliases', 'alias', 'nickname']

  /** 从一张卡里抽出别称列表 */
  const aliasesOf = (raw) => {
    const out = []
    if (raw === null || typeof raw !== 'object') return out
    for (const k of ALIAS_KEYS) {
      const v = raw[k]
      if (typeof v === 'string') {
        out.push(...v.split(/[,，、/|；;\s]+/u))
      } else if (Array.isArray(v)) {
        for (const x of v) if (typeof x === 'string') out.push(x)
      }
    }
    return [...new Set(out.map((x) => x.trim()).filter((x) => x !== '' && x.length <= 12))]
  }

  /**
   * 给人物列表补上 aliases / allNames。
   * allNames = 姓名 + 别称，所有「这个名字出现了吗」的判断都用它。
   */
  const enrichPeople = (people) => {
    return (Array.isArray(people) ? people : []).map((p) => {
      const aliases = aliasesOf(p.raw)
      const name = String(p.name == null ? '' : p.name).trim()
      const allNames = [...new Set([name, ...aliases].filter((x) => x !== ''))]
      return { ...p, aliases, allNames }
    })
  }

  /**
   * 从正文里猜别称。
   * 做法保守：只试几种中文里最常见的称呼构词，且要求出现达到阈值，
   * 结果一律作为「建议」交给作者确认，不自动写进卡。
   */
  const peopleSuggestAliases = async (body) => {
    const project = await ensureProject()
    const minHits = Number.isInteger(body.minHits) ? body.minHits : 3
    const people = enrichPeople(await W.readPeople(project.projectDir))
    const ws = await W.readWorkspace(project.projectDir, { name: project.name, runsRoot: project.runsRoot })
    const texts = []
    for (const r of ws.chapters || []) {
      const t = await readTextSafe(r.path)
      if (t !== '') texts.push({ chapter: r.chapter, text: t })
    }
    if (texts.length === 0) return { ok: true, candidates: [], scanned: 0 }

    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const SUFFIXES = ['公子', '少爷', '先生', '小姐', '老师', '总', '哥', '姐', '爷', '叔', '姨', '老板', '夫人']
    const existing = new Set()
    for (const p of people) for (const n of p.allNames) existing.add(n)

    const found = []
    for (const p of people) {
      const name = String(p.name)
      if (name.length < 2) continue
      const surname = name.slice(0, 1)
      const given = name.slice(1)
      const tries = new Set()
      for (const suf of SUFFIXES) tries.add(surname + suf)
      tries.add('小' + surname)
      tries.add('老' + surname)
      if (given.length >= 1 && given !== name) tries.add(given)
      if (given.length >= 2) tries.add('小' + given)

      for (const t of tries) {
        if (existing.has(t)) continue
        if (t.length < 2) continue
        const re = new RegExp(escapeRe(t), 'gu')
        let hits = 0
        const where = []
        for (const c of texts) {
          const n = (c.text.match(re) || []).length
          if (n > 0) {
            hits += n
            where.push(c.chapter)
          }
        }
        if (hits < minHits) continue

        // 光看构词不够：「萧先生」同姓两个人都可能。
        // 这里把每次出现的前后文抓出来，再统计这段窗口里还出现过谁——
        // 作者看一眼上下文就知道指的是哪一个。
        const allNames = []
        for (const q of people) for (const n2 of q.allNames) allNames.push(n2)
        const contexts = []
        for (const c of texts) {
          if (contexts.length >= 3) break
          let from = 0
          for (;;) {
            if (contexts.length >= 3) break
            const idx = c.text.indexOf(t, from)
            if (idx === -1) break
            const winStart = Math.max(0, idx - 50)
            const winEnd = Math.min(c.text.length, idx + t.length + 50)
            const win = c.text.slice(winStart, winEnd)
            const nearNames = [...new Set(allNames.filter((n2) => n2 !== t && n2.length >= 2 && win.includes(n2)))]
            contexts.push({
              chapter: c.chapter,
              alias: t,
              before: c.text.slice(Math.max(0, idx - 26), idx).replace(/\s+/gu, ''),
              after: c.text.slice(idx + t.length, idx + t.length + 26).replace(/\s+/gu, ''),
              nearNames,
            })
            from = idx + t.length
          }
        }
        // 共现投票：这段窗口里最常一起出现的角色，很可能就是这个称呼指的人
        const vote = new Map()
        for (const ctx of contexts) {
          for (const n2 of ctx.nearNames) vote.set(n2, (vote.get(n2) || 0) + 1)
        }
        const ranked = [...vote.entries()].sort((a, b) => b[1] - a[1])
        const guess = ranked.length === 0 ? null : ranked[0][0]
        found.push({
          name,
          alias: t,
          hits,
          chapters: where.slice(0, 10),
          contexts,
          guess,
          guessHits: ranked.length === 0 ? 0 : ranked[0][1],
        })
      }
    }
    // 同一个称呼命中多个人（同姓父子最常见）：标出来，让作者自己定
    const byAlias = new Map()
    for (const f of found) {
      if (!byAlias.has(f.alias)) byAlias.set(f.alias, [])
      byAlias.get(f.alias).push(f.name)
    }
    for (const f of found) {
      const owners = byAlias.get(f.alias)
      if (owners.length > 1) {
        f.conflict = true
        f.owners = owners
        // 如果上下文共现已经明确指向某一个人，把它标成「建议」
        f.suggested = f.guess === f.name && f.guessHits >= 2
      }
    }
    found.sort((a, b) => {
      if (a.conflict !== b.conflict) return a.conflict ? 1 : -1
      return b.hits - a.hits
    })
    return { ok: true, candidates: found, scanned: texts.length, peopleCount: people.length }
  }

  /**
   * 给一个还没建卡的角色生成卡片草稿。
   *
   * 不写盘：先生成、给作者看、确认了再存。
   * 材料来自：正文里提到他的段落、大纲里提到他的行。
   */
  const peopleCardDraft = async (body) => {
    const project = await ensureProject()
    const name = String(body.name == null ? '' : body.name).trim()
    if (name === '') throw new Error('要指定角色名')

    const people = await W.readPeople(project.projectDir)
    const hit = people.find((x) => String(x.name).trim() === name)
    if (hit !== undefined) throw new Error('已经有这个角色的卡了：' + name)

    const ws = await W.readWorkspace(project.projectDir, { name: project.name, runsRoot: project.runsRoot })
    const rows = (ws.chapters || []).slice().sort((a, b) => a.chapter - b.chapter)

    // 1) 正文里提到他的段落
    const evidence = []
    for (const r of rows) {
      const t = await readTextSafe(r.path)
      if (!t.includes(name)) continue
      const paras = t
        .split(/\n+/u)
        .map((x) => x.trim())
        .filter((x) => x !== '' && x.includes(name))
      if (paras.length === 0) continue
      evidence.push({ chapter: r.chapter, paras: paras.slice(0, 3) })
    }
    if (evidence.length === 0) {
      throw new Error('正文里找不到「' + name + '」，没法凭空造一张卡')
    }

    // 2) 大纲里提到他的行
    const outlineText = await readTextSafe(join(project.projectDir, '大纲.md'))
    const outlineHits = outlineText
      .split(/\n+/u)
      .map((x) => x.trim())
      .filter((x) => x !== '' && x.includes(name))
      .slice(0, 6)

    // 2b) 设定类文件里提到他的行：世界观、人物设定总表、写作口径、原始设定案、细纲。
    // 只靠正文推卡片，容易漏掉「世界观里写死的种族规则」「总表里的关系」「口径里的名字禁忌」。
    const settingRel = [
      '设定/世界观.md',
      '设定/人物设定.md',
      '人物/主要人物列表.json',
      '设定/_口径.md',
      '设定/00-原始设定案.md',
      '设定/立项.md',
      '细纲.md',
    ]
    const settingHits = []
    for (const rel of settingRel) {
      const text = await readTextSafe(join(project.projectDir, rel))
      if (text === '') continue
      const lines = text
        .split(/\n+/u)
        .map((x) => x.trim())
        .filter((x) => x !== '' && x.includes(name))
      if (lines.length === 0) continue
      settingHits.push({ rel, lines: lines.slice(0, 4) })
    }

    // 3) 已有的卡当格式样例
    const sample = people.find((x) => String(x.importance == null ? '' : x.importance).includes('配角')) || people[0]
    // 只给字段名，不给内容：既不浪费 token，也避免模型照着抄别人的设定
    const sampleKeys = sample === undefined ? [] : Object.keys(sample.raw || {})
    const sampleJson = sampleKeys.length === 0 ? '' : JSON.stringify(sampleKeys)

    const material = [
      '【这个角色在正文里出现过的段落】',
      ...evidence.map((e) => '· 第' + String(e.chapter) + '章：' + e.paras.join(' / ')),
      '',
      '【大纲里提到他的地方】',
      outlineHits.length === 0 ? '（没有）' : outlineHits.map((x) => '· ' + x).join('\n'),
      '',
      '【设定资料里提到他的地方】',
      settingHits.length === 0
        ? '（没有）'
        : settingHits.map((s) => '《' + s.rel + '》\n' + s.lines.map((x) => '· ' + x).join('\n')).join('\n'),
      '',
      '【这本书已有角色卡用的字段名】',
      sampleJson === '' ? '（这本书还没有别的卡，你按人物卡该有的字段自己定）' : sampleJson,
    ].join('\n')

    const system = [
      '你在给一部小说补一张人物卡。',
      '这个角色在正文里出现过，但作者还没给他建卡。',
      '',
      '规则：',
      '1. **字段由你按这本书的类型自己定，不要套固定模板。**',
      '   兽人小说可能要「兽族」，仙侠要「境界」，都市可能要「职业」「年龄」，',
      '   悬疑可能要写「可疑之处」。只保留对这部书有用、能防止前后写矛盾的字段，4–7 个为宜。',
      '2. 如果材料里给了「已有角色卡用的字段名」，照它来，保持全书一致；',
      '   没给样例就自己定。',
      '3. 无论什么类型，「姓名」必须有；「备注」建议留着，写容易忘的点',
      '   （怎么称呼他、和谁有关系、有什么特征）。',
      '4. 材料里有「设定资料里提到他的地方」，**优先用它**：世界观写死的种族/势力规则、',
      '   人物总表里的关系、写作口径里的称呼与禁忌，比正文里的只言片语更权威；',
      '   正文里只是顺口提的形状和外貌，可以和设定冲突，以设定为准。',
      '5. 只写材料里能看出来的东西。看不出来的字段留空字符串，不要编。',
      '6. 只输出 JSON 对象，不要解释，不要 markdown 代码围栏。',
    ].join('\n')

    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system,
      user: '角色名：' + name + '\n\n' + material,
      maxTokens: 1600,
      timeoutMs: 120000,
    })

    // 原始输出留档
    const rawPath = join(cx.stateDirOf(project.projectDir), '建卡原始输出', name + '.md')
    await mkdir(dirname(rawPath), { recursive: true })
    await writeFile(
      rawPath,
      ['# ' + name + ' 建卡 · 原始输出', '', '> 模型：' + route.provider + '/' + route.model, '', answer.text, ''].join('\n'),
      'utf8',
    )

    // 4) 解析 JSON（模型可能带围栏）
    let text = String(answer.text == null ? '' : answer.text).trim()
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/u)
    if (fence !== null) text = fence[1].trim()
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('模型没有输出 JSON，原始输出见：' + rawPath)
    let card = null
    try {
      card = JSON.parse(text.slice(start, end + 1))
    } catch (e) {
      throw new Error('模型输出的 JSON 解析失败：' + String(e.message) + '　原始输出见：' + rawPath)
    }
    if (card === null || typeof card !== 'object') throw new Error('模型返回的不是对象')
    card['姓名'] = name

    return {
      ok: true,
      name,
      card,
      evidence: {
        chapters: evidence.map((e) => e.chapter),
        paragraphs: evidence.reduce((n, e) => n + e.paras.length, 0),
        outlineHits: outlineHits.length,
        settingFiles: settingHits.map((s) => s.rel),
        settingHits: settingHits.reduce((n, s) => n + s.lines.length, 0),
      },
      model: route.provider + '/' + route.model,
    }
  }

  /**
   * 只猜一个字段。
   *
   * 「兽族不知道填什么」「职业想不出来」——整张卡重生成太重，
   * 这里只针对一个字段，把它填上。材料照旧来自正文与大纲，
   * 但还会参考「同书其他角色这个字段是怎么填的」，保持全书一致。
   */
  const peopleFieldGuess = async (body) => {
    const project = await ensureProject()
    const name = String(body.name == null ? '' : body.name).trim()
    const field = String(body.field == null ? '' : body.field).trim()
    if (name === '') throw new Error('要指定角色名')
    if (field === '') throw new Error('要指定字段名')
    const current = String(body.current == null ? '' : body.current).trim()

    const ws = await W.readWorkspace(project.projectDir, { name: project.name, runsRoot: project.runsRoot })
    const rows = (ws.chapters || []).slice().sort((a, b) => a.chapter - b.chapter)

    // 这个角色出现过的段落
    const evidence = []
    for (const r of rows) {
      const t = await readTextSafe(r.path)
      if (!t.includes(name)) continue
      const paras = t
        .split(/\n+/u)
        .map((x) => x.trim())
        .filter((x) => x !== '' && x.includes(name))
      if (paras.length === 0) continue
      evidence.push({ chapter: r.chapter, paras: paras.slice(0, 2) })
      if (evidence.length >= 4) break
    }
    if (evidence.length === 0) throw new Error('正文里找不到「' + name + '」，没法猜')

    // 大纲里提到他的
    const outlineText = await readTextSafe(join(project.projectDir, '大纲.md'))
    const outlineHits = outlineText
      .split(/\n+/u)
      .map((x) => x.trim())
      .filter((x) => x !== '' && x.includes(name))
      .slice(0, 4)

    // 同书其他角色这个字段填了什么（保持风格一致的关键）
    const people = await enrichPeople(await W.readPeople(project.projectDir))
    const samples = []
    for (const q of people) {
      if (String(q.name).trim() === name) continue
      const v = q.raw === null || q.raw === undefined ? undefined : q.raw[field]
      const s = typeof v === 'string' ? v.trim() : ''
      if (s === '') continue
      samples.push(String(q.name) + '：' + s.slice(0, 40))
      if (samples.length >= 8) break
    }

    // 设定资料里提到他的地方（世界观常直接写着兽族/势力/境界，比正文更权威）
    const settingRel = ['设定/世界观.md', '设定/人物设定.md', '人物/主要人物列表.json', '设定/_口径.md', '细纲.md']
    const settingHits = []
    for (const rel of settingRel) {
      const text = await readTextSafe(join(project.projectDir, rel))
      if (text === '') continue
      const lines = text
        .split(/\n+/u)
        .map((x) => x.trim())
        .filter((x) => x !== '' && x.includes(name))
      if (lines.length > 0) settingHits.push({ rel, lines: lines.slice(0, 3) })
    }

    const material = [
      '【这个角色在正文里出现过的段落】',
      ...evidence.map((e) => '· 第' + String(e.chapter) + '章：' + e.paras.join(' / ')),
      '',
      '【大纲里提到他的地方】',
      outlineHits.length === 0 ? '（没有）' : outlineHits.map((x) => '· ' + x).join('\n'),
      '',
      '【设定资料里提到他的地方】',
      settingHits.length === 0
        ? '（没有）'
        : settingHits.map((s) => '《' + s.rel + '》\n' + s.lines.map((x) => '· ' + x).join('\n')).join('\n'),
      '',
      '【同书其他角色的「' + field + '」是怎么填的】',
      samples.length === 0 ? '（暂无参考）' : samples.map((x) => '· ' + x).join('\n'),
    ].join('\n')

    const system = [
      '你在帮作者填小说人物卡的某一个字段。',
      '',
      '规则：',
      '1. 材料里有依据就照实说；没有依据但同书其他角色这个字段有规律，就按规律给一个合理的值。',
      '2. **设定资料里的写法比正文更权威**：世界观写死的种族/势力/境界、口径里的称呼，照它来；',
      '   正文里顺口提的和设定冲突时，以设定为准。',
      '3. 只输出这个字段的值本身，不要字段名，不要解释，不要引号，不要句号。',
      '4. 尽量短：一个词或一个短语（不超过 20 字）。',
      '5. 完全没有任何线索时，给一个最普通、不抢戏的设定。',
    ].join('\n')

    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system,
      user: '角色名：' + name + '\n字段名：' + field + '\n当前值：' + (current === '' ? '（空）' : current) + '\n\n' + material,
      maxTokens: 200,
      timeoutMs: 60000,
    })

    let value = String(answer.text == null ? '' : answer.text).trim()
    // 模型偶尔会带前缀或引号，清一下
    value = value.replace(/^["「『'"']/u, '').replace(/["」』'"']$/u, '').trim()
    value = value.replace(new RegExp('^' + field + '\\s*[:：]\\s*', 'u'), '').trim()
    if (value === '') throw new Error('模型没给出内容，再点一次试试')
    if (value.length > 60) value = value.slice(0, 60)

    return { ok: true, name, field, value, model: route.provider + '/' + route.model }
  }

  /** 写入一张角色卡（新卡或覆盖） */
  const peopleCardSave = async (body) => {
    const project = await ensureProject()
    const name = String(body.name == null ? '' : body.name).trim()
    if (name === '') throw new Error('要指定角色名')
    const card = body.card
    if (card === null || typeof card !== 'object' || Array.isArray(card)) throw new Error('卡片内容不合法')

    const dir = join(project.projectDir, '人物')
    await mkdir(dir, { recursive: true })
    const file = safeFileName(name) + '.json'
    const full = join(dir, file)
    const info = await statSafe(full)
    if (info.exists && body.overwrite !== true) throw new Error('已经有这个角色的卡了：' + file)

    if (info.exists) {
      const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
      await mkdir(bakDir, { recursive: true })
      await writeFile(join(bakDir, file + ' ' + stampNow() + '.json'), await readTextSafe(full), 'utf8')
    }

    const finalCard = { ...card, 姓名: name }
    await writeFile(full, JSON.stringify(finalCard, null, 2) + '\n', 'utf8')
    return { ok: true, name, file, overwritten: info.exists === true }
  }

  /** 把确认的别称写进角色卡 */
  const peopleSetAliases = async (body) => {
    const project = await ensureProject()
    const name = String(body.name == null ? '' : body.name).trim()
    if (name === '') throw new Error('要指定角色')
    const aliases = Array.isArray(body.aliases) ? body.aliases.map((x) => String(x).trim()).filter((x) => x !== '') : []
    // 找到对应的卡文件
    const people = await W.readPeople(project.projectDir)
    const hit = people.find((p) => String(p.name).trim() === name)
    if (hit === undefined) throw new Error('没有这个角色的卡：' + name)
    const full = join(project.projectDir, '人物', hit.file)
    const info = await statSafe(full)
    if (!info.exists) throw new Error('卡文件不存在：' + hit.file)
    const raw = await readJsonSafe(full)
    if (raw === null || typeof raw !== 'object') throw new Error('卡文件不是合法 JSON：' + hit.file)
    // 备份
    const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
    await mkdir(bakDir, { recursive: true })
    await writeFile(join(bakDir, hit.file + ' ' + stampNow() + '.json'), JSON.stringify(raw, null, 2), 'utf8')
    // 支持两种写法：给 aliases 就整体覆盖，给 add 就在原基础上追加
    const prevAliases = aliasesOf(raw)
    const toAdd = Array.isArray(body.add) ? body.add.map((x) => String(x).trim()).filter((x) => x !== '') : []
    const finalAliases = aliases.length > 0 ? aliases : [...new Set([...prevAliases, ...toAdd])]
    const next = { ...raw, 别称: finalAliases }
    await writeFile(full, JSON.stringify(next, null, 2) + '\n', 'utf8')
    return { ok: true, name, aliases: finalAliases, file: hit.file }
  }

  /** 这本书需要的资料类别 */
  /**
   * 设定文件清单。
   *
   * `def` 只是「默认该放哪」，不是唯一合法位置——作者的习惯千差万别，
   * 把大纲放进 设定/ 完全是合理做法。所以单文件项可以给一组 `alts`，
   * 按顺序找，谁在就用谁；多文件项可以给 `match`，名字对得上就算这一类
   * （比如 第一卷细纲.md、第二卷细纲.md 不必挤在同一个目录里）。
   */
  const CHECK_SPEC = [
    {
      key: '大纲',
      def: '大纲.md',
      alts: ['设定/大纲.md', '设定/00-大纲.md', '设定/全书大纲.md', '设定/大纲/大纲.md'],
      note: '全书章节骨架，情节体检与开新章都读它',
    },
    {
      key: '细纲',
      def: '细纲/',
      multi: true,
      match: /细纲/u,
      alts: ['设定/细纲/'],
      createHint: { dir: '', name: '细纲.md' },
      note: '分卷或分章细纲，写具体章节时参考',
    },
    { key: '立项', def: '设定/立项.md', alts: ['立项.md', '设定/设定案.md'], note: '这本书要写什么、给谁看' },
    { key: '世界观', def: '设定/世界观.md', alts: ['世界观.md', '设定/世界观设定.md', '设定/世界观设定集.md'], note: '兽人形态、势力、地点、规则' },
    { key: '人物设定', def: '设定/人物设定.md', alts: ['人物设定.md', '设定/人物.md', '设定/人物总表.md'], note: '人物总表与关系' },
    { key: '写作口径', def: '设定/_口径.md', alts: ['设定/口径.md', '口径.md', '设定/写作口径.md'], note: '名字表、学校、时间线、写作技法' },
    { key: '道具与台账', def: '设定/道具与增益台账.md', alts: ['设定/道具与台账.md', '道具与增益台账.md'], note: '道具、钱、账目' },
    { key: '项目说明', def: '说明.md', note: '作品结构、目录约定、给接手的人看的' },
    { key: '原始设定案', def: '设定/00-原始设定案.md', note: '最初完整的设定稿，后期改了设定时回来对照' },
    {
      key: '角色卡',
      def: '人物/',
      alts: ['设定/人物/'],
      createHint: { dir: '人物', name: '' },
      note: '一人一张卡片，开新章时只读本章要用到的人',
      multi: true,
    },
    {
      key: '剧情总结',
      def: '剧情/',
      createHint: { dir: '剧情', name: '' },
      note: '每写完一章就写一份，写下一章时自动带进前情',
      multi: true,
    },
  ]

  // ══════════════════════════════════════════════════════════
  // 目录浏览：设置里不该靠手打路径
  // ══════════════════════════════════════════════════════════

  /**
   * 看一个目录像什么。
   * 只读目录项，不读文件内容，所以很快也很安全。
   */
  const probeDir = async (fullPath) => {
    let entries
    try {
      entries = await readdir(fullPath, { withFileTypes: true })
    } catch {
      return null
    }
    const dirs = []
    const files = []
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) dirs.push(e.name)
      else if (e.isFile()) files.push(e.name)
    }
    const dset = new Set(dirs)
    const fset = new Set(files)

    const marks = []
    if (dset.has('正文') || dset.has('章节')) marks.push('正文')
    if (dset.has('剧情')) marks.push('剧情')
    if (dset.has('设定')) marks.push('设定')
    if (dset.has('人物')) marks.push('人物')
    if (fset.has('大纲.md')) marks.push('大纲')

    // 判断这个目录本身是什么
    let kind = null
    let kindLabel = ''
    const isCandidateDeep = fullPath.split(/[\\/]/u).includes('候选稿')
    if (marks.includes('正文') || marks.includes('剧情') || marks.includes('大纲')) {
      kind = 'project'
      kindLabel = '作品根'
    } else if (isCandidateDeep && /第\s*\d+\s*章/u.test(basename(fullPath))) {
      kind = 'candidates'
      kindLabel = '候选目录'
    } else if (isCandidateDeep) {
      kind = 'candidates'
      kindLabel = '候选稿文件夹'
    }

    // 有 .dsh-novel-studio 说明里面还有东西
    const hasPluginData = entries.some((e) => e.name === '.dsh-novel-studio')

    return {
      path: fullPath,
      name: basename(fullPath),
      kind,
      kindLabel,
      marks,
      hasPluginData,
      dirs: dirs.slice(0, 200),
      fileCount: files.length,
    }
  }

  /**
   * 扫描起点。
   *
   * 不能从「当前作品」开始扫——那样只能看到这本书内部，
   * 隔壁的兄弟作品（比如 novels/ 下的另一本）根本扫不到。
   * 所以从当前作品的父目录起，并再往上兜一层，取一个能覆盖兄弟目录的位置。
   */
  const defaultBrowseRoot = async () => {
    try {
      const project = await ensureProject()
      // 当前作品的父目录：兄弟作品就在这一层或再下一层
      return dirname(project.projectDir)
    } catch {
      /* 没配作品就从用户目录找 */
    }
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const docs = join(home, 'Documents')
    try {
      await readdir(docs)
      return docs
    } catch {
      return home
    }
  }

  /**
   * 列一个目录下的子文件夹，顺带标出哪些像作品/候选稿。
   * 设置页的「浏览」用它。
   */
  const dirList = async (body) => {
    const raw = String(body.path == null ? '' : body.path).trim()
    const target = raw === '' ? await defaultBrowseRoot() : raw
    const self = await probeDir(target)
    if (self === null) throw new Error('读不到这个目录：' + target)

    const items = []
    for (const name of self.dirs) {
      const child = await probeDir(join(target, name))
      if (child === null) continue
      items.push({
        name: child.name,
        path: child.path,
        kind: child.kind,
        kindLabel: child.kindLabel,
        marks: child.marks,
        hasPluginData: child.hasPluginData,
      })
    }
    // 识别出来的排前面
    items.sort((a, b) => {
      const rank = (x) => (x.kind === 'project' ? 0 : x.kind === 'candidates' ? 1 : 2)
      const d = rank(a) - rank(b)
      return d !== 0 ? d : a.name.localeCompare(b.name, 'zh')
    })

    return {
      ok: true,
      path: target,
      name: self.name,
      parent: dirname(target) === target ? '' : dirname(target),
      self: {
        kind: self.kind,
        kindLabel: self.kindLabel,
        marks: self.marks,
        fileCount: self.fileCount,
      },
      items,
    }
  }

  /**
   * 从某个起点往下扫，把像作品的、像候选目录的都揪出来。
   * 深度限制 3 层，命中数上限 60，避免在大盘上漫游。
   */
  const dirDiscover = async (body) => {
    const raw = String(body.from == null ? '' : body.from).trim()
    // 深度 4：够到 Documents/分类/作品集/某本书 这种四层结构
    const maxDepth = Number.isInteger(body.depth) ? body.depth : 4
    const found = []
    const seen = new Set()

    // 起点不能只有一个：只从「当前作品的父目录」扫，切进深目录后
    // 上一层的那本书就看不见了。所以固定把用户文档目录也扫一遍，
    // 再补当前作品的父与祖父，三者取并集。
    let starts
    if (raw !== '') {
      starts = [raw]
    } else {
      const roots = []
      // 从当前作品往上爬 3 级：作品常放在 盘:\某目录\某目录\书 这种位置，
      // 爬两级到不了能看见兄弟作品的层级，爬太多又会扫整个盘。
      try {
        const project = await ensureProject()
        let cur = project.projectDir
        for (let i = 0; i < 3; i += 1) {
          const up = dirname(cur)
          if (up === cur) break
          // 到盘符根（D:\ 这种）就别再往上了，扫整盘太慢
          if (up.replace(/[\\/]+$/u, '').length <= 2) break
          roots.push(up)
          cur = up
        }
      } catch {
        /* 没配作品 */
      }
      // 用户文档目录兜底（作品可能不在同一块盘上）
      const home = process.env.USERPROFILE || process.env.HOME || ''
      if (home !== '') {
        const docs = join(home, 'Documents')
        try {
          await readdir(docs)
          roots.push(docs)
        } catch {
          /* 没有文档目录就跳过 */
        }
      }
      starts = [...new Set(roots)]
    }

    const walk = async (dir, depth) => {
      if (depth > maxDepth || found.length >= 60) return
      if (seen.has(dir)) return
      seen.add(dir)

      const info = await probeDir(dir)
      if (info === null) return
      if (info.kind !== null && !found.some((x) => x.path === info.path)) {
        found.push({
          path: info.path,
          name: info.name,
          kind: info.kind,
          kindLabel: info.kindLabel,
          marks: info.marks,
        })
        // 认出作品根就不再往里挖，它内部结构不是用户要选的
        if (info.kind === 'project') return
      }
      for (const name of info.dirs) {
        if (found.length >= 60) break
        await walk(join(dir, name), depth + 1)
      }
    }

    if (starts.length === 0) starts = [await defaultBrowseRoot()]
    for (const start of starts) {
      if (found.length >= 60) break
      await walk(start, 0)
    }

    // 标出哪一个是当前正在写的
    let currentPath = ''
    try {
      const project = await ensureProject()
      currentPath = project.projectDir
    } catch {
      currentPath = ''
    }
    for (const f of found) f.current = f.path === currentPath

    found.sort((a, b) => {
      // 当前作品排最前，然后按作品根优先
      if (a.current !== b.current) return a.current ? -1 : 1
      const rank = (x) => (x.kind === 'project' ? 0 : 1)
      const d = rank(a) - rank(b)
      return d !== 0 ? d : a.path.localeCompare(b.path)
    })
    return { ok: true, from: starts.join(' | '), starts, found, truncated: found.length >= 60 }
  }

  const filesList = async () => {
    const project = await ensureProject()
    const out = []
    const rootFiles = await cx.listFiles(project.projectDir, ['.md'])
    for (const f of rootFiles) out.push({ scope: '根目录', name: f.name, path: f.path, bytes: f.bytes, mtime: f.mtime })
    for (const d of ['设定', '人物', '剧情']) {
      const list = await cx.listFiles(join(project.projectDir, d), ['.md', '.json'])
      for (const f of list) out.push({ scope: d, name: f.name, path: f.path, bytes: f.bytes, mtime: f.mtime })
    }
    return { ok: true, files: out }
  }

  const filesChecklist = async () => {
    const project = await ensureProject()
    const map = await readFileMap(project.projectDir)
    const items = []
    const covered = new Set()

    // 内容指纹：硬链接/重复文件路径不同但大小和内容一样，
    // 只按路径去重会把 根目录/大纲.md（设定/00-大纲.md 的硬链接）又列成「其他文件」
    const coveredMark = new Map()
    // 内容指纹：硬链接/副本名字不同但内容一致。
    // 用「大小 + 前 200 字」当签名，比单看大小可靠，也不会误伤同大小无关文件。
    // 同一个文件的「身份」用它解析后的真实路径。
    // 作品里 人物/ 常常是指向 设定/人物/ 的目录链接（junction），
    // 同一个文件会以两条不同路径出现，只比字符串就会重复列出。
    const realKey = async (full) => {
      try {
        return (await realpath(full)).replace(/\\/gu, '/').toLowerCase()
      } catch {
        return String(full).replace(/\\/gu, '/').toLowerCase()
      }
    }
    const mark = async (full, bytes) => {
      covered.add(await realKey(full))
      coveredMark.set(String(bytes), { full, sig: null })
    }
    // 惰性算内容签名：只在 others 里遇到同大小文件时才去读，省 IO
    const signatureOf = async (full, bytes) => {
      const key = String(bytes)
      const hit = coveredMark.get(key)
      if (hit === undefined) return null
      if (hit.sig === null) hit.sig = (await readTextSafe(hit.full)).slice(0, 200)
      return hit.sig
    }
    const looksSame = async (full, bytes) => {
      const sig = await signatureOf(full, bytes)
      if (sig === null) return false
      const mine = (await readTextSafe(full)).slice(0, 200)
      return sig === mine
    }

    for (const spec of CHECK_SPEC) {
      if (spec.multi === true) {
        // 多文件项：默认目录 + 备选目录 + 按名字匹配（细纲散落在根目录/设定里也能认）
        const exts = spec.key === '角色卡' ? ['.json'] : ['.md']
        const seen = new Set()
        const merged = []
        const take = async (dirPath) => {
          const list = await cx.listFiles(dirPath, exts)
          for (const f of list) {
            // 用真实路径去重：人物/ 常是指向 设定/人物/ 的目录链接，
            // 两个目录会列出同一批文件，只比路径字符串就会每人出现两次。
            const k = await realKey(f.path)
            if (seen.has(k)) continue
            seen.add(k)
            merged.push(f)
          }
        }
        for (const rel of [spec.def, ...(spec.alts === undefined ? [] : spec.alts)]) {
          await take(join(project.projectDir, String(rel)))
        }
        if (spec.match instanceof RegExp) {
          for (const sub of ['', '设定', '剧情', '人物']) {
            await take(sub === '' ? project.projectDir : join(project.projectDir, sub))
          }
          for (let i = merged.length - 1; i >= 0; i -= 1) {
            if (!spec.match.test(merged[i].name)) merged.splice(i, 1)
          }
        }
        // 去重：已经被前面某一项认领的文件（比如 人物/主要人物列表.json 已经算「人物设定」），
        // 不再在「角色卡」里重复出现——同一个文件只属于一个类别。
        const list = []
        for (const f of merged) {
          if (covered.has(await realKey(f.path))) continue
          list.push(f)
        }
        for (const f of list) await mark(f.path, f.bytes)
        if (spec.key === '剧情总结') {
          list.sort((a, b) => {
            const ca = Number((/第\s*([0-9]+)\s*章/u.exec(a.name) || [])[1] || 0)
            const cb = Number((/第\s*([0-9]+)\s*章/u.exec(b.name) || [])[1] || 0)
            return ca - cb
          })
        }
        items.push({
          key: spec.key,
          note: spec.note,
          path: spec.def,
          multi: true,
          exists: list.length > 0,
          createHint: spec.createHint === undefined ? null : spec.createHint,
          files: list.map((f) => ({ name: f.name, path: f.path, rel: relative(project.projectDir, f.path).replace(/\\/gu, '/') })),
        })
        // 多文件类里每一个都要标记，否则第二个文件会漏到「其他文件」
        for (const f of list) await mark(f.path, f.bytes)
        continue
      }

      // 单文件类：先看归属表，再看默认路径与备选路径
      const bound = Array.isArray(map[spec.key]) ? map[spec.key] : []
      // 归属表里绑了几个就全标记成「已覆盖」，避免它们又出现在「其他文件」
      for (const rel of bound) {
        const full = join(project.projectDir, String(rel))
        const info = await statSafe(full)
        if (info.exists) await mark(full, info.bytes)
      }
      const candidates = [...bound, spec.def, ...(spec.alts === undefined ? [] : spec.alts)]
      let found = null
      for (const rel of candidates) {
        const full = join(project.projectDir, String(rel))
        const info = await statSafe(full)
        if (info.exists) {
          found = { rel: String(rel).replace(/\\/gu, '/'), full, bytes: info.bytes }
          break
        }
      }
      if (found !== null) await mark(found.full, found.bytes)
      items.push({
        key: spec.key,
        note: spec.note,
        path: found === null ? spec.def : found.rel,
        multi: false,
        exists: found !== null,
        files:
          found === null
            ? []
            : [{ name: basename(found.full), path: found.full, rel: found.rel.replace(/\\/gu, '/') }],
      })
    }

    const others = []
    const scanDirs = [
      { dir: project.projectDir, scope: '根目录' },
      { dir: join(project.projectDir, '设定'), scope: '设定' },
      { dir: join(project.projectDir, '人物'), scope: '人物' },
      { dir: join(project.projectDir, '剧情'), scope: '剧情' },
    ]
    for (const d of scanDirs) {
      const list = await cx.listFiles(d.dir, ['.md', '.json'])
      for (const f of list) {
        if (covered.has(f.path.replace(/\\/gu, '/').toLowerCase())) continue
        // 同名同大小视为同一份内容（硬链接、或复制出来的副本）
        if (await looksSame(f.path, f.bytes)) continue
        others.push({ name: f.name, path: f.path, rel: relative(project.projectDir, f.path).replace(/\\/gu, '/'), scope: d.scope, bytes: f.bytes })
      }
    }
    return { ok: true, items, others, projectDir: project.projectDir }
  }

  /** 读一个设定文件 */
  const fileRead = async (body) => {
    const project = await ensureProject()
    const raw = String(body.path ?? '')
    if (raw === '') throw new Error('要指定文件')
    const full = isAbsolute(raw) ? raw : join(project.projectDir, raw)
    const rel = relative(project.projectDir, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能读作品目录里的文件')
    const info = await statSafe(full)
    if (!info.exists) throw new Error('文件不存在：' + rel)
    const text = await readTextSafe(full)
    return { ok: true, path: full, rel, name: basename(full), text, chars: charCount(text) }
  }

  /** 写回一个设定文件（先备份） */
  const fileSave = async (body) => {
    const project = await ensureProject()
    const raw = String(body.path ?? '')
    if (raw === '') throw new Error('要指定文件')
    if (typeof body.text !== 'string') throw new Error('内容必须是字符串')
    const full = isAbsolute(raw) ? raw : join(project.projectDir, raw)
    const rel = relative(project.projectDir, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能写作品目录里的文件')
    const low = extname(full).toLowerCase()
    if (!['.md', '.txt', '.json'].includes(low)) throw new Error('只能编辑 .md / .txt / .json 文件')
    if (body.text.length > 4 * 1024 * 1024) throw new Error('文件太大（上限 4MB）')
    const info = await statSafe(full)
    if (!info.exists) throw new Error('文件不存在：' + rel)
    const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
    await mkdir(bakDir, { recursive: true })
    const backup = join(bakDir, rel.replace(/[\\/]/gu, '_') + ' ' + stampNow() + (low === '.json' ? '.json' : '.md'))
    await writeFile(backup, await readTextSafe(full), 'utf8')
    await enqueueWrite(full, () => writeFile(full, body.text, 'utf8'))
    return { ok: true, path: full, rel, chars: charCount(body.text), backup }
  }

  /**
   * 新建文件的目标路径校验。
   *
   * 以前只允许 根目录/设定/人物/剧情 四个位置，太死了——作者想建个
   * 细纲/ 或 设定/人物/ 都建不了。现在只要在作品目录内部、不是隐藏目录
   * （含插件自己的 .dsh-novel-studio）就行，目录不存在会顺手建出来。
   */
  const normalizeNewPath = (raw) => {
    const p = String(raw == null ? '' : raw).replace(/\\/gu, '/').trim()
    if (p === '') throw new Error('要填文件名')
    if (p.startsWith('/') || p.includes('..')) throw new Error('文件名不合法')
    const low = extname(p).toLowerCase()
    if (!['.md', '.txt', '.json'].includes(low)) throw new Error('只能建 .md / .txt / .json 文件')
    const dir = dirname(p) === '.' ? '' : dirname(p)
    for (const seg of dir === '' ? [] : dir.split('/')) {
      if (seg.startsWith('.')) throw new Error('不能建在隐藏目录里')
    }
    return p
  }

  const fileCreate = async (body) => {    const project = await ensureProject()
    const rel = normalizeNewPath(body.path)
    const full = join(project.projectDir, rel)
    const info = await statSafe(full)
    if (info.exists) throw new Error('已经存在同名文件：' + rel)
    const text = typeof body.text === 'string' ? body.text : ''
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text, 'utf8')
    return { ok: true, path: full, rel, chars: charCount(text) }
  }

  /**
   * 作品里现有的目录（相对路径），给「新建文件 → 放在哪儿」当选项。
   * 比写死四个目录好：细纲/、设定/人物/ 这类自定义目录也能直接选。
   */
  const filesDirs = async () => {
    const project = await ensureProject()
    const root = project.projectDir
    const out = [{ rel: '', label: '根目录' }]
    const walk = async (rel, depth) => {
      let entries = []
      try {
        entries = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true })
      } catch {
        return
      }
      const names = entries
        // 下划线开头的是插件自己的归档/备份目录，不给选
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'zh'))
      for (const name of names) {
        const childRel = rel === '' ? name : rel + '/' + name
        out.push({ rel: childRel, label: childRel + '/' })
        if (depth > 1) await walk(childRel, depth - 1)
      }
    }
    await walk('', 2)
    return { ok: true, dirs: out }
  }

  /**
   * 删一个设定文件：移进回收站的「设定文件」分区，不是物理删除。
   * 顺手把它从「文件归属.json」里摘掉，否则清单会指着一个已经不存在的路径。
   */
  const fileDelete = async (body) => {
    const project = await ensureProject()
    const raw = String(body.path ?? '')
    if (raw === '') throw new Error('要指定文件')
    const full = isAbsolute(raw) ? raw : join(project.projectDir, raw)
    const rel = relative(project.projectDir, full).replace(/\\/gu, '/')
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能删作品目录里的文件')
    const low = extname(full).toLowerCase()
    if (!['.md', '.txt', '.json'].includes(low)) throw new Error('只能删 .md / .txt / .json 文件')
    const info = await statSafe(full)
    if (!info.exists) throw new Error('文件不存在：' + rel)
    const trashDir = join(cx.stateDirOf(project.projectDir), '回收站', '设定文件')
    await mkdir(trashDir, { recursive: true })
    const flat = rel.replace(/[\\/]/gu, '_')
    const target = join(trashDir, `${stampNow()} ${flat}`)
    await rename(full, target)
    // 记下原路径，回收站里才能原样还回去（文件名里的下划线还原不了斜杠）
    const index = await readTrashFilesIndex(project.projectDir)
    index[basename(target)] = { rel, at: stampNow() }
    await writeTrashFilesIndex(project.projectDir, index)
    // 归属表里指向它的条目一并清掉
    const map = await readFileMap(project.projectDir)
    let touched = false
    for (const key of Object.keys(map)) {
      const list = Array.isArray(map[key]) ? map[key] : []
      const next = list.filter((x) => String(x).replace(/\\/gu, '/') !== rel)
      if (next.length !== list.length) {
        touched = true
        if (next.length === 0) delete map[key]
        else map[key] = next
      }
    }
    if (touched) await writeFileMap(project.projectDir, map)
    return { ok: true, rel, trashPath: target }
  }

  const fileAppend = async (body) => {
    const project = await ensureProject()
    const raw = String(body.path ?? '')
    if (raw === '') throw new Error('要指定文件')
    const full = isAbsolute(raw) ? raw : join(project.projectDir, raw)
    const rel = relative(project.projectDir, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能写作品目录里的文件')
    const info = await statSafe(full)
    if (!info.exists) throw new Error('文件不存在：' + rel)
    if (typeof body.text !== 'string' || body.text.trim() === '') throw new Error('要追加的内容是空的')
    const bakDir = join(cx.stateDirOf(project.projectDir), '备份')
    await mkdir(bakDir, { recursive: true })
    await writeFile(join(bakDir, rel.replace(/[\\/]/gu, '_') + ' ' + stampNow() + '.md'), await readTextSafe(full), 'utf8')
    const before = await readTextSafe(full)
    const sep = before.endsWith('\n') ? '\n' : '\n\n'
    const next = before + sep + body.text + (body.text.endsWith('\n') ? '' : '\n')
    await enqueueWrite(full, () => writeFile(full, next, 'utf8'))
    return { ok: true, path: full, rel, addedChars: charCount(body.text), totalChars: charCount(next) }
  }

  const CLASSIFY_SYSTEM = [
    '你是小说项目的资料管理员。作者给你一段文本，你要判断它该放进这本书的哪个文件。',
    '',
    '这本书现有的资料结构：',
    '- 大纲.md —— 全书章节骨架',
    '- 设定/立项.md —— 这本书要写什么、给谁看',
    '- 设定/世界观.md —— 兽人形态、势力、地点、规则',
    '- 设定/人物设定.md —— 人物总表与关系',
    '- 设定/_口径.md —— 名字表、学校、时间线、写作技法、禁忌',
    '- 设定/道具与增益台账.md —— 道具、钱、账目',
    '- 人物/ —— 一人一张 JSON 卡',
    '- 剧情/ —— 每章剧情总结',
    '',
    '只输出一个 JSON 对象，不要别的内容，不要代码围栏：',
    '{"target":"文件路径","mode":"append 或 create","reason":"一句话说明","note":"人物卡建议文件名，否则留空"}',
    '',
    '判断规则：',
    '1. 讲人物长相/性格/关系 → 人物/ 下建卡（create，note 填「姓名.json」）',
    '2. 讲势力、地点、种族规则 → 设定/世界观.md（append）',
    '3. 讲某章发生什么 → 大纲.md（append）',
    '4. 讲道具、钱、账目 → 设定/道具与增益台账.md（append）',
    '5. 讲写作要求、名字禁忌、时间线 → 设定/_口径.md（append）',
    '6. 拿不准 → 设定/世界观.md（append），reason 里说明拿不准',
  ].join('\n')

  const fileClassify = async (body) => {
    const project = await ensureProject()
    const text = String(body.text == null ? '' : body.text).trim()
    if (text === '') throw new Error('先把要归档的内容贴进来')
    if (text.length > 20000) throw new Error('一次最多归档 2 万字')
    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: CLASSIFY_SYSTEM,
      user: '要归档的内容：\n\n' + text,
      maxTokens: 400,
      timeoutMs: 60000,
    })
    let raw = String(answer.text || '').trim()
    const fence = String.fromCharCode(96, 96, 96)
    if (raw.startsWith(fence)) {
      const i = raw.indexOf('\n')
      raw = i === -1 ? '' : raw.slice(i + 1)
    }
    const j = raw.lastIndexOf(fence)
    if (j !== -1) raw = raw.slice(0, j)
    const l = raw.indexOf('{')
    const r = raw.lastIndexOf('}')
    if (l === -1 || r === -1 || r <= l) throw new Error('模型没给出可用的判断：' + raw.slice(0, 120))
    let parsed = null
    try {
      parsed = JSON.parse(raw.slice(l, r + 1))
    } catch {
      throw new Error('模型输出不是合法 JSON：' + raw.slice(0, 120))
    }
    const target = String(parsed.target == null ? '' : parsed.target).replace(/\\/gu, '/').trim()
    if (target === '') throw new Error('模型没给出目标文件')
    const mode = String(parsed.mode == null ? 'append' : parsed.mode).trim() === 'create' ? 'create' : 'append'
    return {
      ok: true,
      target,
      mode,
      reason: String(parsed.reason == null ? '' : parsed.reason),
      note: String(parsed.note == null ? '' : parsed.note),
      model: route.provider + '/' + route.model,
      textChars: charCount(text),
    }
  }

  // ── 扫描文件夹，让模型认领文件 ──
  /**
   * 「识别」用的提示词。
   *
   * 以前这里是写死的八个类别，结果 CHECK_SPEC 后来加的「细纲」「项目说明」
   * 「原始设定案」模型根本不知道，永远认不出来。现在直接按 CHECK_SPEC 生成，
   * 清单加一项，这里自动跟着加。
   */
  const classifyFilesPrompt = () => {
    const lines = CHECK_SPEC.map((s) => {
      let where = ''
      if (s.multi === true) {
        const byName = s.match instanceof RegExp ? '，或文件名含「' + s.match.source + '」' : ''
        where = '（目录 ' + s.def + byName + '）'
      } else {
        const alts = s.alts === undefined || s.alts.length === 0 ? '' : '，也可能叫 ' + s.alts.join(' / ')
        where = '（一般叫 ' + s.def + alts + '）'
      }
      return '- ' + s.key + '：' + s.note + where
    })
    return [
      '你是小说项目的资料管理员。作者把这本书的资料放在一个文件夹里，命名各式各样。',
      '你的活是：判断每个文件属于下面哪一类资料。',
      '',
      '类别（key 必须严格用下面这些之一）：',
      CHECK_SPEC.map((s) => s.key).join(' / '),
      '',
      '含义：',
      ...lines,
      '',
      '只输出一个 JSON 数组，不要别的内容，不要代码围栏：',
      '[{"index":1,"key":"世界观"},{"index":2,"key":""}]',
      '',
      '规则：',
      '1. 判断不了就留空字符串，不要硬塞。',
      '2. 只按文件名和所在目录判断。',
      '3. 每个 index 都要出现一次。',
      '4. 名字里带「总大纲」「全书大纲」的算大纲；带「细纲」「分卷」的算细纲。',
    ].join('\n')
  }

  const filesScan = async () => {
    const project = await ensureProject()
    const map = await readFileMap(project.projectDir)
    const known = new Set()
    for (const list of Object.values(map)) {
      for (const rel of Array.isArray(list) ? list : []) known.add(String(rel).replace(/\\/gu, '/').toLowerCase())
    }
    // 多文件类（角色卡、剧情总结、细纲）整目录都算「已知」，
    // 不然 人物/ 下的每一张卡都会被抓去让模型分类——它们本来就是角色卡。
    const knownDirs = []
    const matchSpecs = []
    for (const spec of CHECK_SPEC) {
      const alts = spec.alts === undefined ? [] : spec.alts
      for (const p of [spec.def, ...alts]) {
        const rel = String(p).replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
        if (spec.multi === true) knownDirs.push(rel)
        else known.add(rel)
      }
      if (spec.match instanceof RegExp) matchSpecs.push(spec.match)
    }

    const candidates = []
    const scanDirs = [
      { dir: project.projectDir, scope: '根目录' },
      { dir: join(project.projectDir, '设定'), scope: '设定' },
      { dir: join(project.projectDir, '人物'), scope: '人物' },
      { dir: join(project.projectDir, '剧情'), scope: '剧情' },
    ]
    for (const d of scanDirs) {
      const list = await cx.listFiles(d.dir, ['.md', '.json'])
      for (const f of list) {
        const rel = relative(project.projectDir, f.path).replace(/\\/gu, '/')
        const low = rel.toLowerCase()
        if (known.has(low)) continue
        // 已经在多文件类的目录里就不必再问模型。
        // 注意「人物」是「设定/人物」的目录链接，同一个文件会以两条路径出现，
        // 所以除了 人物/xxx 还要认 设定/人物/xxx。
        const inMultiDir = knownDirs.some((kd) => {
          if (low.startsWith(kd + '/')) return true
          // 目录链接：多文件类的 def 也许挂在另一个目录下（如 设定/人物）
          if (kd.includes('/')) return low.startsWith(kd + '/')
          return low.startsWith('设定/' + kd + '/') || low.startsWith('剧情/' + kd + '/')
        })
        if (inMultiDir) continue
        // 名字能对上某个多文件类的模式（比如 第一卷细纲.md）也算已归位
        if (matchSpecs.some((re) => re.test(f.name))) continue
        candidates.push({ rel, scope: d.scope, name: f.name, bytes: f.bytes })
      }
    }
    if (candidates.length === 0) return { ok: true, assignments: [], scanned: 0 }

    const lines = candidates.map((c, i) => String(i + 1) + '. [' + c.scope + '] ' + c.name)
    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: classifyFilesPrompt(),
      user: '文件清单：\n' + lines.join('\n'),
      maxTokens: 1200,
      timeoutMs: 90000,
    })
    let raw = String(answer.text || '').trim()
    const fence = String.fromCharCode(96, 96, 96)
    if (raw.startsWith(fence)) {
      const i = raw.indexOf('\n')
      raw = i === -1 ? '' : raw.slice(i + 1)
    }
    const j = raw.lastIndexOf(fence)
    if (j !== -1) raw = raw.slice(0, j)
    const l = raw.indexOf('[')
    const r = raw.lastIndexOf(']')
    if (l === -1 || r === -1 || r <= l) throw new Error('模型没给出可用的判断：' + raw.slice(0, 120))
    let parsed = null
    try {
      parsed = JSON.parse(raw.slice(l, r + 1))
    } catch {
      throw new Error('模型输出不是合法数组：' + raw.slice(0, 120))
    }
    const validKeys = new Set(CHECK_SPEC.map((x) => x.key))
    const assignments = []
    // 同一个文件只认一次：模型偶尔会把一个文件同时算进两类，
    // 这里按「先出现的类别」留下，后面的丢掉，并标记 duplicateOf 方便界面提示。
    const taken = new Map()
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const idx = Number(item == null ? NaN : item.index)
      const key = String(item == null ? '' : item.key == null ? '' : item.key).trim()
      if (!Number.isInteger(idx) || idx < 1 || idx > candidates.length) continue
      if (!validKeys.has(key)) continue
      const c = candidates[idx - 1]
      const hit = taken.get(c.rel)
      if (hit !== undefined) {
        if (hit !== key) assignments.push({ key, rel: c.rel, name: c.name, scope: c.scope, duplicateOf: hit, skip: true })
        continue
      }
      taken.set(c.rel, key)
      assignments.push({ key, rel: c.rel, name: c.name, scope: c.scope })
    }
    return { ok: true, assignments, scanned: candidates.length, model: route.provider + '/' + route.model }
  }

  const filesBind = async (body) => {
    const project = await ensureProject()
    const list = Array.isArray(body.assignments) ? body.assignments : []
    if (list.length === 0) throw new Error('没有要保存的归属')
    const map = await readFileMap(project.projectDir)
    const validKeys = new Set(CHECK_SPEC.map((x) => x.key))
    let n = 0
    for (const a of list) {
      const key = String(a == null ? '' : a.key)
      const rel = String(a == null ? '' : a.rel == null ? '' : a.rel).replace(/\\/gu, '/')
      if (!validKeys.has(key) || rel === '' || rel.includes('..')) continue
      const arr = Array.isArray(map[key]) ? map[key] : []
      if (!arr.includes(rel)) arr.push(rel)
      map[key] = arr
      n += 1
    }
    if (n === 0) throw new Error('没有有效的归属')
    await writeFileMap(project.projectDir, map)
    return { ok: true, saved: n, map }
  }

  /**
   * 把一个文件从原来的类别挪到另一个类别（界面里拖拽用）。
   * 一个文件只属于一个类别，所以先把它从所有类别里摘掉再绑。
   */
  const filesMove = async (body) => {
    const project = await ensureProject()
    const key = String(body.key == null ? '' : body.key)
    const rel = String(body.rel == null ? '' : body.rel).replace(/\\/gu, '/')
    if (rel === '' || rel.includes('..')) throw new Error('文件路径不合法')
    const validKeys = new Set(CHECK_SPEC.map((x) => x.key))
    if (!validKeys.has(key)) throw new Error('没有这个类别：' + key)
    const map = await readFileMap(project.projectDir)
    let from = ''
    for (const k of Object.keys(map)) {
      const arr = Array.isArray(map[k]) ? map[k] : []
      const idx = arr.findIndex((x) => String(x).replace(/\\/gu, '/') === rel)
      if (idx === -1) continue
      from = k
      arr.splice(idx, 1)
      if (arr.length === 0) delete map[k]
      else map[k] = arr
    }
    const arr = Array.isArray(map[key]) ? map[key] : []
    if (!arr.includes(rel)) arr.push(rel)
    map[key] = arr
    await writeFileMap(project.projectDir, map)
    return { ok: true, from, to: key, rel, map }
  }

  // ══════════════════════════════════════════════════════════
  // 配置
  // ══════════════════════════════════════════════════════════
  /**
   * 只推导、不保存：给某个作品算它的候选目录。
   *
   * 选候选目录时，作者看到的多半是「作品根」——直接点它应该自动落到
   * 该作品下的 候选稿/第{下一章}章，而不是逼他自己往下翻三层。
   */
  const dirCandidateOf = async (body) => {
    const target = String(body.projectDir == null ? '' : body.projectDir).trim()
    if (target === '') throw new Error('要指定作品目录')
    const probe = await probeDir(target)
    if (probe === null) throw new Error('读不到这个目录：' + target)
    if (probe.kind !== 'project') {
      throw new Error('这个目录不像作品根——里面要有 正文/ 或 剧情/ 或 大纲.md')
    }
    let nextChapter = 1
    let chapterCount = 0
    try {
      const ws = await W.readWorkspace(target, { name: probe.name, runsRoot: '' })
      const list = (ws.chapters || []).map((c) => c.chapter).filter((n) => Number.isInteger(n))
      chapterCount = list.length
      nextChapter = list.length === 0 ? 1 : Math.max(...list) + 1
    } catch {
      /* 读不出来就按第1章 */
    }
    return {
      ok: true,
      projectDir: target,
      name: probe.name,
      candidateDir: join(target, '.dsh-novel-studio', '候选稿', '第' + String(nextChapter) + '章'),
      nextChapter,
      chapterCount,
    }
  }

  /**
   * 切换作品。
   *
   * 不能只改 projectDir：候选目录还指着旧书的话，下一章会写错地方。
   * 所以这里连候选目录一起推导——新作品下 .dsh-novel-studio/候选稿/第{下一章}章。
   */
  const bookSwitch = async (body) => {
    const target = String(body.projectDir == null ? '' : body.projectDir).trim()
    if (target === '') throw new Error('要指定作品目录')
    const probe = await probeDir(target)
    if (probe === null) throw new Error('读不到这个目录：' + target)
    if (probe.kind !== 'project') {
      throw new Error('这个目录不像作品根——里面要有 正文/ 或 剧情/ 或 大纲.md')
    }
    // 数一下已有章节，推导下一章的候选目录
    let nextChapter = 1
    let chapterCount = 0
    try {
      const ws = await W.readWorkspace(target, { name: probe.name, runsRoot: '' })
      const list = (ws.chapters || []).map((c) => c.chapter).filter((n) => Number.isInteger(n))
      chapterCount = list.length
      nextChapter = list.length === 0 ? 1 : Math.max(...list) + 1
    } catch {
      /* 读不出来就按第1章 */
    }
    const candidateDir = join(target, '.dsh-novel-studio', '候选稿', '第' + String(nextChapter) + '章')
    await cx.saveConfig({ projectDir: target, candidateDir })
    cx.resetProject()
    return {
      ok: true,
      projectDir: target,
      candidateDir,
      nextChapter,
      chapterCount,
      name: probe.name,
    }
  }

  // ══════════════════════════════════════════════════════════
  // 从成品小说学习：上传 → 切块 → 粗扫 → 精读 → 汇总
  // ══════════════════════════════════════════════════════════

  /** 学习任务的存档目录 */
  const learnDirOf = async () => {
    const home = process.env.USERPROFILE || process.env.HOME || '.'
    const dir = join(home, '.dsh', 'novel-learn')
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** 上传：收 base64，解析成文本，切块，存起来 */
  const learnImport = async (body) => {
    const name = String(body.name == null ? '' : body.name).trim()
    const b64 = String(body.data == null ? '' : body.data)
    if (name === '') throw new Error('要带文件名')
    if (b64 === '') throw new Error('文件是空的')

    let buf
    try {
      buf = Buffer.from(b64, 'base64')
    } catch {
      throw new Error('文件数据不是有效的 base64')
    }
    if (buf.length === 0) throw new Error('文件是空的')
    if (buf.length > 40 * 1024 * 1024) throw new Error('文件太大（上限 40MB）')

    const { text, format } = readNovelFile(name, buf)
    const targetChars = Number.isInteger(body.targetChars) ? Math.min(Math.max(body.targetChars, 2000), 20000) : 8000
    const chunks = chunkNovel(text, { targetChars })

    const dir = await learnDirOf()
    const taskId = stampNow().replace(/[^0-9]/gu, '') + '-' + String(Math.abs(name.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 10000)
    const taskDir = join(dir, taskId)
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, '全书.txt'), text, 'utf8')
    await writeFile(join(taskDir, 'meta.json'), JSON.stringify({ name, format, chars: text.length, chunks: chunks.length, targetChars, createdAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
    await writeFile(join(taskDir, 'chunks.json'), JSON.stringify(chunks.map((c) => ({ index: c.index, title: c.title, chars: c.chars })), null, 2) + '\n', 'utf8')
    // 每块单独存，精读时按需读，避免整本反复进内存
    const cdir = join(taskDir, '块')
    await mkdir(cdir, { recursive: true })
    for (const c of chunks) {
      await writeFile(join(cdir, String(c.index) + '.txt'), c.text, 'utf8')
    }

    return {
      ok: true,
      taskId,
      name,
      format,
      chars: text.length,
      chunks: chunks.length,
      preview: chunks.slice(0, 5).map((c) => ({ index: c.index, title: c.title, chars: c.chars })),
    }
  }

  /** 粗扫一批块：模型判断哪些值得精读（不花钱就先别调） */
  const learnScan = async (body) => {
    const taskId = String(body.taskId == null ? '' : body.taskId).trim()
    if (taskId === '') throw new Error('要指定任务')
    const dir = join(await learnDirOf(), taskId)
    const meta = await readJsonSafe(join(dir, 'meta.json'))
    if (meta === null) throw new Error('找不到这个任务：' + taskId)

    const allChunks = await readJsonSafe(join(dir, 'chunks.json'))
    if (!Array.isArray(allChunks)) throw new Error('任务数据坏了')

    const batchSize = Number.isInteger(body.batchSize) ? Math.min(Math.max(body.batchSize, 10), 80) : 40
    const from = Number.isInteger(body.from) ? Math.max(body.from, 0) : 0
    const to = Math.min(from + batchSize, allChunks.length)
    if (from >= allChunks.length) throw new Error('已经扫完了')

    // 读这批块的正文
    const batch = []
    for (let i = from; i < to; i += 1) {
      const t = await readTextSafe(join(dir, '块', String(i) + '.txt'))
      batch.push({ index: i, title: allChunks[i].title, text: t, chars: t.length })
    }

    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: SCAN_SYSTEM.replace('这次给你的是第 X 块到第 Y 块。', SCAN_SYSTEM_TAIL.replace('{from}', String(from + 1)).replace('{to}', String(to)).replace('{total}', String(allChunks.length))),
      user: buildScanInput(batch, outlineOf, 200, 100),
      maxTokens: 3000,
      timeoutMs: 180000,
    })

    const verdicts = parseScan(answer.text)
    // 存下来（断点续扫）
    const scanPath = join(dir, 'scan.json')
    const prev = (await readJsonSafe(scanPath)) || {}
    for (const v of verdicts) prev[String(v.i)] = v
    await writeFile(scanPath, JSON.stringify(prev, null, 2) + '\n', 'utf8')

    // 只推进到「这一批真正拿到判定的最后一块」，没判到的下一批重来。
    // 否则模型少回几条，那几块就被永久跳过了。
    let covered = from
    for (const v of verdicts) {
      if (v.i + 1 > covered) covered = v.i + 1
    }
    // 一条判定都没有：说明这批完全失败，进一格避免死循环，但会记录
    const next = verdicts.length === 0 ? Math.min(from + 1, allChunks.length) : covered

    return {
      ok: true,
      taskId,
      from,
      to: next,
      batchEnd: to,
      total: allChunks.length,
      got: verdicts.length,
      scanned: Object.keys(prev).length,
      done: next >= allChunks.length,
      model: route.provider + '/' + route.model,
    }
  }

  /** 精读一块 */
  const learnDigest = async (body) => {
    const taskId = String(body.taskId == null ? '' : body.taskId).trim()
    if (taskId === '') throw new Error('要指定任务')
    const index = Number(body.index)
    if (!Number.isInteger(index) || index < 0) throw new Error('块号不合法')

    const dir = join(await learnDirOf(), taskId)
    const text = await readTextSafe(join(dir, '块', String(index) + '.txt'))
    if (text === '') throw new Error('找不到第 ' + String(index + 1) + ' 块')

    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: DIGEST_SYSTEM,
      user: text,
      maxTokens: 1500,
      timeoutMs: 180000,
    })

    const d = parseDigest(answer.text)
    const digestPath = join(dir, 'digest.json')
    const prev = (await readJsonSafe(digestPath)) || {}
    prev[String(index)] = d
    await writeFile(digestPath, JSON.stringify(prev, null, 2) + '\n', 'utf8')

    return { ok: true, taskId, index, digest: d, prefer: d.prefer.length, avoid: d.avoid.length, model: route.provider + '/' + route.model }
  }

  /** 汇总成报告 */
  const learnSummarize = async (body) => {
    const taskId = String(body.taskId == null ? '' : body.taskId).trim()
    if (taskId === '') throw new Error('要指定任务')
    const dir = join(await learnDirOf(), taskId)
    const meta = await readJsonSafe(join(dir, 'meta.json'))
    if (meta === null) throw new Error('找不到这个任务')

    const digestMap = (await readJsonSafe(join(dir, 'digest.json'))) || {}
    const allChunks = (await readJsonSafe(join(dir, 'chunks.json'))) || []
    const list = Object.keys(digestMap)
      .map((k) => ({ ...digestMap[k], index: Number(k), title: allChunks[Number(k)] === undefined ? '' : allChunks[Number(k)].title }))
      .sort((a, b) => a.index - b.index)
    if (list.length === 0) throw new Error('还没有精读结果，先跑精读')

    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: SUMMARIZE_SYSTEM,
      user: buildSummarizeInput(list, { name: meta.name, total: meta.chunks }),
      maxTokens: 3000,
      timeoutMs: 240000,
    })

    const report = parseSummaryReport(answer.text)
    await writeFile(join(dir, '报告.md'), answer.text, 'utf8')
    await writeFile(join(dir, '报告.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')

    return {
      ok: true,
      taskId,
      report,
      digested: list.length,
      total: meta.chunks,
      model: route.provider + '/' + route.model,
    }
  }

  /** 任务列表 */
  const learnList = async () => {
    const dir = await learnDirOf()
    let names = []
    try {
      names = await readdir(dir, { withFileTypes: true }).then((x) => x.filter((e) => e.isDirectory()).map((e) => e.name))
    } catch {
      return { ok: true, tasks: [] }
    }
    const tasks = []
    for (const n of names) {
      const d = join(dir, n)
      const meta = await readJsonSafe(join(d, 'meta.json'))
      if (meta === null) continue
      const scan = (await readJsonSafe(join(d, 'scan.json'))) || {}
      const digest = (await readJsonSafe(join(d, 'digest.json'))) || {}
      const keep = Object.values(scan).filter((v) => v !== null && typeof v === 'object' && v.keep === true).length
      tasks.push({
        taskId: n,
        name: meta.name,
        format: meta.format,
        chars: meta.chars,
        chunks: meta.chunks,
        scanned: Object.keys(scan).length,
        keep,
        digested: Object.keys(digest).length,
        hasReport: (await readTextSafe(join(d, '报告.md'))) !== '',
        createdAt: meta.createdAt,
      })
    }
    tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return { ok: true, tasks }
  }

  /** 读任务详情：扫描判定、精读结果、报告 */
  const learnGet = async (body) => {
    const taskId = String(body.taskId == null ? '' : body.taskId).trim()
    if (taskId === '') throw new Error('要指定任务')
    const dir = join(await learnDirOf(), taskId)
    const meta = await readJsonSafe(join(dir, 'meta.json'))
    if (meta === null) throw new Error('找不到这个任务：' + taskId)
    const chunks = (await readJsonSafe(join(dir, 'chunks.json'))) || []
    const scan = (await readJsonSafe(join(dir, 'scan.json'))) || {}
    const digest = (await readJsonSafe(join(dir, 'digest.json'))) || {}
    const report = await readJsonSafe(join(dir, '报告.json'))
    const reportMd = await readTextSafe(join(dir, '报告.md'))

    const verdicts = chunks.map((c) => {
      const v = scan[String(c.index)]
      return {
        index: c.index,
        title: c.title,
        chars: c.chars,
        decided: v !== undefined,
        keep: v === undefined ? null : v.keep === true,
        why: v === undefined ? '' : String(v.why == null ? '' : v.why),
        digested: digest[String(c.index)] !== undefined,
      }
    })

    return { ok: true, taskId, meta, verdicts, report: report === null ? null : report, reportMd, digested: Object.keys(digest).length }
  }

  /** 删任务 */
  const learnDelete = async (body) => {
    const taskId = String(body.taskId == null ? '' : body.taskId).trim()
    if (taskId === '') throw new Error('要指定任务')
    // 注意：statSafe 对目录返回 exists:false，不能用它判断目录在不在
    const dir = join(await learnDirOf(), taskId)
    let found = true
    try {
      await readdir(dir)
    } catch {
      found = false
    }
    if (!found) throw new Error('找不到这个任务')
    await rm(dir, { recursive: true, force: true })
    return { ok: true, taskId }
  }

  /**
   * 弹系统的「选择文件夹」对话框，把用户手动挑的路径回传。
   *
   * dsh web 跑在本机同一个用户会话里，所以后端能起一个带窗口的进程。
   * Windows 用 PowerShell 的 FolderBrowserDialog（必须 -STA），macOS 用 osascript。
   * 用户取消返回 canceled:true；超过 5 分钟没关就当取消，别让请求永远挂着。
   */
  const runPicker = (cmd, args, timeoutMs) =>
    new Promise((resolve) => {
      let out = ''
      let err = ''
      let child = null
      try {
        child = spawn(cmd, args, { windowsHide: false })
      } catch (e) {
        resolve({ code: -1, out: '', err: String(e.message || e) })
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 杀不掉就放着，反正只影响这一个进程 */
        }
        resolve({ code: -2, out, err: '对话框超时没关' })
      }, timeoutMs)
      if (child.stdout !== null && child.stdout !== undefined) child.stdout.on('data', (d) => { out += String(d) })
      if (child.stderr !== null && child.stderr !== undefined) child.stderr.on('data', (d) => { err += String(d) })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ code: -1, out, err: String(e.message || e) })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, out, err })
      })
    })

  const dirBrowse = async (body) => {
    const raw = String(body.title == null ? '' : body.title).trim().slice(0, 60)
    const title = raw === '' ? '选择文件夹' : raw
    const timeoutMs = 5 * 60 * 1000
    if (process.platform === 'win32') {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$dlg.Description = '" + title.replace(/'/gu, "''") + "'",
        '$dlg.ShowNewFolderButton = $true',
        'try {',
        '  $owner = New-Object System.Windows.Forms.Form',
        "  $owner.TopMost = $true",
        '  $owner.ShowInTaskbar = $false',
        '  $owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
        '  $owner.Show()',
        '  $r = $dlg.ShowDialog($owner)',
        '  $owner.Close()',
        '} catch {',
        '  $r = $dlg.ShowDialog()',
        '}',
        'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }',
      ].join('\n')
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const r = await runPicker('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], timeoutMs)
      if (r.code === -2) return { ok: true, canceled: true, reason: r.err }
      const picked = String(r.out).trim().split(/\r?\n/u).pop() || ''
      if (picked === '') {
        // 报错（比如没有窗口会话）时把 stderr 带回去，界面能说清原因
        if (r.code !== 0 && String(r.err).trim() !== '') return { ok: true, canceled: true, reason: String(r.err).trim().slice(0, 300) }
        return { ok: true, canceled: true }
      }
      return { ok: true, canceled: false, path: picked }
    }
    if (process.platform === 'darwin') {
      const apple = 'POSIX path of (choose folder with prompt "' + title.replace(/["\\]/gu, '') + '")'
      const r = await runPicker('osascript', ['-e', apple], timeoutMs)
      if (r.code === -2) return { ok: true, canceled: true, reason: r.err }
      const picked = String(r.out).trim()
      if (picked === '') return { ok: true, canceled: true }
      return { ok: true, canceled: false, path: picked.replace(/\/$/u, '') }
    }
    throw new Error('系统文件夹对话框只在 Windows / macOS 上支持；当前系统请直接粘贴路径')
  }

  /**
   * 在系统的文件管理器里定位一个文件。
   *
   * 只允许作品目录内部的路径——不给它变成「打开任意位置」的口子。
   * 打开失败不抛错，把路径回传，界面可以让用户自己复制。
   */
  const pathReveal = async (body) => {
    const project = await ensureProject()
    const target = String(body.path == null ? '' : body.path).trim()
    if (target === '') throw new Error('要指定文件')
    const full = resolve(target)
    const root = resolve(project.projectDir)
    if (full !== root && !full.startsWith(root + sep)) throw new Error('只能定位作品目录里的文件')
    const info = await statSafe(full)
    if (!info.exists) throw new Error('文件不存在：' + basename(full))
    // 注意 Windows 上必须把 "/select," 和路径分成两个参数传：
    // 合成一个字符串再让 Node 去引号，explorer 常常只打开文件夹、不选中文件。
    const opener =
      process.platform === 'win32'
        ? ['explorer.exe', ['/select,', full]]
        : process.platform === 'darwin'
          ? ['open', ['-R', full]]
          : ['xdg-open', [dirname(full)]]
    try {
      const cp = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' })
      cp.unref()
      return { ok: true, opened: true, path: full, dir: dirname(full) }
    } catch (e) {
      return { ok: true, opened: false, path: full, dir: dirname(full), reason: String(e.message || e) }
    }
  }

  // ══════════════════════════════════════════════════════════
  // 指令（硬约束）
  // ══════════════════════════════════════════════════════════
  const rulesGet = async () => {
    const project = await ensureProject()
    const r = await RULES.readRules(project.projectDir)
    return {
      ok: true,
      items: r.items,
      trash: r.trash,
      fromDefaults: r.fromDefaults,
      defaults: RULES.DEFAULT_RULES,
      active: RULES.activeCount(r.items),
      mustDo: RULES.mustDo(r.items).length,
      mustNot: RULES.mustNot(r.items).length,
      block: RULES.rulesBlock(r.items),
    }
  }

  // ── 指令回收站：删除只是挪进回收站，能恢复，也能彻底删 ──
  const rulesDelete = async (body) => {
    const project = await ensureProject()
    const id = String(body.id == null ? '' : body.id)
    if (id === '') throw new Error('要指定删哪一条')
    const r = await RULES.deleteRule(project.projectDir, id)
    return { ok: true, items: r.items, trash: r.trash }
  }

  const rulesRestore = async (body) => {
    const project = await ensureProject()
    const id = String(body.id == null ? '' : body.id)
    if (id === '') throw new Error('要指定恢复哪一条')
    const r = await RULES.restoreRule(project.projectDir, id)
    return { ok: true, items: r.items, trash: r.trash }
  }

  const rulesPurge = async (body) => {
    const project = await ensureProject()
    const id = String(body.id == null ? '' : body.id)
    if (id === '') throw new Error('要指定彻底删哪一条')
    const r = await RULES.purgeRule(project.projectDir, id)
    return { ok: true, items: r.items, trash: r.trash }
  }

  const rulesPurgeAll = async () => {
    const project = await ensureProject()
    const r = await RULES.purgeAllRules(project.projectDir)
    return { ok: true, items: r.items, trash: r.trash, removed: r.removed }
  }

  const rulesSave = async (body) => {
    const project = await ensureProject()
    const items = await RULES.writeRules(project.projectDir, body.items)
    return { ok: true, items, active: RULES.activeCount(items) }
  }

  const rulesReset = async () => {
    const project = await ensureProject()
    const items = await RULES.writeRules(project.projectDir, RULES.DEFAULT_RULES)
    return { ok: true, items, active: RULES.activeCount(items) }
  }

  const configSave = async (body) => {
    const patch = {}
    if (typeof body.candidateDir === 'string') patch.candidateDir = body.candidateDir
    if (typeof body.projectDir === 'string') patch.projectDir = body.projectDir
    if (Number.isInteger(body.targetChapterWords)) patch.targetChapterWords = body.targetChapterWords
    if (typeof body.readFontSize === 'number' && body.readFontSize >= 9 && body.readFontSize <= 28) patch.readFontSize = body.readFontSize
    if (typeof body.uiScale === 'number' && body.uiScale >= 0.8 && body.uiScale <= 1.6) patch.uiScale = body.uiScale
    if (Object.keys(patch).length === 0) throw new Error('没有要保存的配置')
    await cx.saveConfig(patch)
    cx.resetProject()
    return { ok: true, config: patch }
  }

  return {
    state,
    'summary.get': summaryGet,
    'summary.save': summarySave,
    'summary.fillHead': summaryFillHead,
    'summary.headsMissing': summaryHeadsMissing,
    'summary.generate': summaryGenerate,
    'summary.missing': summaryMissing,
    'people.index': peopleIndex,
    'people.suggestAliases': peopleSuggestAliases,
    'people.setAliases': peopleSetAliases,
    'people.cardDraft': peopleCardDraft,
    'people.cardSave': peopleCardSave,
    'people.fieldGuess': peopleFieldGuess,
    'consistency.check': consistencyCheck,
    'plot.analysis': plotAnalysis,
    'distill.pending': distillPending,
    'distill.run': distillRun,
    'distill.apply': distillApply,
    'setup.get': setupGet,
    'setup.save': setupSave,
    'pack.preview': packPreview,
    'newchapter.status': newchapterStatus,
    'newchapter.directions': newchapterDirections,
    'newchapter.draft': newchapterDraft,
    'chapter.get': chapterGet,
    'chapter.save': chapterSave,
    'chapter.delete': chapterDelete,
    'drafts.list': draftsList,
    'draft.read': draftRead,
    'draft.mark': draftMark,
    'draft.pick': draftPick,
    'draft.pickAll': draftPickAll,
    'draft.merge': draftMerge,
    'drafts.delete': draftDelete,
    'trash.list': trashList,
    'trash.read': trashRead,
    'trash.restore': trashRestore,
    'trash.restoreFile': trashRestoreFile,
    'trash.purgeFile': trashPurgeFile,
    'trash.purge': trashPurge,
    'trash.purgeAll': trashPurgeAll,
    'profile.get': profileGet,
    'profile.save': profileSave,
    'profile.append': profileAppend,
    'profile.clear': profileClear,
    'types.list': typesList,
    'types.create': typesCreate,
    'types.bind': typesBind,
    'types.saveAs': typesSaveAs,
    'types.delete': typesDelete,
    'types.trashList': typesTrashList,
    'types.trashRestore': typesTrashRestore,
    'types.trashPurge': typesTrashPurge,
    'types.trashPurgeAll': typesTrashPurgeAll,
    'files.list': filesList,
    'dir.list': dirList,
    'dir.discover': dirDiscover,
    'files.checklist': filesChecklist,
    'file.read': fileRead,
    'file.save': fileSave,
    'file.create': fileCreate,
    'file.delete': fileDelete,
    'files.dirs': filesDirs,
    'file.append': fileAppend,
    'file.classify': fileClassify,
    'files.scan': filesScan,
    'files.bind': filesBind,
    'files.move': filesMove,
    'dir.candidateOf': dirCandidateOf,
    'book.switch': bookSwitch,
    'learn.import': learnImport,
    'learn.scan': learnScan,
    'learn.digest': learnDigest,
    'learn.summarize': learnSummarize,
    'learn.list': learnList,
    'learn.get': learnGet,
    'learn.delete': learnDelete,
    'dir.browse': dirBrowse,
    'path.reveal': pathReveal,
    'rules.get': rulesGet,
    'rules.save': rulesSave,
    'rules.reset': rulesReset,
    'rules.delete': rulesDelete,
    'rules.restore': rulesRestore,
    'rules.purge': rulesPurge,
    'rules.purgeAll': rulesPurgeAll,
    'config.save': configSave,
  }
}
