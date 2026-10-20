import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const SUBS = ['正文', '剧情', '人物', '设定']

function outlineOf(name) {
  return [
    '# ' + name + ' · 大纲',
    '',
    '> 每一章写一段：这一章要发生什么、谁在场、结尾停在哪。',
    '> 插件按「第N章」识别，格式照下面抄。',
    '',
    '## 第1章',
    '',
    '- 目标：',
    '',
    '- 出场：',
    '',
    '- 结尾：',
    '',
  ].join('\n')
}

function readmeOf(name) {
  return [
    '# ' + name,
    '',
    '这是小说工坊的作品目录，骨架已经搭好：',
    '',
    '```',
    '├─ 大纲.md      每一章一段：目标 / 出场 / 结尾',
    '├─ 正文/         章节正文，文件名形如 第001章-标题.txt',
    '├─ 剧情/         每章剧情总结（插件里点「总结」自动生成）',
    '├─ 人物/         人物卡，一人一个 .json（插件里建卡）',
    '└─ 设定/         世界观、立项、人物设定、写作口径',
    '```',
    '',
    '顺序建议：先在「设定」里把世界观和人物定下来，再去大纲写第一章，然后就能开新章。',
    '',
    '## 加人物的规矩',
    '',
    '- **先建卡，再开章。** 新角色先在 `人物/` 下有一张卡（哪怕只填姓名、身份、种族），再在「这一章要写什么」里用到他——写作包只从人物卡里挑人，没卡的人它拿不到资料，只能自己编。',
    '- **只出现一次的路人，不建卡。** 按「称谓 + 身份」写（前台小妹、隔壁工位的老周），用过即弃。',
    '- **写完一章，看一次「📈 情节」。** 报「无卡角色」就是有名字没卡：点那个 `✚ 建卡` 补上，别让他连着出现在两章里。',
    '',
  ].join('\n')
}

/**
 * 把一个已有目录补成作品骨架：缺哪个补哪个，已有的绝不动。
 *
 * 作者的做法是「系统对话框里新建一个文件夹 → 选它」。那个文件夹是空的，
 * 插件不能因此不认它；这里把缺的目录和文件补齐，等于替他做完那堆手工活。
 *
 * @returns {Promise<string[]>} 补了哪些东西（空数组表示本来就是完整作品）
 */
async function fillSkeleton(target, name) {
  const created = []
  for (const sub of SUBS) {
    const p = join(target, sub)
    if (!existsSync(p)) {
      await mkdir(p, { recursive: true })
      created.push(sub + '/')
    }
  }
  const outline = join(target, '大纲.md')
  if (!existsSync(outline)) {
    await writeFile(outline, outlineOf(name), 'utf8')
    created.push('大纲.md')
  }
  const readme = join(target, '说明.md')
  if (!existsSync(readme)) {
    await writeFile(readme, readmeOf(name), 'utf8')
    created.push('说明.md')
  }
  return created
}

const checkName = (name) => {
  const clean = String(name == null ? '' : name).trim()
  if (clean === '') throw new Error('给作品起个名字')
  if (/[\\/:*?"<>|]/u.test(clean)) throw new Error('名字里不能有 \\ / : * ? " < > | 这些字符')
  if (clean === '.' || clean === '..') throw new Error('这个名字不能用')
  if (clean.length > 60) throw new Error('名字太长了（60 字以内）')
  return clean
}

/**
 * 新建作品：在指定目录下建一个新文件夹并搭好骨架。
 */
export async function createWorkFolder({ parent, name, probeDir, defaultBrowseRoot }) {
  const clean = checkName(name)
  const parentRaw = String(parent == null ? '' : parent).trim()
  const base = parentRaw === '' ? await defaultBrowseRoot() : parentRaw

  if ((await probeDir(base)) === null) throw new Error('父目录不存在或读不到：' + base)

  const target = join(base, clean)
  if (existsSync(target)) throw new Error('这个名字已经存在：' + target)

  await mkdir(target, { recursive: true })
  await fillSkeleton(target, clean)
  return { ok: true, path: target, name: clean, parent: base, created: [] }
}

/**
 * 把选中的已有目录直接当作品用：缺的骨架补齐，已有的不动。
 *
 * 这是主路径——作者在系统对话框里新建文件夹，然后选它。
 */
export async function initWorkFolder({ path }) {
  const target = String(path == null ? '' : path).trim()
  if (target === '') throw new Error('要指定目录')
  if (!existsSync(target)) throw new Error('这个目录不存在：' + target)

  const name = target.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() || '新作品'
  const created = await fillSkeleton(target, name)
  return { ok: true, path: target, name, created }
}
