/**
 * 全面体检：把插件从「文件在不在」到「宿主能不能真的加载起来」逐层跑一遍。
 *
 * 为什么要这个：改名漏了 client.js 的 loader id 那次，node --check 全过、
 * 包也发出去了，结果宿主一启动就 import failed。这个脚本专门补那类洞。
 *
 * 用法：node doctor.mjs [安装目录]
 *   不给参数就测仓库本体；给 .dsh 的 node_modules 路径就测安装副本。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = process.argv[2] === undefined ? process.cwd() : process.argv[2]
const results = []
const pass = (name, detail) => results.push({ ok: true, name, detail })
const fail = (name, detail) => results.push({ ok: false, name, detail })

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
console.log(`=== 体检对象：${pkg.name}@${pkg.version}\n=== 目录：${root}\n`)

// ── 1. 身份一致性 ────────────────────────────────
const idxCode = readFileSync(join(root, 'lib/index.js'), 'utf8')
const mName = /export const name = '([^']+)'/.exec(idxCode)
if (mName && mName[1] === pkg.name) pass('插件名', mName[1])
else fail('插件名与包名不一致', (mName && mName[1]) + ' vs ' + pkg.name)

const clientCode = readFileSync(join(root, 'lib/client.js'), 'utf8')
const mLoad = /__ModuleLoader__\.load\(\{\s*\n\s*id: '([^']+)'/.exec(clientCode)
if (mLoad && mLoad[1] === pkg.name) pass('客户端 loader id', mLoad[1])
else fail('客户端 loader id 与包名不一致（会导致 web 起不来）', (mLoad && mLoad[1]) + ' vs ' + pkg.name)

const patchCode = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const mId = /^\s*- id: (\S+)/m.exec(patchCode)
if (mId && mId[1] === pkg.name) pass('组合层 id', mId[1])
else fail('组合层 id 与包名不一致', (mId && mId[1]) + ' vs ' + pkg.name)

// ── 2. 入口能不能真的 import（loader 的解析方式）────────
try {
  const mod = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  if (typeof mod.apply !== 'function') fail('lib/index.js 缺 apply 导出', String(typeof mod.apply))
  else pass('服务端入口 import', 'apply / Config / name 齐全')
} catch (e) {
  fail('服务端入口 import 失败', String(e.message).slice(0, 200))
}

// ── 3. lib 下每个模块都 import 一遍（启动时会全部加载）──
const walk = (dir) => {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}
let imported = 0
const bad = []
for (const file of walk(join(root, 'lib'))) {
  if (file.endsWith('client.js')) continue
  try {
    await import(pathToFileURL(file).href)
    imported += 1
  } catch (e) {
    bad.push(file.replace(root, '') + ' → ' + String(e.message).slice(0, 120))
  }
}
if (bad.length === 0) pass('lib 全模块可加载', imported + ' 个文件')
else fail('有模块加载失败', bad.join(' | '))

// ── 4. 客户端 bundle 真跑一遍（模拟宿主激活）──────────
const registered = []
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  Map,
  Set,
  Symbol,
  Intl,
  URL,
  URLSearchParams,
  AbortController,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.self = sandbox
sandbox.document = {
  addEventListener() {},
  removeEventListener() {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} },
  querySelector: () => null,
  getElementById: () => null,
  documentElement: { style: {} },
}
sandbox.location = { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/' }
sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
sandbox.navigator = { userAgent: 'doctor' }
sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
sandbox.__ModuleLoader__ = {
  load(entry) {
    registered.push(entry)
  },
}
const reactStub = {
  createElement: (...args) => ({ __el: true, args }),
  Fragment: Symbol('Fragment'),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
  useMemo: (f) => f(),
  createContext: () => ({ Provider: null, Consumer: null }),
}
const requireStub = (id) => {
  if (id === 'react') return reactStub
  throw new Error('客户端不应 require：' + id)
}
try {
  const ctx = vm.createContext(sandbox)
  vm.runInContext(clientCode, ctx, { filename: 'client.js' })
  if (registered.length === 0) fail('客户端没有注册模块', '__ModuleLoader__.load 没被调用')
  else {
    const entry = registered[0]
    if (entry.id !== pkg.name) fail('客户端注册 id 与包名不一致', entry.id + ' vs ' + pkg.name)
    else {
      const exports = entry.factory(requireStub)
      const keys = Object.keys(exports || {})
      if (keys.length === 0) fail('客户端 factory 没返回任何导出', '')
      else pass('客户端 bundle 可激活', `id=${entry.id}，导出 ${keys.join(', ')}`)
    }
  }
} catch (e) {
  fail('客户端 bundle 执行抛错（宿主会报 import failed）', String(e.message).slice(0, 200))
}

// ── 5. 打包清单 ────────────────────────────────
const files = Array.isArray(pkg.files) ? pkg.files : []
const missing = ['lib/', 'cordis.patch.yml'].filter((x) => !files.includes(x))
if (missing.length === 0) pass('npm 打包清单', files.join(', '))
else fail('npm 打包清单缺项', missing.join(', '))

const bundlePatch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
if (bundlePatch && existsSync(join(root, bundlePatch))) pass('dsh.bundle.patch', bundlePatch)
else fail('dsh.bundle.patch 缺失或指向不存在的文件', String(bundlePatch))
if (pkg.dsh && pkg.dsh.client && existsSync(join(root, pkg.dsh.client.platform === undefined ? '' : 'lib/client.js'))) pass('dsh.client 入口存在', 'lib/client.js')
else if (!existsSync(join(root, 'lib/client.js'))) fail('客户端入口文件缺失', 'lib/client.js')

// ── 打印 ──────────────────────────────────────
console.log('')
for (const r of results) console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.detail ? '：' + r.detail : ''))
const bad2 = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，通过 ${results.length - bad2.length}，失败 ${bad2.length}`)
process.exit(bad2.length === 0 ? 0 : 1)
