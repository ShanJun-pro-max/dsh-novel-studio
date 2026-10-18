/**
 * 业务 API：所有操作都挂在一个对象上，由入口按 `body.a` 分发。
 *
 * 为什么用单端点：原来的插件给每个动作注册一个 HTTP 路由，几十个路由散在各处，
 * 加一个功能就要多改一处。这里统一成 `POST /api` + `{ a: '模块.动作' }`，
 * 后端只注册一个路由，新增功能只加一个方法。
 */
import { join, dirname, extname, basename, isAbsolute, relative } from 'node:path'
import { readFile, writeFile, mkdir, rename, rm, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as W from '../core/workspace.js'
import * as DRAFT from '../core/draft.js'
import * as PACK from '../core/pack.js'
import * as PIPE from '../core/pipeline.js'
import * as PLOT from '../core/plot.js'
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

/** 从标注推导「被选中的段落」，按稿件顺序 */
const picksOf = async (dir, candidates) => {
  const marks = await readMarks(dir)
  const picks = []
  for (const c of candidates) {
    const entry = marks[c.name]
    if (entry === null || entry === undefined || typeof entry !== 'object') continue
    const idxs = Object.keys(entry)
      .filter((k) => entry[k] === 'good')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b)
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
    const info = await statSafe(join(dir, e.name))
    out.push({
      name: e.name,
      path: join(dir, e.name),
      text,
      segments,
      segMarks,
      chars: charCount(text),
      bytes: info.bytes,
      mtime: info.mtime,
      goodCount: segMarks.filter((m) => m === 'good').length,
      badCount: segMarks.filter((m) => m === 'bad').length,
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
  const state = async () => {
    const project = await cx.projectOf(false)
    const dir = cx.dirOf()
    const cfg = cx.cfg()
    if (project === null) {
      return {
        ok: true,
        project: null,
        candidateDir: dir,
        config: { candidateDir: cfg.candidateDir, projectDir: cfg.projectDir, targetChapterWords: cfg.targetChapterWords },
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
      config: { candidateDir: cfg.candidateDir, projectDir: cfg.projectDir, targetChapterWords: cfg.targetChapterWords },
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
  /** 候选稿根：.dsh-novel-craft/候选稿/第N章/ */
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

  /** 合稿定稿：把这一章所有候选稿里标好的段拼起来，写进正文 */
  const draftMerge = async (body) => {
    const project = await ensureProject()
    const chapter = Number(body.chapter)
    if (!Number.isInteger(chapter) || chapter <= 0) throw new Error('章号不合法')
    const dir = draftChapterDir(project.projectDir, chapter)
    const items = await readCandidateDir(dir)
    if (items.length === 0) throw new Error(`第${chapter}章还没有候选稿`)
    const picks = await picksOf(dir, items)
    if (picks.length === 0) throw new Error('还没有标"好"的段落：先在候选稿里点 👍')
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
    const target = detail.found ? detail.path : join(project.projectDir, '正文', `${String(chapter).padStart(3, '0')}章-未命名.txt`)
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
    return { ok: true, trash: cx.trashDir(project.projectDir), texts, drafts }
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

    // 候选稿：回 .dsh-novel-craft/候选稿/第N章/，同名加序号
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
    const path = await cx.profilePath(project.projectDir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body.text, 'utf8')
    return { ok: true, path, chars: charCount(body.text) }
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

    const pack = await PACK.buildPack({
      projectDir: project.projectDir,
      chapter,
      people,
      outlineNodes,
      summaries,
      previousChapterText,
      previousChapter: chapter - 1,
      setupText: setup,
      targetChapterWords: cx.cfg().targetChapterWords,
    })
    return { pack, setup }
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
    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: DRAFT.draftSystemPrompt(),
      user: prompt.text,
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

    return { ok: true, issues, peopleCount: cardNames.length, chapterCount: rows.length }
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
  const CHECK_SPEC = [
    { key: '大纲', def: '大纲.md', note: '全书章节骨架，情节体检与开新章都读它' },
    { key: '立项', def: '设定/立项.md', note: '这本书要写什么、给谁看' },
    { key: '世界观', def: '设定/世界观.md', note: '兽人形态、势力、地点、规则' },
    { key: '人物设定', def: '设定/人物设定.md', note: '人物总表与关系' },
    { key: '写作口径', def: '设定/_口径.md', note: '名字表、学校、时间线、写作技法' },
    { key: '道具与台账', def: '设定/道具与增益台账.md', note: '道具、钱、账目' },
    { key: '角色卡', def: '人物/', note: '一人一张卡片，开新章时只读本章要用到的人', multi: true },
    { key: '剧情总结', def: '剧情/', note: '每写完一章就写一份，写下一章时自动带进前情', multi: true },
  ]

  /** 列作品里所有设定类文件（扁平列表，给旧调用方留着） */
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

    // 有 .dsh-novel-craft 说明里面还有东西
    const hasPluginData = entries.some((e) => e.name === '.dsh-novel-craft')

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

  /** 默认从哪儿开始找：当前作品所在盘的 Documents */
  const defaultBrowseRoot = async () => {
    try {
      const project = await ensureProject()
      return project.projectDir
    } catch {
      /* 没配就从用户目录找 */
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
    const start = raw === '' ? await defaultBrowseRoot() : raw
    const maxDepth = Number.isInteger(body.depth) ? body.depth : 3
    const found = []
    const seen = new Set()

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

    await walk(start, 0)
    found.sort((a, b) => {
      const rank = (x) => (x.kind === 'project' ? 0 : 1)
      const d = rank(a) - rank(b)
      return d !== 0 ? d : a.path.localeCompare(b.path)
    })
    return { ok: true, from: start, found, truncated: found.length >= 60 }
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

    for (const spec of CHECK_SPEC) {
      if (spec.multi === true) {
        const dirPath = join(project.projectDir, spec.def)
        const exts = spec.key === '角色卡' ? ['.json'] : ['.md']
        const list = await cx.listFiles(dirPath, exts)
        for (const f of list) covered.add(f.path.replace(/\\/gu, '/').toLowerCase())
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
          files: list.map((f) => ({ name: f.name, path: f.path })),
        })
        continue
      }

      // 单文件类：先看归属表，再看默认路径
      const bound = Array.isArray(map[spec.key]) ? map[spec.key] : []
      const candidates = [...bound, spec.def]
      let found = null
      for (const rel of candidates) {
        const full = join(project.projectDir, String(rel))
        const info = await statSafe(full)
        if (info.exists) {
          found = { rel: String(rel).replace(/\\/gu, '/'), full, bytes: info.bytes }
          break
        }
      }
      if (found !== null) covered.add(found.full.replace(/\\/gu, '/').toLowerCase())
      items.push({
        key: spec.key,
        note: spec.note,
        path: found === null ? spec.def : found.rel,
        multi: false,
        exists: found !== null,
        files: found === null ? [] : [{ name: basename(found.full), path: found.full }],
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
        others.push({ name: f.name, path: f.path, scope: d.scope, bytes: f.bytes })
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

  /** 允许新建的目录 */
  const NEW_FILE_DIRS = ['', '设定', '人物', '剧情']

  const normalizeNewPath = (raw) => {
    const p = String(raw == null ? '' : raw).replace(/\\/gu, '/').trim()
    if (p === '') throw new Error('要填文件名')
    if (p.startsWith('/') || p.includes('..')) throw new Error('文件名不合法')
    const low = extname(p).toLowerCase()
    if (!['.md', '.txt', '.json'].includes(low)) throw new Error('只能建 .md / .txt / .json 文件')
    const dir = dirname(p) === '.' ? '' : dirname(p)
    if (!NEW_FILE_DIRS.includes(dir)) throw new Error('只能建在 根目录 / 设定 / 人物 / 剧情 下')
    return p
  }

  const fileCreate = async (body) => {
    const project = await ensureProject()
    const rel = normalizeNewPath(body.path)
    const full = join(project.projectDir, rel)
    const info = await statSafe(full)
    if (info.exists) throw new Error('已经存在同名文件：' + rel)
    const text = typeof body.text === 'string' ? body.text : ''
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, text, 'utf8')
    return { ok: true, path: full, rel, chars: charCount(text) }
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
  const CLASSIFY_FILES_SYSTEM = [
    '你是小说项目的资料管理员。作者把这本书的资料放在一个文件夹里，命名各式各样。',
    '你的活是：判断每个文件属于下面哪一类资料。',
    '',
    '类别（key 必须严格用这八个之一）：',
    '大纲 / 立项 / 世界观 / 人物设定 / 写作口径 / 道具与台账 / 角色卡 / 剧情总结',
    '',
    '含义：',
    '大纲 —— 章节骨架，按「第N章」写目标/冲突/转折',
    '立项 —— 这本书要写什么、给谁看、卖点',
    '世界观 —— 兽人形态、势力、地点、种族规则',
    '人物设定 —— 人物总表与关系（通常是 md 汇总）',
    '写作口径 —— 名字表、学校、时间线、写作技法、禁忌',
    '道具与台账 —— 道具、钱、账目',
    '角色卡 —— 一个人一张的卡片（通常是 json）',
    '剧情总结 —— 每章写完之后的那份总结',
    '',
    '只输出一个 JSON 数组，不要别的内容，不要代码围栏：',
    '[{"index":1,"key":"世界观"},{"index":2,"key":""}]',
    '',
    '规则：',
    '1. 判断不了就留空字符串，不要硬塞。',
    '2. 只按文件名和所在目录判断。',
    '3. 每个 index 都要出现一次。',
  ].join('\n')

  const filesScan = async () => {
    const project = await ensureProject()
    const map = await readFileMap(project.projectDir)
    const known = new Set()
    for (const list of Object.values(map)) {
      for (const rel of Array.isArray(list) ? list : []) known.add(String(rel).replace(/\\/gu, '/').toLowerCase())
    }
    for (const spec of CHECK_SPEC) {
      if (spec.multi !== true) known.add(spec.def.replace(/\\/gu, '/').toLowerCase())
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
        if (known.has(rel.toLowerCase())) continue
        candidates.push({ rel, scope: d.scope, name: f.name, bytes: f.bytes })
      }
    }
    if (candidates.length === 0) return { ok: true, assignments: [], scanned: 0 }

    const lines = candidates.map((c, i) => String(i + 1) + '. [' + c.scope + '] ' + c.name)
    const { llm, route } = modelRoute()
    const answer = await callModel(llm, route, {
      system: CLASSIFY_FILES_SYSTEM,
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
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const idx = Number(item == null ? NaN : item.index)
      const key = String(item == null ? '' : item.key == null ? '' : item.key).trim()
      if (!Number.isInteger(idx) || idx < 1 || idx > candidates.length) continue
      if (!validKeys.has(key)) continue
      const c = candidates[idx - 1]
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

  // ══════════════════════════════════════════════════════════
  // 配置
  // ══════════════════════════════════════════════════════════
  const configSave = async (body) => {
    const patch = {}
    if (typeof body.candidateDir === 'string') patch.candidateDir = body.candidateDir
    if (typeof body.projectDir === 'string') patch.projectDir = body.projectDir
    if (Number.isInteger(body.targetChapterWords)) patch.targetChapterWords = body.targetChapterWords
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
    'consistency.check': consistencyCheck,
    'plot.analysis': plotAnalysis,
    'distill.pending': distillPending,
    'distill.run': distillRun,
    'distill.apply': distillApply,
    'setup.get': setupGet,
    'setup.save': setupSave,
    'newchapter.status': newchapterStatus,
    'newchapter.directions': newchapterDirections,
    'newchapter.draft': newchapterDraft,
    'chapter.get': chapterGet,
    'chapter.save': chapterSave,
    'chapter.delete': chapterDelete,
    'drafts.list': draftsList,
    'draft.read': draftRead,
    'draft.mark': draftMark,
    'draft.merge': draftMerge,
    'drafts.delete': draftDelete,
    'trash.list': trashList,
    'trash.read': trashRead,
    'trash.restore': trashRestore,
    'trash.purge': trashPurge,
    'trash.purgeAll': trashPurgeAll,
    'profile.get': profileGet,
    'profile.save': profileSave,
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
    'file.append': fileAppend,
    'file.classify': fileClassify,
    'files.scan': filesScan,
    'files.bind': filesBind,
    'config.save': configSave,
  }
}
