/**
 * 一致性体检：防止「改名只改了一半」这种事再发生。
 *
 * 为什么需要：v3.0.0 改名时漏了 lib/client.js 里 __ModuleLoader__ 的 id，
 * 结果宿主加载插件时认为「这个 entry 没激活 → import failed」，整个 web 起不来。
 * 这类错误 node --check 看不出来，只能在发布前逐项比对。
 *
 * 用法：node check.mjs  （push.ps1 里会自动跑）
 */
import { existsSync, readFileSync } from 'node:fs'

const fail = []
const ok = []
const read = (p) => readFileSync(p, 'utf8')

const pkg = JSON.parse(read('package.json'))
const name = pkg.name

// 1) 包名与各处注册的 id 必须一致
const idx = read('lib/index.js')
const mIndex = /export const name = '([^']+)'/.exec(idx)
if (mIndex === null) fail.push('lib/index.js 里找不到 `export const name = ...`')
else if (mIndex[1] !== name) fail.push(`lib/index.js 的 name（${mIndex[1]}）≠ package.json（${name}）`)
else ok.push(`index.js name = ${name}`)

const client = read('lib/client.js')
const mClient = /__ModuleLoader__\.load\(\{\s*\n\s*id: '([^']+)'/.exec(client)
if (mClient === null) fail.push('lib/client.js 里找不到 __ModuleLoader__.load({ id: ... })')
else if (mClient[1] !== name) fail.push(`lib/client.js 的 __ModuleLoader__ id（${mClient[1]}）≠ package.json（${name}）—— 这会导致 web 启动时「1 entry did not activate / import failed」`)
else ok.push(`client.js loader id = ${name}`)

const patch = read('cordis.patch.yml')
const mId = /^\s*- id: (\S+)/m.exec(patch)
const mName = /^\s*name: '?([^'\n]+)'?$/m.exec(patch)
if (mId === null) fail.push('cordis.patch.yml 里找不到 `- id:`')
else if (mId[1] !== name) fail.push(`cordis.patch.yml 的 id（${mId[1]}）≠ package.json（${name}）`)
else ok.push(`cordis.patch.yml id = ${name}`)
if (mName === null) fail.push('cordis.patch.yml 里找不到 `name:`')
else if (mName[1].trim() !== name) fail.push(`cordis.patch.yml 的 name（${mName[1].trim()}）≠ package.json（${name}）`)

// 2) 发布必须带的文件
const bundlePatch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
if (typeof bundlePatch !== 'string') fail.push('package.json 缺 dsh.bundle.patch')
else if (!existsSync(bundlePatch)) fail.push(`dsh.bundle.patch 指向的 ${bundlePatch} 不存在`)
else ok.push(`dsh.bundle.patch = ${bundlePatch}`)

for (const f of ['lib/index.js', 'lib/client.js', 'install.mjs', 'README.md', 'LICENSE']) {
  if (!existsSync(f)) fail.push(`缺文件：${f}`)
}

const files = Array.isArray(pkg.files) ? pkg.files : []
for (const need of ['lib/', 'cordis.patch.yml']) {
  if (!files.includes(need)) fail.push(`package.json 的 files 里少了 ${need}（npm 包里会缺东西）`)
}
ok.push('npm 打包清单齐全')

// 3) 版本号与 CHANGELOG 是否对得上（只提醒，不拦）
const changelog = read('CHANGELOG.md')
const hasEntry = changelog.includes(`## [${pkg.version}]`)
if (!hasEntry) fail.push(`CHANGELOG.md 里没有 ${pkg.version} 这一条`)

// 4) install.mjs 写的 bundle 名也要一致
const install = read('install.mjs')
const mInstall = /const NAME = '([^']+)'/.exec(install)
if (mInstall === null) fail.push('install.mjs 里找不到 `const NAME = ...`')
else if (mInstall[1] !== name) fail.push(`install.mjs 的 NAME（${mInstall[1]}）≠ package.json（${name}）`)
else ok.push(`install.mjs NAME = ${name}`)

for (const line of ok) console.log('  ✓ ' + line)
if (fail.length === 0) {
  console.log(`\n一致性体检通过（${name}@${pkg.version}，${ok.length} 项）`)
  process.exit(0)
}
console.log('')
for (const line of fail) console.log('  ✗ ' + line)
console.log(`\n一致性体检失败：${fail.length} 个问题`)
process.exit(1)
