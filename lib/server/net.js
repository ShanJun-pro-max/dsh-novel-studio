/**
 * 极小的出网工具：给「查有没有新版」用。
 *
 * 为什么不直接用 fetch：国内直连 raw.githubusercontent.com 常常被掐，
 * 而用户机器上的代理只写在 npm 的 `npm_config_proxy` / 系统代理里，
 * Node 的 fetch 不会自动读这些。所以这里：
 *   1. 先从一组环境变量里找出代理地址；
 *   2. 找到就用 HTTP CONNECT 建隧道、再套一层 TLS，自己写 HTTP/1.1 请求；
 *   3. 找不到代理就退回普通 fetch。
 *
 * 只支持 GET + https，够用了。零依赖，只用 Node 内置模块。
 */
import http from 'node:http'
import tls from 'node:tls'

/** 从环境变量里猜代理（npm 的、Unix 惯用的、all_proxy 都看一眼） */
export const proxyOf = () => {
  const env = process.env
  const raw =
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    env.npm_config_https_proxy ||
    env.npm_config_proxy ||
    ''
  const s = String(raw).trim()
  if (s === '') return null
  try {
    const u = new URL(s)
    return { host: u.hostname, port: Number(u.port === '' ? 80 : u.port) }
  } catch {
    return null
  }
}

/** 解 chunked 编码（在 Buffer 上做，不能先转字符串，否则中文会切歪） */
const dechunk = (buf) => {
  const parts = []
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i)
    if (nl < 0) break
    const size = parseInt(buf.slice(i, nl).toString('latin1'), 16)
    if (!Number.isFinite(size) || size <= 0) break
    parts.push(buf.slice(nl + 2, nl + 2 + size))
    i = nl + 2 + size + 2
  }
  return Buffer.concat(parts)
}

const getViaProxy = (urlStr, proxy, timeoutMs) =>
  new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const port = u.port === '' ? 443 : Number(u.port)
    let settled = false
    const finish = (err, text) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(text)
    }
    const timer = setTimeout(() => finish(new Error('代理连接超时')), timeoutMs)
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: u.hostname + ':' + String(port),
      headers: { host: u.hostname + ':' + String(port) },
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      finish(e)
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer)
        socket.destroy()
        finish(new Error('代理拒绝 CONNECT：' + String(res.statusCode)))
        return
      }
      const secure = tls.connect({ socket, servername: u.hostname }, () => {
        const path = u.pathname + (u.search === '' ? '' : u.search)
        secure.write(
          'GET ' + path + ' HTTP/1.1\r\n' +
            'Host: ' + u.hostname + '\r\n' +
            'User-Agent: dsh-novel-studio\r\n' +
            'Accept: application/json\r\n' +
            'Accept-Encoding: identity\r\n' +
            'Connection: close\r\n\r\n',
        )
      })
      const chunks = []
      secure.on('data', (d) => chunks.push(d))
      secure.on('error', (e) => {
        clearTimeout(timer)
        finish(e)
      })
      secure.on('end', () => {
        clearTimeout(timer)
        const raw = Buffer.concat(chunks)
        const split = raw.indexOf('\r\n\r\n')
        if (split < 0) {
          finish(new Error('响应格式看不懂'))
          return
        }
        const head = raw.slice(0, split).toString('utf8')
        const body = raw.slice(split + 4)
        const status = Number((/^HTTP\/[\d.]+\s+(\d+)/u.exec(head) || [])[1] || 0)
        if (status !== 200) {
          finish(new Error('HTTP ' + String(status)))
          return
        }
        const chunked = /transfer-encoding:\s*chunked/iu.test(head)
        finish(null, (chunked ? dechunk(body) : body).toString('utf8'))
      })
    })
    req.end()
  })

/** GET 一个 https 文本；有代理走代理，没有就普通 fetch */
export const fetchText = async (urlStr, timeoutMs) => {
  const proxy = proxyOf()
  if (proxy !== null) return getViaProxy(urlStr, proxy, timeoutMs)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(urlStr, { signal: ctrl.signal, headers: { 'user-agent': 'dsh-novel-studio', accept: 'application/json' } })
    if (!r.ok) throw new Error('HTTP ' + String(r.status))
    return await r.text()
  } finally {
    clearTimeout(timer)
  }
}
