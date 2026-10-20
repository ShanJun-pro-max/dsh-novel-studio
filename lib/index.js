/**
 * 小说工坊 · dsh-novel-workbench
 *
 * 一页式小说创作工作台。后端只注册一个 RPC 端点，前端按 `a` 字段分发到
 * lib/server/api.js 里的方法——新增功能只加一个方法，不用再动路由。
 */
import z from '@deepseek-ai/schemastery'
import { createContext } from './server/context.js'
import { createApi } from './server/api.js'

export const name = 'dsh-novel-workbench'

/** RPC 端点前缀 */
const API_PREFIX = '/novel-studio/api/'

/** 可编辑配置 */
const configSchema = z.object({
  /** 抽卡落点：候选稿所在目录 */
  candidateDir: z.string().default(''),
  /** 作品根。留空则从候选目录向上自动探测 */
  projectDir: z.string().default(''),
  /** 单章目标字数，用于字数提示 */
  targetChapterWords: z.number().default(2500),
  /** 总开关 */
  enabled: z.boolean().default(true),
  /** 「开新章」用的模型：留空则用 dsh 当前默认模型 */
  distillProvider: z.string().default(''),
  distillModel: z.string().default(''),
  /** 阅读字号：候选稿段落与正文编辑区的字体大小（px） */
  readFontSize: z.number().default(13.5),
  /** 界面缩放：0.9 / 1 / 1.15 / 1.3，整体放大导航与小字 */
  uiScale: z.number().default(1),
})

export const Config = configSchema

/** 等宿主服务就绪：拿不到就返回 null，不让整个插件卡死 */
async function awaitServices(ctx, names, timeoutMs) {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      ctx.inject(names, (ready) => finish(ready))
    } catch {
      finish(null)
    }
    setTimeout(() => finish(null), timeoutMs).unref?.()
  })
}

export async function apply(ctx, config = {}) {
  const ready = await awaitServices(ctx, ['settings', 'webServer'], 15000)
  if (ready === null || ready.webServer === undefined) return

  // 0.2.0 起 settings.register 被移除，配置改由插件 Config + 自动设置页承担。
  // 两个版本都兼容：有 register 就注册，没有就直接用注入的 config。
  const legacy = ready.settings !== undefined && typeof ready.settings.register === 'function'
  const scope = legacy ? await ready.settings.register(name, configSchema) : null
  const cfg = () => (legacy && scope !== null ? scope.get() : config)

  /** 写回配置 */
  const saveConfig = async (patch) => {
    if (legacy && scope !== null && typeof scope.update === 'function') return scope.update(patch)
    const editor = ctx.get('configEditor')
    if (editor === undefined || editor === null || typeof editor.edit !== 'function') {
      throw new Error('这个 dsh 不支持写入插件配置：请在设置页里手填候选目录')
    }
    const entry = (typeof editor.entries === 'function' ? editor.entries() : []).find((e) => {
      const id = String(e.id ?? '')
      const nm = typeof e.name === 'string' && e.name !== '' ? e.name : String(e.options?.name ?? '')
      return id === name || nm === name || id.endsWith(':' + name) || id.endsWith('/' + name)
    })
    if (entry === undefined) throw new Error('找不到 dsh-novel-workbench 的配置项：请在设置页里手填候选目录')
    await editor.edit(entry, (current) => ({ ...current, ...patch }))
  }

  const cx = createContext({ cfg, saveConfig })
  const api = createApi(cx, ctx)

  // ── 注册唯一一个 RPC 端点 ──────────────────────────────
  const webServer = ready.webServer
  if (typeof webServer.register !== 'function') return

  const off = webServer.register({
    kind: 'exact',
    path: API_PREFIX,
    handler: (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      // 只接受本机回环请求
      const remote = String(req.socket?.remoteAddress ?? '')
      if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '')) {
        send(403, { error: 'novel-studio api is loopback-only' })
        return
      }
      if (cfg().enabled === false) {
        send(503, { error: '小说工坊已停用' })
        return
      }
      Promise.resolve()
        .then(async () => {
          const body = await readJsonBody(req)
          if (body.__error !== undefined) {
            send(413, { error: body.__error })
            return
          }
          const action = String(body.a ?? '')
          const fn = api[action]
          if (typeof fn !== 'function') throw new Error('未知操作：' + action)
          const result = await fn(body)
          if (!res.writableEnded) send(200, result)
        })
        .catch((error) => {
          if (!res.writableEnded) send(400, { error: error instanceof Error ? error.message : String(error) })
        })
    },
  })

  // 0.2.0 里改设置会重载插件、apply 再跑一遍；把路由挂进 fiber effect 随插件释放，
  // 否则第二次注册会撞 "duplicate exact route"。
  if (typeof off === 'function' && typeof ctx.effect === 'function') ctx.effect(() => off)
}

/** 读请求体（上限 4MB） */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    const MAX = Number.isInteger(maxBytes) ? maxBytes : 8 * 1024 * 1024
    let aborted = false
    req.on('data', (chunk) => {
      if (aborted) return
      size += chunk.length
      if (size > MAX) {
        // 不能 req.destroy()：那会让连接直接断开，浏览器只报一句「Failed to fetch」，
        // 用户根本看不到「文件太大」这种具体原因。读掉剩余数据、回一个正常的错误。
        aborted = true
        resolve({ __error: '这次提交的数据太大（上限 ' + String(Math.round(MAX / 1024 / 1024)) + 'MB）：大文件会自动分片上传，若仍看到这句请重试' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}
