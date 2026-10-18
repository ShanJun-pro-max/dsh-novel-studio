/**
 * 共享上下文：项目识别、路径约定、配置读写。
 *
 * 设计原则：
 * - 状态目录沿用 `.dsh-novel-craft`，让旧数据（候选稿、标注、偏好档案）无缝可用；
 * - 所有路径都由「作品根」推导，调用方不需要自己拼；
 * - 读不到就当没有，不抛异常——插件不该因为某个文件缺失就整个挂掉。
 */
import { join, basename, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { readdir, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as W from '../core/workspace.js'
import { readJsonSafe, readTextSafe, statSafe, charCount } from '../core/text.js'

/** 作品级状态目录（沿用旧名，历史数据直接可用） */
export const STATE_DIR = '.dsh-novel-craft'
/** 跳过这些目录，别在找文件时钻进去 */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache'])

export const PROFILE_FILE = '作者偏好档案.md'
export const BOOK_CONF = '书配置.json'
export const TRASH_DIR = '回收站'
export const TRASH_DRAFT_SUB = '候选稿'
export const TRASH_TYPES_SUB = '.回收站'

/** 用户级类型库：所有书共用 */
export const typesRoot = () => join(homedir(), '.dsh', 'novel-craft-types')

/** 类型名只做一层目录名，挡掉路径穿越 */
export const safeTypeName = (name) => {
  const s = String(name ?? '').trim()
  if (s === '') return ''
  if (s.includes('/') || s.includes('\\') || s.includes('..')) throw new Error('类型名不能包含路径分隔符')
  if (s.length > 40) throw new Error('类型名太长（最多 40 字）')
  return s
}

/** 文件名只允许纯文件名，挡掉路径穿越 */
export const safeFileName = (name) => {
  const s = String(name ?? '')
  if (s === '') throw new Error('文件名不能为空')
  if (s.includes('/') || s.includes('\\') || s.includes('..')) throw new Error('文件名不合法')
  return s
}

/** 时间戳：用于回收站文件名前缀 */
export const stampNow = () => new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)

/**
 * 建一个绑定到当前配置的上下文。
 * @param {{ cfg: () => object, saveConfig: (patch: object) => Promise<void> }} deps
 */
export function createContext(deps) {
  const { cfg, saveConfig } = deps
  let projectCache = { key: '', at: 0, value: null }

  /** 用户在设置里填的候选目录（抽卡落点） */
  const dirOf = () => String(cfg().candidateDir ?? '').trim()

  /** 状态目录 */
  const stateDirOf = (projectDir) => join(projectDir, STATE_DIR)

  /**
   * 作品根：
   * 1. 设置里显式给了 projectDir → 用它；
   * 2. 否则从候选目录向上探测（W.detectProject 打分取最高）。
   * 结果缓存 30 秒，避免每次请求都扫盘。
   */
  const projectOf = async (force) => {
    const configured = String(cfg().projectDir ?? '').trim()
    if (configured !== '' && existsSync(configured)) {
      return { projectDir: configured, name: basename(configured), runsRoot: '', source: 'setting' }
    }
    const start = dirOf()
    if (start === '') return null
    const now = Date.now()
    if (!force && projectCache.key === start && now - projectCache.at < 30000 && projectCache.value !== null) {
      return projectCache.value
    }
    const detected = await W.detectProject(start)
    const value =
      detected.projectDir === ''
        ? null
        : {
            projectDir: detected.projectDir,
            name: detected.name,
            runsRoot: detected.runsRoot,
            source: 'auto',
          }
    projectCache = { key: start, at: now, value }
    return value
  }

  /** 强制重新探测（换目录后调用） */
  const resetProject = () => {
    projectCache = { key: '', at: 0, value: null }
  }

  const requireProject = async () => {
    const p = await projectOf(false)
    if (p === null) throw new Error('还没认出作品目录：先选候选目录，或在设置里填作品根')
    return p
  }

  // ── 偏好档案（全书级 / 类型库） ─────────────────────────────
  const profileRootPath = (projectDir) => join(stateDirOf(projectDir), PROFILE_FILE)
  const typeProfilePath = (typeName) => join(typesRoot(), typeName, PROFILE_FILE)

  const readBookConf = async (projectDir) => {
    const data = await readJsonSafe(join(stateDirOf(projectDir), BOOK_CONF))
    return data !== null && typeof data === 'object' ? data : {}
  }

  const writeBookConf = async (projectDir, next) => {
    const p = join(stateDirOf(projectDir), BOOK_CONF)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify(next, null, 2) + '\n', 'utf8')
    return p
  }

  /** 当前档案该在哪：绑了类型走类型库，否则作品根 */
  const profilePath = async (projectDir) => {
    const conf = await readBookConf(projectDir)
    const typeName = typeof conf.类型 === 'string' ? conf.类型.trim() : ''
    return typeName === '' ? profileRootPath(projectDir) : typeProfilePath(typeName)
  }

  const readProfile = async (path) => {
    if (path === '') return { text: '', path: '', updatedAt: '', chars: 0 }
    try {
      const [text, info] = await Promise.all([readTextSafe(path), statSafe(path)])
      return { text, path, updatedAt: info.mtime, chars: charCount(text) }
    } catch {
      return { text: '', path, updatedAt: '', chars: 0 }
    }
  }

  // ── 回收站路径 ─────────────────────────────────────────────
  const trashDir = (projectDir) => join(stateDirOf(projectDir), TRASH_DIR)
  const trashDraftDir = (projectDir) => join(trashDir(projectDir), TRASH_DRAFT_SUB)
  const typesTrashDir = () => join(typesRoot(), TRASH_TYPES_SUB)

  // ── 通用小工具 ─────────────────────────────────────────────
  const ensureDir = (dir) => mkdir(dir, { recursive: true })

  /** 列目录里的普通文件（不递归），读不到返回空数组 */
  const listFiles = async (dir, exts) => {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const e of entries) {
      if (!e.isFile()) continue
      const low = e.name.toLowerCase()
      if (exts !== undefined && !exts.some((x) => low.endsWith(x))) continue
      const info = await statSafe(join(dir, e.name))
      if (!info.exists) continue
      out.push({ name: e.name, path: join(dir, e.name), bytes: info.bytes, mtime: info.mtime })
    }
    return out
  }

  /** 列目录里的子目录名，读不到返回空数组 */
  const listDirs = async (dir) => {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  }

  return {
    cfg,
    saveConfig,
    dirOf,
    projectOf,
    requireProject,
    resetProject,
    stateDirOf,
    // 偏好档案
    profilePath,
    profileRootPath,
    typeProfilePath,
    readBookConf,
    writeBookConf,
    readProfile,
    // 回收站
    trashDir,
    trashDraftDir,
    typesTrashDir,
    // 工具
    ensureDir,
    listFiles,
    listDirs,
  }
}

// 把常用工具再导出一次，省得 api.js 到处 import
export { readJsonSafe, readTextSafe, statSafe, charCount, readdir, mkdir, writeFile, rename, rm }
