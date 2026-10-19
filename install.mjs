/**
 * dsh-novel-workbench 安装助手：把本插件挂进 dsh 的 profile 组合。
 *
 * 为什么需要它：`dsh plugin add` 只是把包装进 profile 的 node_modules，
 * 组合层要另一步——把包名写进 profile package.json 的 `dsh.profile.bundles`，
 * 下次启动 dsh 才会应用本插件自带的 cordis.patch.yml（往 UI 里插侧栏入口）。
 *
 * 用法：
 *   node install.mjs            # 默认 web profile
 *   node install.mjs desktop    # 桌面版
 *   DSH_HOME=... node install.mjs web   # 自定义 DSH 主目录
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NAME = 'dsh-novel-workbench'
const profile = String(process.argv[2] || 'web').replace(/^--profile=/, '')
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const file = join(home, 'profiles', profile, 'package.json')

const die = (msg) => {
  process.stderr.write('✗ ' + msg + '\n')
  process.exit(1)
}

if (!existsSync(file)) {
  die('找不到 profile：' + file + '\n  先启动一次 dsh（例如 `dsh web`），让它把 profile 建出来；名称不对就换一个，例如 `node install.mjs desktop`。')
}

const raw = await readFile(file, 'utf8')
let pkg = null
try {
  pkg = JSON.parse(raw)
} catch (e) {
  die('这个 package.json 不是合法 JSON：' + String(e.message || e))
}

const deps = pkg.dependencies !== null && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
if (deps[NAME] === undefined) {
  die(
    '这个 profile 里还没装 ' +
      NAME +
      '。先跑：\n  dsh plugin --profile ' +
      profile +
      ' add github:ShanJun-pro-max/dsh-novel-studio\n再执行本脚本。',
  )
}

pkg.dsh = pkg.dsh !== null && typeof pkg.dsh === 'object' ? pkg.dsh : {}
pkg.dsh.profile = pkg.dsh.profile !== null && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {}
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []

if (bundles.includes(NAME)) {
  process.stdout.write('· ' + NAME + ' 已经在 ' + profile + ' 的 bundles 里了，不用改。\n')
} else {
  bundles.push(NAME)
  pkg.dsh.profile.bundles = bundles
  await writeFile(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  process.stdout.write('✓ 已把 ' + NAME + ' 加进 ' + profile + ' 的 dsh.profile.bundles\n')
}

process.stdout.write('\n下一步：重启 dsh（' + (profile === 'web' ? 'dsh web' : 'dsh --profile ' + profile) + '），再 Ctrl + F5 硬刷新页面。\n')
process.stdout.write('成功标志：侧栏底部出现「📚 小说工坊」，点开看左侧导航最底部的版本号。\n')
