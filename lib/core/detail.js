/**
 * 细纲取材：把某一章的「细纲」那一段从 细纲/ 里找出来。
 *
 * 为什么单独放一个模块：两处要用 ——
 * 1. 写作包第 ⑧ 节（写候选稿时模型要照着场次写）；
 * 2. 开新章第 1 步的「🔍 让模型去书里找」。
 * 原来这段逻辑长在 api.js 里，只有第二处能用到；抽出来两边共用，改一次都改到。
 *
 * 认法：先按 `## 第N章` / `### 第N章` 切小节；切不到就退回按行找命中行。
 * 作者写细纲的习惯千差万别（卷一个文件、章一个文件、表格式），所以只认"章号"这个硬信号。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const read = (path) => readFile(path, 'utf8').catch(() => '')

/**
 * @param {string} projectDir 作品根
 * @param {number} chapter 章号
 * @returns {Promise<string>} 命中片段（可能多份，用空行分隔）；找不到返回空串
 */
export async function readDetailFor(projectDir, chapter) {
  const files = []
  let listed = []
  try {
    listed = await readdir(join(projectDir, '细纲'), { withFileTypes: true })
  } catch {
    listed = []
  }
  for (const e of listed) {
    if (!e.isFile()) continue
    if (!/\.(md|txt)$/i.test(e.name)) continue
    files.push({ name: e.name, path: join(projectDir, '细纲', e.name) })
  }
  for (const rel of ['细纲.md', '设定/细纲.md']) {
    const p = join(projectDir, rel)
    if (existsSync(p)) files.push({ name: rel, path: p })
  }

  const want = new RegExp('第\\s*' + String(chapter) + '\\s*章')
  const pieces = []
  for (const f of files) {
    const text = await read(f.path)
    if (text.trim() === '') continue

    let head = null
    let lines = []
    let hit = null
    for (const line of text.split(/\r?\n/)) {
      const h = /^#{2,4}\s*(.+)$/u.exec(line.trim())
      if (h !== null) {
        if (head !== null && hit === null && want.test(head)) hit = { head, lines }
        head = h[1]
        lines = []
        continue
      }
      if (head !== null) lines.push(line)
    }
    if (hit === null && head !== null && want.test(head)) hit = { head, lines }

    if (hit !== null) {
      pieces.push('《' + f.name + '》' + hit.head + '\n' + hit.lines.join('\n').trim())
      continue
    }
    const oneLine = text.split(/\r?\n/).find((l) => want.test(l))
    if (oneLine !== undefined) pieces.push('《' + f.name + '》' + oneLine.trim())
  }
  return pieces.join('\n\n')
}
