/**
 * 成品小说解析：把上传的小说文件变成纯文本。
 *
 * 不引入任何 npm 依赖——插件一直是零依赖，加了库安装会变慢、还可能装不上。
 * .docx 和 .epub 本质都是 zip，用 Node 内置的 zlib 就能解。
 */
import { inflateRawSync } from 'node:zlib'

/** 从 buffer 里读 zip 目录，返回 { 文件名: 数据 } */
const readZip = (buf) => {
  const out = new Map()
  // 找中央目录结束标记 EOCD：0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')

  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)

  for (let n = 0; n < count; n += 1) {
    if (ptr + 46 > buf.length) break
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break

    const method = buf.readUInt16LE(ptr + 10)
    const compSize = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOffset = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)

    // 读本地文件头，算出数据真正起点
    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOffset + 26)
      const lExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)
      try {
        if (method === 0) out.set(name, raw)
        else if (method === 8) out.set(name, inflateRawSync(raw))
      } catch {
        /* 单个文件坏了不影响整体 */
      }
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** XML → 纯文本：段落换行，去标签，解实体 */
const xmlToText = (xml) => {
  return xml
    .replace(/<w:p[ >]/gu, '\n<w:p ')
    .replace(/<\/w:p>/gu, '\n')
    .replace(/<br\s*\/?>/gu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (m, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** .docx */
const parseDocx = (buf) => {
  const files = readZip(buf)
  const doc = files.get('word/document.xml')
  if (doc === undefined) throw new Error('docx 里找不到 word/document.xml，可能不是 Word 文档')
  const text = xmlToText(doc.toString('utf8'))
  if (text === '') throw new Error('docx 里没有文字内容')
  return text
}

/** .epub：按 spine 顺序拼章节 */
const parseEpub = (buf) => {
  const files = readZip(buf)
  const container = files.get('META-INF/container.xml')
  if (container === undefined) throw new Error('epub 结构不对，缺 META-INF/container.xml')
  const rootMatch = container.toString('utf8').match(/full-path="([^"]+)"/u)
  if (rootMatch === null) throw new Error('epub 找不到 opf 路径')
  const opfPath = rootMatch[1]
  const opf = files.get(opfPath)
  if (opf === undefined) throw new Error('epub 打不开 opf')

  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const opfText = opf.toString('utf8')

  // id → href
  const manifest = new Map()
  const itemRe = /<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*/gu
  let m
  while ((m = itemRe.exec(opfText)) !== null) manifest.set(m[1], m[2])
  // 有些 opf 属性顺序反过来，再扫一遍
  const itemRe2 = /<item\b[^>]*href="([^"]+)"[^>]*id="([^"]+)"/gu
  while ((m = itemRe2.exec(opfText)) !== null) manifest.set(m[2], m[1])

  // spine 里的阅读顺序
  const order = []
  const spineRe = /<itemref\b[^>]*idref="([^"]+)"/gu
  while ((m = spineRe.exec(opfText)) !== null) {
    const href = manifest.get(m[1])
    if (href !== undefined) order.push(baseDir + href)
  }

  const parts = []
  for (const path of order) {
    const f = files.get(path) ?? files.get(decodeURIComponent(path))
    if (f === undefined) continue
    const t = xmlToText(f.toString('utf8'))
    if (t !== '') parts.push(t)
  }
  if (parts.length === 0) throw new Error('epub 里没抽到正文')
  return parts.join('\n\n')
}

/**
 * 解码纯文本：先按 UTF-8 试，不行再按 GBK。
 *
 * 网上下的 txt 大量是 GBK/GB18030 编码（尤其中文站的打包），
 * 直接当 UTF-8 读会整篇变成 `����`，字数虚高、模型也读不出任何内容。
 *
 * 判断办法：UTF-8 解码后如果出现替换字符 U+FFFD，或者中文占比极低，
 * 就换 GB18030 再试一次。
 */
const decodeText = (buf) => {
  const clean = (s) => s.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')

  // 1) UTF-8
  let utf8 = ''
  try {
    utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  } catch {
    utf8 = buf.toString('utf8')
  }
  const badCount = (utf8.match(/\uFFFD/gu) || []).length
  const cjkCount = (utf8.match(/[\u4e00-\u9fff]/gu) || []).length
  const sample = Math.max(1, Math.min(utf8.length, 4000))
  const badRatio = badCount / sample

  // UTF-8 干净（几乎没有乱码、且中文占比合理）就直接用
  if (badRatio < 0.01 && (cjkCount === 0 || cjkCount / sample > 0.05)) {
    return clean(utf8)
  }

  // 2) GB18030（兼容 GBK / GB2312）
  for (const enc of ['gb18030', 'gbk']) {
    try {
      const g = new TextDecoder(enc, { fatal: false }).decode(buf)
      const gBad = (g.match(/\uFFFD/gu) || []).length
      const gCjk = (g.match(/[\u4e00-\u9fff]/gu) || []).length
      const gSample = Math.max(1, Math.min(g.length, 4000))
      // 比 UTF-8 好就采用
      if (gBad / gSample < badRatio || gCjk / gSample > cjkCount / sample) {
        return clean(g)
      }
    } catch {
      /* 这个环境不支持该编码，跳过 */
    }
  }

  // 3) 都不行，退回 UTF-8
  return clean(utf8)
}

/** 统一入口 */
export const readNovelFile = (name, buf) => {
  const lower = String(name).toLowerCase()
  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    const t = decodeText(buf)
    if (t.trim() === '') throw new Error('文件是空的')
    return { text: t, format: lower.endsWith('.md') ? 'md' : 'txt' }
  }
  if (lower.endsWith('.docx')) return { text: parseDocx(buf), format: 'docx' }
  if (lower.endsWith('.epub')) return { text: parseEpub(buf), format: 'epub' }
  throw new Error('暂不支持这个格式：' + name + '。支持 .txt / .md / .docx / .epub')
}

/**
 * 切块：优先按章节标题切，切不出来就按字数硬切。
 * @returns {{ index, title, text, chars }[]}
 */
export const chunkNovel = (text, { targetChars = 8000 } = {}) => {
  const src = String(text == null ? '' : text)
  if (src.trim() === '') return []

  // 章节标题：第X章 / 第X回 / 第X节 / Chapter N / 卷X
  const headingRe = /^(?:第\s*[0-9零一二三四五六七八九十百千两]+\s*[章回节卷]|Chapter\s+\d+|CHAPTER\s+\d+)/mu
  const lines = src.split('\n')
  const cuts = []
  for (let i = 0; i < lines.length; i += 1) {
    if (headingRe.test(lines[i].trim())) cuts.push(i)
  }

  const chunks = []
  const push = (title, body) => {
    const t = body.trim()
    if (t === '') return
    chunks.push({ index: chunks.length, title, text: t, chars: t.length })
  }

  if (cuts.length >= 3) {
    // 有章节结构，按章切；单章太长再拆
    for (let k = 0; k < cuts.length; k += 1) {
      const start = cuts[k]
      const end = k + 1 < cuts.length ? cuts[k + 1] : lines.length
      const title = lines[start].trim().slice(0, 40)
      const body = lines.slice(start, end).join('\n')
      if (body.length <= targetChars * 1.5) {
        push(title, body)
      } else {
        // 太长，按段落累加到 targetChars
        const paras = body.split(/\n\s*\n/u)
        let buf = ''
        let part = 1
        for (const p of paras) {
          if (buf.length + p.length > targetChars && buf !== '') {
            push(title + '（' + String(part) + '）', buf)
            buf = ''
            part += 1
          }
          buf += (buf === '' ? '' : '\n\n') + p
        }
        if (buf.trim() !== '') push(title + '（' + String(part) + '）', buf)
      }
    }
  } else {
    // 没有章节结构，按段落硬切
    const paras = src.split(/\n\s*\n/u)
    let buf = ''
    let i = 1
    for (const p of paras) {
      if (buf.length + p.length > targetChars && buf !== '') {
        push('片段 ' + String(i), buf)
        buf = ''
        i += 1
      }
      buf += (buf === '' ? '' : '\n\n') + p
    }
    if (buf.trim() !== '') push('片段 ' + String(i), buf)
  }

  return chunks
}

/** 粗扫用的摘要：开头 N 字 + 结尾 M 字 */
export const outlineOf = (text, { head = 200, tail = 100 } = {}) => {
  const t = String(text == null ? '' : text)
  if (t.length <= head + tail) return t
  return t.slice(0, head) + '\n……\n' + t.slice(t.length - tail)
}
