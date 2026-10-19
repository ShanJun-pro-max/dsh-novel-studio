/**
 * 小说工坊 · client half
 *
 * 形态：
 * - 侧栏入口：sidebar.footer.action → 开/关工作台
 * - 全屏工作区：shell.overlay → 一页式界面（左侧导航 + 右侧内容）
 *
 * 与旧版的区别：不再「弹窗套弹窗」。所有功能挂在左导航的五个页面里，
 * 页面之间不复用弹层，操作路径从「点开→再点→再点」压到「点一次」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-novel-studio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    const NS = 'dsh-novel-studio'
    /**
     * 桌面版页面是 file://，location.origin 会变成字符串 "null"，
     * 相对路径会被当成文件路径。与宿主自带客户端插件同一套兜底。
     */
    const HOST_BASE = (() => {
      const loc = globalThis.location
      return loc !== undefined && loc !== null && typeof loc.origin === 'string' && loc.origin !== 'null' ? loc.origin : 'http://dsh.internal'
    })()
    const API = new URL('/novel-studio/api/', HOST_BASE).toString()

    // ── 开合状态（两个插槽共享） ──────────────────────────────
    const openStore = { open: false, listeners: new Set() }
    const setOpen = (v) => {
      openStore.open = v
      for (const fn of openStore.listeners) fn(v)
    }
    const useOpen = () => {
      const [v, setV] = useState(openStore.open)
      useEffect(() => {
        const fn = (next) => setV(next)
        openStore.listeners.add(fn)
        return () => openStore.listeners.delete(fn)
      }, [])
      return v
    }

    /**
     * 离开守卫：切页面、返回列表、收起工作台之前都要先问一句。
     * 各页面把自己「有没有未保存的改动 / 怎么保存」注册进来，
     * 这里统一拦截，避免每个入口各写一遍确认框。
     */
    const leaveFlow = {
      guards: [],
      pending: null, // { dirty: [{label, save}], after: () => void }
      listeners: new Set(),
      /** 注册/注销一个守卫；get 为 null 表示注销 */
      add(id, get) {
        this.guards = this.guards.filter((g) => g.id !== id)
        if (get !== null && get !== undefined) this.guards.push({ id, get })
      },
      /** 当前所有未保存的守卫 */
      dirtyOnes() {
        const out = []
        for (const g of this.guards) {
          let info = null
          try {
            info = g.get()
          } catch {
            info = null
          }
          if (info !== null && info !== undefined && info.dirty === true) out.push({ id: g.id, label: info.label || '内容', save: info.save })
        }
        return out
      },
      /** 请求离开：没脏就直接走，有脏就挂起等用户选 */
      request(after) {
        const dirty = this.dirtyOnes()
        if (dirty.length === 0) {
          after()
          return
        }
        this.pending = { dirty, after }
        this.emit()
      },
      /** save=true 保存后离开；false 不保存离开 */
      resolveSave(save) {
        const p = this.pending
        this.pending = null
        this.emit()
        if (p === null) return
        if (save !== true) {
          p.after()
          return
        }
        Promise.all(p.dirty.map((g) => Promise.resolve().then(() => g.save()))).then(
          () => p.after(),
          () => p.after(),
        )
      },
      cancel() {
        this.pending = null
        this.emit()
      },
      emit() {
        for (const fn of this.listeners) fn()
      },
      subscribe(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
      },
    }

    // ── 设计系统 ──────────────────────────────────────────────
    const C = {
      bg: 'var(--dsh-alias-bg, #f5f5f7)',
      card: 'var(--dsh-alias-bg-elevated, #ffffff)',
      text: 'var(--dsh-alias-text, #1c1c1e)',
      sub: 'var(--dsh-alias-text-secondary, #6b6b70)',
      border: 'var(--dsh-alias-border, rgba(0,0,0,0.10))',
      accent: '#0a84ff',
      ok: '#34c759',
      warn: '#ff9f0a',
      danger: '#ff3b30',
      rail: 'rgba(0,0,0,0.025)',
    }

    /** 按钮：kind = default | primary | danger | ghost */
    const btn = (kind) => {
      const base = {
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: 'inherit',
        borderRadius: 8,
        padding: '5px 11px',
        fontSize: 12.5,
        cursor: 'pointer',
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
      }
      if (kind === 'primary') return { ...base, background: C.accent, borderColor: C.accent, color: '#fff', fontWeight: 600 }
      if (kind === 'danger') return { ...base, color: C.danger, borderColor: C.danger + '55' }
      if (kind === 'solidDanger') return { ...base, background: C.danger, borderColor: C.danger, color: '#fff', fontWeight: 600 }
      if (kind === 'ghost') return { ...base, border: '1px solid transparent', color: C.sub }
      return base
    }

    const cardStyle = { background: C.card, border: '1px solid ' + C.border, borderRadius: 10 }
    const inputStyle = {
      border: '1px solid ' + C.border,
      borderRadius: 7,
      padding: '5px 8px',
      fontSize: 12.5,
      background: C.card,
      color: C.text,
      outline: 'none',
    }
    const areaStyle = { ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.8 }

    const fmtBytes = (n) => {
      const v = typeof n === 'number' && n > 0 ? n : 0
      if (v < 1024) return v + ' B'
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
      return (v / 1024 / 1024).toFixed(1) + ' MB'
    }
    const fmtChars = (n) => {
      const v = Number(n) || 0
      if (v < 10000) return String(v) + ' 字'
      return (v / 10000).toFixed(1) + ' 万字'
    }
    const fmtTime = (iso) => {
      if (typeof iso !== 'string' || iso === '') return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return iso
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    // ── RPC ──────────────────────────────────────────────────
    const rpc = async (a, payload) => {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a, ...(payload === undefined ? {} : payload) }),
      })
      let data = null
      try {
        data = await r.json()
      } catch {
        data = null
      }
      if (data === null) throw new Error('服务没响应（HTTP ' + String(r.status) + '）：重启 dsh web 后再试')
      if (data.error !== undefined) throw new Error(String(data.error))
      return data
    }

    // ── 小组件 ────────────────────────────────────────────────
    const Chip = ({ tone, children, title }) =>
      React.createElement(
        'span',
        {
          title,
          style: {
            fontSize: 11,
            padding: '1px 7px',
            borderRadius: 99,
            border: '1px solid ' + (tone === undefined ? C.border : tone),
            color: tone === undefined ? C.sub : tone,
            whiteSpace: 'nowrap',
          },
        },
        children,
      )

    const Empty = ({ children }) =>
      React.createElement('div', { style: { padding: '40px 20px', textAlign: 'center', color: C.sub, fontSize: 13, lineHeight: 1.9 } }, children)

    // ══════════════════════════════════════════════════════════
    // 章节页
    // ══════════════════════════════════════════════════════════
    function ChapterPage({ state, onRefresh, toast }) {
      const readFS =
        state !== null && state.config !== undefined && state.config.readFontSize !== undefined
          ? Number(state.config.readFontSize)
          : 12.5
      const [editing, setEditing] = useState(null) // { chapter, title, text }
      const [busy, setBusy] = useState(false)
      const chapters = state === null ? [] : state.chapters || []
      const editingRef = useRef(null)
      const saveRef = useRef(null)
      editingRef.current = editing
      // 剧情总结：哪一章正在生成、批量进度
      const [sumBusy, setSumBusy] = useState('')
      const [sumProgress, setSumProgress] = useState(null)
      // 正在查看的那份总结：{ chapter, text, before, exists, editing }
      const [sumView, setSumView] = useState(null)
      // 本地退出确认：有未保存改动时，直接在本组件里问，不依赖外层
      const [askBack, setAskBack] = useState(false)

      // 有未保存的正文改动时，切页面 / 收起工作台都要先问
      useEffect(() => {
        leaveFlow.add('chapter', {
          get: () => {
            const cur = editingRef.current
            if (cur === null) return { dirty: false }
            return {
              dirty: cur.text !== cur.before,
              label: '第' + String(cur.chapter) + '章正文',
              save: () => (saveRef.current === null ? Promise.resolve() : saveRef.current()),
            }
          },
        })
        return () => leaveFlow.add('chapter', null)
      }, [])

      const openChapter = async (chapter) => {
        setBusy(true)
        try {
          const d = await rpc('chapter.get', { chapter })
          setEditing({ chapter, title: d.title, text: d.text, before: d.text, chars: d.chars })
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const save = async () => {
        if (editing === null) return
        setBusy(true)
        try {
          const d = await rpc('chapter.save', { chapter: editing.chapter, text: editing.text })
          toast('已保存（' + String(d.chars) + ' 字），原稿备份在 ' + String(d.backup))
          setEditing(null)
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      // 守卫要用到最新的 save，但保存函数每次渲染都会重建，所以挂到 ref 上
      saveRef.current = save

      /** 打开一章的剧情总结来看 */
      const openSummary = async (row) => {
        try {
          const d = await rpc('summary.get', { chapter: row.chapter })
          setSumView({ chapter: row.chapter, text: d.text, before: d.text, exists: d.exists, editing: false })
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      /** 手改后保存 */
      const saveSummary = async () => {
        if (sumView === null) return
        try {
          const d = await rpc('summary.save', { chapter: sumView.chapter, text: sumView.text })
          toast('第' + String(sumView.chapter) + '章总结已保存（' + String(d.chars) + ' 字）')
          setSumView({ ...sumView, before: sumView.text, editing: false })
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      /** 给一章生成剧情总结 */
      const genSummary = async (row, overwrite) => {
        setSumBusy(String(row.chapter))
        try {
          const d = await rpc('summary.generate', { chapter: row.chapter, overwrite: overwrite === true })
          toast('第' + String(row.chapter) + '章总结已生成（' + String(d.chars) + ' 字）' + (d.backup ? '，旧总结已备份' : ''))
          onRefresh()
        } catch (e) {
          toast('第' + String(row.chapter) + '章：' + String(e.message || e))
        } finally {
          setSumBusy('')
        }
      }

      /** 一次补齐所有「有正文没总结」的章 */
      const fillAllSummaries = async () => {
        const todo = chapters.filter((c) => c.hasSummary !== true && c.chars > 0)
        if (todo.length === 0) {
          toast('所有有正文的章节都有剧情总结了')
          return
        }
        if (!window.confirm('要为 ' + String(todo.length) + ' 章补写剧情总结吗？\n\n会调 ' + String(todo.length) + ' 次模型，逐章生成。')) return
        for (let i = 0; i < todo.length; i += 1) {
          const row = todo[i]
          setSumProgress({ done: i, total: todo.length, current: row.chapter })
          setSumBusy(String(row.chapter))
          try {
            await rpc('summary.generate', { chapter: row.chapter })
          } catch (e) {
            toast('第' + String(row.chapter) + '章失败：' + String(e.message || e))
          }
        }
        setSumBusy('')
        setSumProgress(null)
        toast('补写完成：' + String(todo.length) + ' 章')
        onRefresh()
      }

      const del = async (row) => {
        const label = row.title === '' ? '第' + String(row.chapter) + '章' : row.title
        if (!window.confirm('删除「' + label + '」？\n\n正文会移到回收站，能找回；剧情总结也会一起移走。')) return
        setBusy(true)
        try {
          await rpc('chapter.delete', { chapter: row.chapter })
          toast('已移入回收站：' + label)
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      if (editing !== null) {
        return React.createElement(
          'div',
          { style: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 9, padding: '0 0 10px', flexShrink: 0 } },
            React.createElement(
              'button',
              {
                onClick: () => {
                  if (editing !== null && editing.text !== editing.before) {
                    setAskBack(true)
                    return
                  }
                  setEditing(null)
                },
                style: btn(),
              },
              '← 返回',
            ),
            React.createElement('div', { style: { fontWeight: 700, fontSize: 14 } }, '第' + String(editing.chapter) + '章 ' + String(editing.title)),
            React.createElement(Chip, null, fmtChars(editing.text.replace(/\s/gu, '').length)),
            editing.text !== editing.before
              ? React.createElement(
                  'span',
                  { style: { fontSize: 11, padding: '1px 7px', borderRadius: 99, border: '1px solid ' + C.warn, background: C.warn, color: '#fff', fontWeight: 600 } },
                  '● 未保存',
                )
              : React.createElement(Chip, { tone: C.ok }, '已保存'),
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('button', { onClick: () => void save(), disabled: busy || editing.text === editing.before, style: btn('primary') }, busy ? '保存中…' : '保存'),
          ),
          React.createElement('textarea', {
            value: editing.text,
            onChange: (e) => setEditing({ ...editing, text: e.target.value }),
            style: { ...areaStyle, flex: 1, minHeight: 0, resize: 'none', fontSize: readFS + 1, lineHeight: 2 },
          }),
          // 有未保存改动时点「← 返回」：就地弹这个，不依赖任何外层组件
          askBack !== true
            ? null
            : React.createElement(
                'div',
                {
                  style: {
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(0,0,0,0.32)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 10,
                  },
                },
                React.createElement(
                  'div',
                  {
                    style: {
                      width: 'min(400px, 90%)',
                      background: C.card,
                      color: C.text,
                      border: '1px solid ' + C.border,
                      borderRadius: 12,
                      boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
                      padding: 18,
                    },
                  },
                  React.createElement('div', { style: { fontSize: 13.5, fontWeight: 700, marginBottom: 6 } }, '⚠️ 第' + String(editing.chapter) + '章还有没保存的修改'),
                  React.createElement(
                    'div',
                    { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.8, marginBottom: 14 } },
                    '离开会丢掉刚才改的内容（' + String(editing.text.replace(/\s/gu, '').length) + ' 字，原稿 ' + String(editing.before.replace(/\s/gu, '').length) + ' 字）。',
                  ),
                  React.createElement(
                    'div',
                    { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                    React.createElement('button', { onClick: () => setAskBack(false), style: btn() }, '取消'),
                    React.createElement(
                      'button',
                      { onClick: () => { setAskBack(false); setEditing(null) }, style: btn('danger') },
                      '不保存',
                    ),
                    React.createElement(
                      'button',
                      {
                        onClick: async () => {
                          setAskBack(false)
                          await save()
                        },
                        disabled: busy,
                        style: btn('primary'),
                      },
                      busy ? '保存中…' : '保存并离开',
                    ),
                  ),
                ),
              ),
        )
      }

      const missingSummary = chapters.filter((c) => c.hasSummary !== true && c.chars > 0).length

      return React.createElement(
        'div',
        { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
        // 顶部工具条
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '0 0 9px', flexShrink: 0, flexWrap: 'wrap' } },
          React.createElement(Chip, null, String(chapters.length) + ' 章'),
          missingSummary > 0
            ? React.createElement(Chip, { tone: C.warn }, String(missingSummary) + ' 章缺剧情总结')
            : React.createElement(Chip, { tone: C.ok }, '剧情总结齐全'),
          sumProgress === null
            ? null
            : React.createElement(Chip, { tone: C.accent }, '正在写第' + String(sumProgress.current) + '章 ' + String(sumProgress.done + 1) + '/' + String(sumProgress.total)),
          React.createElement('div', { style: { flex: 1 } }),
          React.createElement(
            'button',
            {
              onClick: () => void fillAllSummaries(),
              disabled: sumBusy !== '' || sumProgress !== null || missingSummary === 0,
              style: btn(missingSummary > 0 ? 'primary' : undefined),
              title: '给所有有正文但没总结的章，一次生成剧情总结',
            },
            sumProgress === null ? '📝 补全缺失总结' + (missingSummary > 0 ? '（' + String(missingSummary) + '）' : '') : '补写中…',
          ),
        ),
        React.createElement(
          'div',
          { style: { flex: 1, minHeight: 0, overflow: 'auto' } },
        chapters.length === 0
          ? React.createElement(Empty, null, '还没有章节。\n把正文放进「正文/」或「章节/」目录，文件名带「第N章」就会被认出来。')
          : React.createElement(
              'table',
              { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 } },
              React.createElement(
                'thead',
                null,
                React.createElement(
                  'tr',
                  null,
                  ...['章', '标题', '字数', '状态', '操作'].map((h, i) =>
                    React.createElement(
                      'th',
                      {
                        key: h,
                        style: {
                          textAlign: i === 2 ? 'right' : 'left',
                          padding: '6px 8px',
                          fontSize: 11,
                          color: C.sub,
                          fontWeight: 500,
                          borderBottom: '1px solid ' + C.border,
                          whiteSpace: 'nowrap',
                        },
                      },
                      h,
                    ),
                  ),
                ),
              ),
              React.createElement(
                'tbody',
                null,
                ...chapters.map((row) =>
                  React.createElement(
                    'tr',
                    { key: 'c' + String(row.chapter) },
                    React.createElement('td', { style: { padding: '7px 8px', color: C.sub, borderBottom: '1px solid ' + C.border } }, String(row.chapter)),
                    React.createElement(
                      'td',
                      { style: { padding: '7px 8px', borderBottom: '1px solid ' + C.border } },
                      React.createElement(
                        'span',
                        { onClick: () => void openChapter(row.chapter), style: { cursor: 'pointer', color: C.accent, borderBottom: '1px dashed ' + C.accent + '66' } },
                        row.title === '' ? '第' + String(row.chapter) + '章' : row.title,
                      ),
                    ),
                    React.createElement('td', { style: { padding: '7px 8px', textAlign: 'right', color: C.sub, borderBottom: '1px solid ' + C.border } }, fmtChars(row.chars)),
                    React.createElement(
                      'td',
                      { style: { padding: '7px 8px', borderBottom: '1px solid ' + C.border } },
                      React.createElement(
                        'span',
                        { style: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' } },
                        row.status === 'written'
                          ? React.createElement(
                              'span',
                              {
                                onClick: () => void openChapter(row.chapter),
                                title: '点开看这一章正文',
                                style: {
                                  fontSize: 11,
                                  padding: '1px 7px',
                                  borderRadius: 99,
                                  border: '1px solid ' + C.ok,
                                  color: C.ok,
                                  whiteSpace: 'nowrap',
                                  cursor: 'pointer',
                                },
                              },
                              '有正文 ·',
                            )
                          : React.createElement(Chip, { tone: C.sub }, '缺正文'),
                        row.chars === 0
                          ? null
                          : React.createElement(
                              'span',
                              {
                                onClick: () => void openSummary(row),
                                title: row.hasSummary === true ? '点开看这一章的剧情总结' : '还没有总结，点开可以生成',
                                style: {
                                  fontSize: 11,
                                  padding: '1px 7px',
                                  borderRadius: 99,
                                  border: '1px solid ' + (row.hasSummary === true ? C.ok : C.warn),
                                  color: row.hasSummary === true ? C.ok : C.warn,
                                  whiteSpace: 'nowrap',
                                  cursor: 'pointer',
                                },
                              },
                              row.hasSummary === true ? '有总结 ·' : '缺总结',
                            ),
                      ),
                    ),
                    React.createElement(
                      'td',
                      { style: { padding: '7px 8px', borderBottom: '1px solid ' + C.border, whiteSpace: 'nowrap' } },
                      React.createElement('button', { onClick: () => void openChapter(row.chapter), disabled: busy, style: { ...btn(), padding: '2px 9px', fontSize: 11.5 } }, '编辑'),
                      React.createElement('button', { onClick: () => void openSummary(row), disabled: busy, style: { ...btn(), padding: '2px 9px', fontSize: 11.5, marginLeft: 6 } }, '看总结'),
                      row.chars === 0
                        ? null
                        : React.createElement(
                            'button',
                            {
                              onClick: () => {
                                if (row.hasSummary === true && !window.confirm('第' + String(row.chapter) + '章已经有总结了，要重写吗？')) return
                                void genSummary(row, row.hasSummary === true)
                              },
                              disabled: sumBusy !== '' || sumProgress !== null,
                              style: {
                                ...btn(),
                                padding: '2px 9px',
                                fontSize: 11.5,
                                marginLeft: 6,
                                color: row.hasSummary === true ? C.accent : C.warn,
                                borderColor: (row.hasSummary === true ? C.accent : C.warn) + '66',
                              },
                              title: row.hasSummary === true ? '重新生成这一章的剧情总结' : '让模型读正文，写这一章的剧情总结',
                            },
                            sumBusy === String(row.chapter) ? '生成中…' : row.hasSummary === true ? '重写总结' : '📝 总结',
                          ),
                      React.createElement('button', { onClick: () => void del(row), disabled: busy, style: { ...btn('danger'), padding: '2px 9px', fontSize: 11.5, marginLeft: 6 } }, '删除'),
                    ),
                  ),
                ),
              ),
            ),
        ),
        // ── 剧情总结查看层 ──
        sumView === null
          ? null
          : React.createElement(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 950,
                  background: 'rgba(0,0,0,0.30)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 20,
                },
                onMouseDown: (e) => {
                  if (e.target === e.currentTarget) setSumView(null)
                },
              },
              React.createElement(
                'div',
                {
                  style: {
                    width: 'min(720px, 100%)',
                    maxHeight: '100%',
                    background: C.card,
                    color: C.text,
                    border: '1px solid ' + C.border,
                    borderRadius: 12,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                  },
                },
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid ' + C.border, flexShrink: 0, flexWrap: 'wrap' } },
                  React.createElement('span', { style: { fontWeight: 700, fontSize: 13 } }, '📝 第' + String(sumView.chapter) + '章 剧情总结'),
                  sumView.exists !== true ? React.createElement(Chip, { tone: C.warn }, '还没有') : null,
                  sumView.editing === true && sumView.text !== sumView.before ? React.createElement(Chip, { tone: C.warn }, '未保存') : null,
                  React.createElement('div', { style: { flex: 1 } }),
                  sumView.editing === true
                    ? React.createElement(
                        React.Fragment,
                        null,
                        React.createElement('button', { onClick: () => setSumView({ ...sumView, text: sumView.before, editing: false }), style: { ...btn(), padding: '3px 10px', fontSize: 11.5 } }, '取消'),
                        React.createElement('button', { onClick: () => void saveSummary(), disabled: sumView.text === sumView.before, style: { ...btn('primary'), marginLeft: 6 } }, '保存'),
                      )
                    : React.createElement(
                        React.Fragment,
                        null,
                        sumView.exists === true
                          ? React.createElement('button', { onClick: () => setSumView({ ...sumView, editing: true }), style: { ...btn(), padding: '3px 10px', fontSize: 11.5 } }, '✎ 手改')
                          : null,
                        React.createElement(
                          'button',
                          {
                            onClick: () => {
                              if (sumView.exists === true && !window.confirm('重写第' + String(sumView.chapter) + '章的总结？旧总结会备份。')) return
                              void genSummary({ chapter: sumView.chapter }, sumView.exists === true).then(async () => {
                                try {
                                  const d = await rpc('summary.get', { chapter: sumView.chapter })
                                  setSumView({ chapter: sumView.chapter, text: d.text, before: d.text, exists: d.exists, editing: false })
                                } catch {
                                  // 刷新失败就留着旧内容，不打断
                                }
                              })
                            },
                            disabled: sumBusy !== '',
                            style: { ...btn(), marginLeft: 6, padding: '3px 10px', fontSize: 11.5, color: C.accent, borderColor: C.accent + '66' },
                          },
                          sumBusy !== '' ? '生成中…' : sumView.exists === true ? '⟳ 重写' : '✨ 生成',
                        ),
                        React.createElement('button', { onClick: () => setSumView(null), style: { ...btn(), marginLeft: 6, padding: '3px 10px', fontSize: 11.5 } }, '关闭'),
                      ),
                ),
                sumView.editing === true
                  ? React.createElement('textarea', {
                      value: sumView.text,
                      onChange: (e) => setSumView({ ...sumView, text: e.target.value }),
                      style: { flex: 1, minHeight: 400, resize: 'none', border: 'none', outline: 'none', padding: '12px 14px', fontSize: 12.5, lineHeight: 1.9, background: 'transparent', color: C.text, fontFamily: 'inherit' },
                    })
                  : React.createElement(
                      'div',
                      { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 14px', fontSize: 12.5, lineHeight: 1.9, whiteSpace: 'pre-wrap' } },
                      sumView.exists !== true
                        ? React.createElement('div', { style: { color: C.sub } }, '这一章还没有剧情总结。点上面的「✨ 生成」，让模型读正文写一份。')
                        : sumView.text,
                    ),
              ),
            ),
      )
    }

    // ══════════════════════════════════════════════════════════
    // 候选稿页
    // ══════════════════════════════════════════════════════════
    function DraftsPage({ state, onRefresh, toast }) {
      // 阅读字号：设置里可调，默认 12.5
      const readFS =
        state !== null && state.config !== undefined && state.config.readFontSize !== undefined
          ? Number(state.config.readFontSize)
          : 12.5
      const [groups, setGroups] = useState([])
      const [loading, setLoading] = useState(true)
      const [tabs, setTabs] = useState([])
      const [activeKey, setActiveKey] = useState('')
      const [sel, setSel] = useState({})
      const [busy, setBusy] = useState(false)
      // ── 开新章向导 ──
      const [wiz, setWiz] = useState(null) // null=关闭；否则是向导状态对象
      const abortRef = useRef(false)

      const openWizard = async () => {
        const next = state !== null && state.totals !== undefined ? Number(state.totals.chapters || 0) + 1 : 1
        setWiz({ step: 1, chapter: next, setupText: '', dirCount: 8, extra: '', directions: [], picked: {}, progress: { done: 0, total: 0, current: '' }, notice: '', running: false })
        try {
          const st = await rpc('newchapter.status', { chapter: next })
          setWiz((cur) => (cur === null ? cur : { ...cur, setupText: st.setupText, existed: st.candidates }))
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const closeWizard = () => {
        abortRef.current = true
        setWiz(null)
      }

      const wizPatch = (patch) => setWiz((cur) => (cur === null ? cur : { ...cur, ...patch }))

      const wizChapter = async (n) => {
        const chapter = Number(n) || 1
        wizPatch({ chapter })
        try {
          const st = await rpc('newchapter.status', { chapter })
          wizPatch({ setupText: st.setupText, existed: st.candidates })
        } catch {
          // 读不到就留着现在的设定，不影响继续
        }
      }

      const wizDirections = async () => {
        if (wiz === null) return
        wizPatch({ running: true, notice: '正在让模型给方向…' })
        try {
          const d = await rpc('newchapter.directions', { chapter: wiz.chapter, count: wiz.dirCount, extra: wiz.extra, setupText: wiz.setupText })
          const picked = {}
          for (const x of d.directions) picked[x.index] = true
          wizPatch({
            step: 2,
            directions: d.directions,
            picked,
            packInfo: d.packInfo,
            running: false,
            notice: '方向来自 ' + String(d.model) + '（写作包 ' + String(d.packChars) + ' 字）',
          })
        } catch (e) {
          wizPatch({ running: false, notice: String(e.message || e) })
        }
      }

      const wizWrite = async () => {
        if (wiz === null) return
        const chosen = wiz.directions.filter((x) => wiz.picked[x.index] === true)
        if (chosen.length === 0) {
          wizPatch({ notice: '一个方向都没勾' })
          return
        }
        abortRef.current = false
        wizPatch({ step: 3, running: true, notice: '', progress: { done: 0, total: chosen.length, current: '' } })
        const others = wiz.directions.filter((x) => wiz.picked[x.index] !== true).map((x) => x.name)
        let done = 0
        for (const dir of chosen) {
          if (abortRef.current) break
          wizPatch({ progress: { done, total: chosen.length, current: dir.name } })
          try {
            await rpc('newchapter.draft', { chapter: wiz.chapter, direction: dir, index: dir.index, others, setupText: wiz.setupText })
            done += 1
            wizPatch({ progress: { done, total: chosen.length, current: dir.name } })
          } catch (e) {
            wizPatch({ notice: '「' + String(dir.name) + '」没写成：' + String(e.message || e) })
          }
        }
        wizPatch({ running: false, step: 4, progress: { done, total: chosen.length, current: '' } })
        await load()
      }

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const d = await rpc('drafts.list')
          setGroups(d.groups || [])
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setLoading(false)
        }
      }, [toast])

      useEffect(() => {
        void load()
      }, [load])

      // 顶栏刷新时也重读回收站
      useEffect(() => {
        const h = () => {
          void load()
        }
        window.addEventListener('novel-studio:refresh', h)
        return () => window.removeEventListener('novel-studio:refresh', h)
      }, [load])

      const active = tabs.find((x) => x.key === activeKey) || null
      const keyOf = (chapter, name) => String(chapter) + '|' + name

      const openTab = async (chapter, name) => {
        const key = keyOf(chapter, name)
        if (tabs.some((x) => x.key === key)) {
          setActiveKey(key)
          return
        }
        setBusy(true)
        try {
          const d = await rpc('draft.read', { chapter, name })
          setTabs((prev) => [...prev, { key, chapter, name, segments: d.segments, segMarks: d.segMarks, segPicks: d.segPicks, chars: d.chars }])
          setActiveKey(key)
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const closeTab = (key) => {
        setTabs((prev) => {
          const next = prev.filter((x) => x.key !== key)
          if (activeKey === key) setActiveKey(next.length === 0 ? '' : next[next.length - 1].key)
          return next
        })
      }

      /** 勾/取消一段进合稿。和 👍/👎 完全分开。 */
      const pickSeg = async (tab, index, picked) => {
        try {
          const d = await rpc('draft.pick', { chapter: tab.chapter, name: tab.name, index, picked })
          setTabs((prev) => prev.map((x) => (x.key === tab.key ? { ...x, segPicks: d.segPicks } : x)))
          setGroups((prev) =>
            prev.map((g) => ({
              ...g,
              items: g.items.map((it) => (it.name === tab.name && g.chapter === tab.chapter ? { ...it, picked: d.pickCount } : it)),
            })),
          )
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      /** 一篇候选稿：全勾 / 全不勾进合稿 */
      const pickWhole = async (tab, picked) => {
        try {
          const d = await rpc('draft.pickAll', { chapter: tab.chapter, name: tab.name, picked })
          setTabs((prev) => prev.map((x) => (x.key === tab.key ? { ...x, segPicks: d.segPicks } : x)))
          setGroups((prev) =>
            prev.map((g) => ({
              ...g,
              items: g.items.map((it) => (it.name === tab.name && g.chapter === tab.chapter ? { ...it, picked: d.pickCount } : it)),
            })),
          )
          toast(picked ? '本篇 ' + String(d.count) + ' 段已勾进合稿' : '已全部取消勾选')
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const markSeg = async (tab, index, mark) => {
        const cur = tab.segMarks[index]
        const next = cur === mark ? null : mark
        try {
          const d = await rpc('draft.mark', { chapter: tab.chapter, name: tab.name, index, mark: next })
          setTabs((prev) => prev.map((x) => (x.key === tab.key ? { ...x, segMarks: d.segMarks } : x)))
          setGroups((prev) =>
            prev.map((g) => ({
              ...g,
              items: g.items.map((it) => (it.name === tab.name && g.chapter === tab.chapter ? { ...it, good: d.goodCount, bad: d.badCount, marked: d.goodCount + d.badCount } : it)),
            })),
          )
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const markWhole = async (tab, mark) => {
        try {
          const d = await rpc('draft.mark', { chapter: tab.chapter, name: tab.name, whole: true, mark })
          setTabs((prev) => prev.map((x) => (x.key === tab.key ? { ...x, segMarks: d.segMarks } : x)))
          await load()
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const merge = async (tab) => {
        if (!window.confirm('合并第' + String(tab.chapter) + '章所有候选稿里标「好」的段落，并写入正文？\n\n原稿会自动备份。')) return
        setBusy(true)
        try {
          const d = await rpc('draft.merge', { chapter: tab.chapter })
          toast('已合稿并写入正文：' + String(d.chars) + ' 字（' + String(d.picked) + ' 段）' + (d.backup ? '，原稿已备份' : ''))
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const delChecked = async () => {
        const items = []
        for (const g of groups) for (const it of g.items) if (sel[keyOf(g.chapter, it.name)] === true) items.push({ chapter: g.chapter, name: it.name })
        if (items.length === 0) return
        if (!window.confirm('删除选中的 ' + String(items.length) + ' 篇候选稿？\n\n会移入回收站的「候选稿」分区，能找回。')) return
        setBusy(true)
        try {
          const d = await rpc('drafts.delete', { items })
          const killed = new Set(items.map((x) => keyOf(x.chapter, x.name)))
          setTabs((prev) => prev.filter((x) => !killed.has(x.key)))
          setSel({})
          toast('已删除 ' + String(d.movedCount) + ' 篇')
          await load()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const selCount = Object.keys(sel).filter((k) => sel[k] === true).length

      return React.createElement(
        'div',
        { style: { position: 'relative', display: 'flex', height: '100%', minHeight: 0, gap: 12 } },
        // 左：候选稿列表
        React.createElement(
          'div',
          { style: { width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0, ...cardStyle } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid ' + C.border, flexShrink: 0 } },
            React.createElement('span', { style: { fontSize: 12, fontWeight: 600 } }, '候选稿'),
            React.createElement('span', { style: { fontSize: 10.5, color: C.sub } }, '共 ' + String(groups.reduce((s, g) => s + g.items.length, 0)) + ' 篇'),
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('button', { onClick: () => void openWizard(), disabled: busy, style: { ...btn('primary'), padding: '3px 9px', fontSize: 11 } }, '✍️ 开新章'),
            React.createElement('button', { onClick: () => void load(), disabled: busy, style: { ...btn(), padding: '2px 8px', fontSize: 11 } }, '↻'),
          ),
          React.createElement(
            'div',
            { style: { flex: 1, minHeight: 0, overflow: 'auto' } },
            loading
              ? React.createElement('div', { style: { padding: 14, color: C.sub, fontSize: 12 } }, '读取中…')
              : groups.length === 0
                ? React.createElement('div', { style: { padding: 14, color: C.sub, fontSize: 12, lineHeight: 1.8 } }, '还没有候选稿。\n在设置里设好候选目录后，用「开新章」生成。')
                : groups.map((g) =>
                    React.createElement(
                      'div',
                      { key: 'g' + String(g.chapter) },
                      React.createElement(
                        'div',
                        { style: { padding: '6px 10px', fontSize: 11, fontWeight: 600, color: C.sub, background: C.rail, borderBottom: '1px solid ' + C.border } },
                        '第' + String(g.chapter) + '章 · ' + String(g.items.length) + ' 篇',
                      ),
                      ...g.items.map((it) => {
                        const key = keyOf(g.chapter, it.name)
                        const isOpen = tabs.some((x) => x.key === key)
                        return React.createElement(
                          'div',
                          {
                            key: it.name,
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '6px 10px',
                              borderBottom: '1px solid ' + C.border,
                              background: activeKey === key ? 'rgba(10,132,255,0.09)' : 'transparent',
                            },
                          },
                          React.createElement('input', {
                            type: 'checkbox',
                            checked: sel[key] === true,
                            onChange: (e) => setSel({ ...sel, [key]: e.target.checked }),
                            title: '勾选＝待删除',
                          }),
                          React.createElement(
                            'div',
                            {
                              onDoubleClick: () => void openTab(g.chapter, it.name),
                              onClick: () => {
                                if (isOpen) setActiveKey(key)
                              },
                              title: '双击打开',
                              style: {
                                flex: 1,
                                minWidth: 0,
                                fontSize: 11.5,
                                cursor: 'pointer',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                color: isOpen ? C.accent : 'inherit',
                              },
                            },
                            it.name,
                          ),
                          it.good > 0 ? React.createElement(Chip, { tone: C.ok }, '👍' + String(it.good)) : null,
                          it.bad > 0 ? React.createElement(Chip, { tone: C.danger }, '👎' + String(it.bad)) : null,
                        )
                      }),
                    ),
                  ),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderTop: '1px solid ' + C.border, flexShrink: 0 } },
            React.createElement('span', { style: { flex: 1, fontSize: 11, color: C.sub } }, selCount === 0 ? '未勾选' : '已勾选 ' + String(selCount) + ' 篇'),
            React.createElement('button', { onClick: () => void delChecked(), disabled: busy || selCount === 0, style: { ...btn('danger'), padding: '3px 9px', fontSize: 11.5 } }, '🗑 删除'),
          ),
        ),
        // 右：阅读器
        React.createElement(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, ...cardStyle } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px', borderBottom: '1px solid ' + C.border, overflowX: 'auto', flexShrink: 0, minHeight: 38 } },
            tabs.length === 0
              ? React.createElement('span', { style: { color: C.sub, fontSize: 11.5 } }, '双击左边的文件名打开，可同时开多篇')
              : tabs.map((x) =>
                  React.createElement(
                    'div',
                    {
                      key: x.key,
                      onClick: () => setActiveKey(x.key),
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '3px 8px',
                        borderRadius: 7,
                        border: '1px solid ' + (activeKey === x.key ? C.accent : C.border),
                        background: activeKey === x.key ? 'rgba(10,132,255,0.09)' : 'transparent',
                        fontSize: 11,
                        whiteSpace: 'nowrap',
                        cursor: 'pointer',
                      },
                    },
                    React.createElement('span', { style: { color: activeKey === x.key ? C.accent : C.sub } }, x.name.replace(/\.txt$/iu, '')),
                    React.createElement('span', { onClick: (e) => { e.stopPropagation(); closeTab(x.key) }, style: { color: C.sub, fontWeight: 700, padding: '0 2px' } }, '×'),
                  ),
                ),
          ),
          active === null
            ? null
            : React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderBottom: '1px solid ' + C.border, flexShrink: 0, flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontSize: 11, color: C.sub } }, String(active.segments.length) + ' 段　👍' + String(active.segMarks.filter((m) => m === 'good').length) + '　👎' + String(active.segMarks.filter((m) => m === 'bad').length)),
                React.createElement('div', { style: { flex: 1 } }),
                React.createElement('button', { onClick: () => void pickWhole(active, true), disabled: busy, style: { ...btn(), padding: '2px 8px', fontSize: 11 }, title: '把本篇所有段都勾进合稿' }, '☑ 全勾本篇'),
                React.createElement('button', { onClick: () => void pickWhole(active, false), disabled: busy, style: { ...btn(), padding: '2px 8px', fontSize: 11 }, title: '取消本篇所有勾选' }, '☐ 全不勾'),
                React.createElement('button', { onClick: () => void markWhole(active, null), disabled: busy, style: { ...btn(), padding: '2px 8px', fontSize: 11 } }, '清空'),
                React.createElement('button', { onClick: () => void merge(active), disabled: busy, style: btn('primary') }, '📕 合稿定稿'),
              ),
          React.createElement(
            'div',
            { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 12px' } },
            active === null
              ? null
              : active.segments.map((seg, i) => {
                  const mk = active.segMarks[i]
                  const pk = active.segPicks !== undefined && active.segPicks[i] === true
                  const bg = mk === 'good' ? 'rgba(52,199,89,0.13)' : mk === 'bad' ? 'rgba(255,59,48,0.11)' : 'transparent'
                  // 勾进合稿的段左边竖条用蓝色，和 👍 的绿区分开
                  const bar = pk ? C.accent : mk === 'good' ? C.ok : mk === 'bad' ? C.danger : 'transparent'
                  return React.createElement(
                    'div',
                    {
                      key: 's' + String(i),
                      style: { display: 'flex', gap: 7, padding: '5px 7px', marginBottom: 2, borderRadius: 6, background: bg, borderLeft: '3px solid ' + bar },
                    },
                    React.createElement(
                      'button',
                      {
                        onClick: () => void pickSeg(active, i, !pk),
                        title: pk ? '已勾进合稿（点掉就不进）' : '勾上：这段进合稿',
                        style: {
                          flexShrink: 0,
                          width: 15,
                          height: 15,
                          marginTop: 4,
                          padding: 0,
                          borderRadius: 4,
                          border: '1.5px solid ' + (pk ? C.accent : C.border),
                          background: pk ? C.accent : 'transparent',
                          color: '#fff',
                          fontSize: 10,
                          lineHeight: 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                          transition: 'background 0.12s, border-color 0.12s',
                        },
                      },
                      pk ? '✓' : '',
                    ),
                    React.createElement('span', { style: { color: C.sub, fontSize: 10, flexShrink: 0, paddingTop: 3, minWidth: 20, textAlign: 'right' } }, String(i + 1)),
                    React.createElement('div', { style: { flex: 1, minWidth: 0, fontSize: readFS, lineHeight: 1.9, whiteSpace: 'pre-wrap' } }, seg),
                    React.createElement(
                      'div',
                      { style: { display: 'flex', gap: 3, flexShrink: 0 } },
                      React.createElement(
                        'button',
                        {
                          onClick: () => void markSeg(active, i, 'good'),
                          title: mk === 'good' ? '取消' : '标为好',
                          style: {
                            border: '1px solid ' + (mk === 'good' ? C.ok : C.border),
                            background: mk === 'good' ? C.ok : 'transparent',
                            color: mk === 'good' ? '#fff' : C.sub,
                            borderRadius: 6,
                            padding: '1px 5px',
                            fontSize: 11,
                            cursor: 'pointer',
                          },
                        },
                        '👍',
                      ),
                      React.createElement(
                        'button',
                        {
                          onClick: () => void markSeg(active, i, 'bad'),
                          title: mk === 'bad' ? '取消' : '标为不好',
                          style: {
                            border: '1px solid ' + (mk === 'bad' ? C.danger : C.border),
                            background: mk === 'bad' ? C.danger : 'transparent',
                            color: mk === 'bad' ? '#fff' : C.sub,
                            borderRadius: 6,
                            padding: '1px 5px',
                            fontSize: 11,
                            cursor: 'pointer',
                          },
                        },
                        '👎',
                      ),
                    ),
                  )
                }),
          ),
        ),
        // ── 开新章向导（覆盖层，不离开本页，状态不会丢）──
        wiz === null
          ? null
          : React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(0,0,0,0.30)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 5,
                },
                onMouseDown: (e) => {
                  if (e.target === e.currentTarget && wiz.running !== true) closeWizard()
                },
              },
              React.createElement(
                'div',
                {
                  style: {
                    width: 'min(720px, 100%)',
                    maxHeight: '100%',
                    background: C.card,
                    border: '1px solid ' + C.border,
                    borderRadius: 12,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                  },
                },
                // 标题 + 步骤
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid ' + C.border, flexShrink: 0 } },
                  React.createElement('span', { style: { fontWeight: 700, fontSize: 13 } }, '✍️ 开新章'),
                  ...['这一章写什么', '方向', '写候选', '完成'].map((label, i) =>
                    React.createElement(
                      'span',
                      {
                        key: 'st' + String(i),
                        style: {
                          fontSize: 11,
                          padding: '1px 8px',
                          borderRadius: 99,
                          border: '1px solid ' + (wiz.step === i + 1 ? C.accent : C.border),
                          color: wiz.step === i + 1 ? C.accent : C.sub,
                        },
                      },
                      String(i + 1) + ' ' + label,
                    ),
                  ),
                  React.createElement('div', { style: { flex: 1 } }),
                  React.createElement(
                    'button',
                    { onClick: () => closeWizard(), disabled: wiz.running === true, style: { ...btn(), padding: '2px 9px', fontSize: 11.5 } },
                    wiz.running === true ? '写稿中…' : '关闭',
                  ),
                ),
                // 内容
                React.createElement(
                  'div',
                  { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 14 } },
                  // 第一步
                  wiz.step === 1
                    ? React.createElement(
                        'div',
                        null,
                        React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginBottom: 4 } }, '章号'),
                        React.createElement('input', {
                          type: 'number',
                          value: wiz.chapter,
                          min: 1,
                          onChange: (e) => void wizChapter(e.target.value),
                          style: { ...inputStyle, width: 100 },
                        }),
                        wiz.existed > 0 ? React.createElement('span', { style: { fontSize: 11, color: C.warn, marginLeft: 8 } }, '这一章已有 ' + String(wiz.existed) + ' 篇候选稿') : null,
                        React.createElement('div', { style: { fontSize: 11.5, color: C.sub, margin: '12px 0 4px' } }, '本章设定（会进写作包第①节，也是写候选的依据）'),
                        React.createElement('textarea', {
                          value: wiz.setupText,
                          onChange: (e) => wizPatch({ setupText: e.target.value }),
                          rows: 10,
                          style: { ...areaStyle, fontSize: 12 },
                        }),
                        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
                          React.createElement('span', { style: { fontSize: 11.5, color: C.sub } }, '要几个方向'),
                          React.createElement('input', {
                            type: 'number',
                            value: wiz.dirCount,
                            min: 3,
                            max: 16,
                            onChange: (e) => wizPatch({ dirCount: Number(e.target.value) }),
                            style: { ...inputStyle, width: 80 },
                          }),
                          React.createElement('span', { style: { fontSize: 11, color: C.sub } }, '3—16，建议 8'),
                        ),
                        React.createElement('div', { style: { fontSize: 11.5, color: C.sub, margin: '10px 0 4px' } }, '额外要求（可选）'),
                        React.createElement('textarea', {
                          value: wiz.extra,
                          onChange: (e) => wizPatch({ extra: e.target.value }),
                          rows: 3,
                          placeholder: '例如：这一章要压住节奏，不要出现第二个角色；结尾要留钩子',
                          style: { ...areaStyle, fontSize: 12 },
                        }),
                        React.createElement(
                          'button',
                          { onClick: () => void wizDirections(), disabled: wiz.running === true, style: { ...btn('primary'), marginTop: 14 } },
                          wiz.running === true ? '模型思考中…' : '✨ 让模型给方向',
                        ),
                      )
                    : null,
                  // 第二步：方向清单
                  wiz.step === 2
                    ? React.createElement(
                        'div',
                        null,
                        wiz.packInfo === undefined || wiz.packInfo === null
                          ? null
                          : React.createElement(
                              'div',
                              { style: { border: '1px solid ' + C.border, borderRadius: 8, padding: '8px 10px', marginBottom: 10, background: C.rail } },
                              React.createElement(
                                'div',
                                { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 } },
                                React.createElement('span', { style: { fontSize: 11.5, fontWeight: 600 } }, '📦 这次给模型读了什么'),
                                React.createElement(Chip, null, String(wiz.packInfo.packChars) + ' 字'),
                              ),
                              React.createElement(
                                'div',
                                { style: { fontSize: 10.5, color: C.sub, lineHeight: 1.9 } },
                                '· 大纲：本章前后各 ' + String(wiz.packInfo.outline.window) + ' 章（' + String(wiz.packInfo.outline.near) + ' 个）' +
                                  (wiz.packInfo.outline.related > 0 ? ' + 相关人物回查 ' + String(wiz.packInfo.outline.related) + ' 个' : '') +
                                  '，全书共 ' + String(wiz.packInfo.outline.total) + ' 个节点',
                                React.createElement('br'),
                                '· 剧情总结：近 ' + String(wiz.packInfo.summaries.recent) + ' 章给了全文' +
                                  (wiz.packInfo.summaries.upgraded > 0 ? ' + ' + String(wiz.packInfo.summaries.upgraded) + ' 章因配角回查升级（第' + wiz.packInfo.summaries.upgradedChapters.join('、') + '章）' : '') +
                                  '，更早的 ' + String(wiz.packInfo.summaries.digested) + ' 章只给一句话',
                                React.createElement('br'),
                                '· 上一章正文：' + String(wiz.packInfo.previous.used) + ' / ' + String(wiz.packInfo.previous.original) + ' 字（只取结尾接话）',
                                React.createElement('br'),
                                '· 人物卡：读了 ' + String(wiz.packInfo.people.usedCount) + ' / ' + String(wiz.packInfo.people.total) + ' 张' +
                                  (wiz.packInfo.people.skippedCount > 0 ? '，跳过 ' + String(wiz.packInfo.people.skippedCount) + ' 张' : ''),
                                wiz.packInfo.people.used.length === 0
                                  ? null
                                  : React.createElement('span', { style: { color: C.ok } }, '：' + wiz.packInfo.people.used.join('、')),
                              ),
                            ),
                        React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginBottom: 8 } }, '勾掉不想写的；名字和说明都能改。'),
                        ...wiz.directions.map((d, i) =>
                          React.createElement(
                            'div',
                            { key: 'd' + String(i), style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', border: '1px solid ' + C.border, borderRadius: 8, marginBottom: 6 } },
                            React.createElement('input', {
                              type: 'checkbox',
                              checked: wiz.picked[d.index] === true,
                              onChange: (e) => wizPatch({ picked: { ...wiz.picked, [d.index]: e.target.checked } }),
                              style: { marginTop: 4 },
                            }),
                            React.createElement(
                              'div',
                              { style: { flex: 1, minWidth: 0 } },
                              React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                                React.createElement(Chip, { tone: C.accent }, String.fromCharCode(65 + (d.index % 26))),
                                React.createElement('span', { style: { fontSize: 12, fontWeight: 600 } }, d.name),
                              ),
                              React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginTop: 3, lineHeight: 1.7 } }, d.detail),
                            ),
                          ),
                        ),
                        React.createElement(
                          'div',
                          { style: { display: 'flex', gap: 8, marginTop: 12 } },
                          React.createElement(
                            'button',
                            { onClick: () => void wizWrite(), disabled: wiz.running === true, style: btn('primary') },
                            '✍️ 开始写候选（' + String(wiz.directions.filter((x) => wiz.picked[x.index] === true).length) + ' 篇）',
                          ),
                          React.createElement('button', { onClick: () => wizPatch({ step: 1 }), disabled: wiz.running === true, style: btn() }, '← 上一步'),
                        ),
                      )
                    : null,
                  // 第三步：进度
                  wiz.step === 3
                    ? React.createElement(
                        'div',
                        null,
                        React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 6 } },
                          '正在写 ' + String(wiz.progress.done + 1) + '/' + String(wiz.progress.total) + '：' + String(wiz.progress.current)),
                        React.createElement('div', { style: { height: 6, background: C.border, borderRadius: 99, overflow: 'hidden', marginBottom: 10 } },
                          React.createElement('div', {
                            style: {
                              height: '100%',
                              width: Math.round((wiz.progress.done / Math.max(wiz.progress.total, 1)) * 100) + '%',
                              background: C.accent,
                              transition: 'width 0.3s',
                            },
                          }),
                        ),
                        React.createElement('div', { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.8 } }, '一次写一篇，写完就落盘。中途可以停，已经写好的不会丢。'),
                        React.createElement('button', { onClick: () => { abortRef.current = true }, disabled: wiz.running !== true, style: { ...btn('danger'), marginTop: 10 } }, '停一下'),
                      )
                    : null,
                  // 第四步：完成
                  wiz.step === 4
                    ? React.createElement(
                        'div',
                        null,
                        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '写好了 ' + String(wiz.progress.done) + ' 篇候选稿'),
                        React.createElement('div', { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.9 } }, '关掉这个窗口，在左边点开看，逐段标 👍 / 👎，然后「合稿定稿」写进正文。'),
                        React.createElement('button', { onClick: () => closeWizard(), style: { ...btn('primary'), marginTop: 12 } }, '好，去看候选稿'),
                      )
                    : null,
                ),
                // 提示条
                wiz.notice === ''
                  ? null
                  : React.createElement('div', { style: { padding: '7px 14px', fontSize: 11.5, color: C.sub, borderTop: '1px solid ' + C.border, flexShrink: 0 } }, wiz.notice),
              ),
            ),
      )
    }

    // ══════════════════════════════════════════════════════════
    // 回收站页
    // ══════════════════════════════════════════════════════════
    function TrashPage({ toast }) {
      const [texts, setTexts] = useState([])
      const [drafts, setDrafts] = useState([])
      const [loading, setLoading] = useState(true)
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const d = await rpc('trash.list')
          setTexts(d.texts || [])
          setDrafts(d.drafts || [])
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setLoading(false)
        }
      }, [toast])

      useEffect(() => {
        void load()
      }, [load])

      const view = async (item) => {
        try {
          const d = await rpc('trash.read', { name: item.name, kind: item.kind })
          setPreview({ key: item.kind + '|' + item.name, title: item.title, text: d.text, chars: d.chars })
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const restore = async (item) => {
        if (!window.confirm('恢复「' + item.title + '」？')) return
        setBusy(true)
        try {
          const d = await rpc('trash.restore', { name: item.name, kind: item.kind })
          toast('已恢复到：' + String(d.path))
          setPreview(null)
          await load()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const purge = async (item) => {
        if (!window.confirm('彻底删除「' + item.title + '」？\n\n不可恢复。')) return
        setBusy(true)
        try {
          await rpc('trash.purge', { name: item.name, kind: item.kind })
          toast('已彻底删除')
          if (preview !== null && preview.key === item.kind + '|' + item.name) setPreview(null)
          await load()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const purgeAll = async () => {
        const n = texts.length + drafts.length
        if (n === 0) return
        if (!window.confirm('清空回收站？\n\n会彻底删除 ' + String(n) + ' 项，不可恢复。')) return
        setBusy(true)
        try {
          const d = await rpc('trash.purgeAll')
          toast('已清空 ' + String(d.removedCount) + ' 项')
          setPreview(null)
          await load()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const column = (title, icon, list, kind) =>
        React.createElement(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid ' + C.border } },
          React.createElement('div', { style: { padding: '7px 11px', fontSize: 11, fontWeight: 600, color: C.sub, background: C.rail, borderBottom: '1px solid ' + C.border, flexShrink: 0 } }, icon + ' ' + title + '（' + String(list.length) + '）'),
          React.createElement(
            'div',
            { style: { flex: 1, minHeight: 0, overflow: 'auto' } },
            list.length === 0
              ? React.createElement('div', { style: { padding: 12, color: C.sub, fontSize: 11.5 } }, '空')
              : list.map((item) =>
                  React.createElement(
                    'div',
                    { key: item.name, style: { padding: '7px 11px', borderBottom: '1px solid ' + C.border, background: preview !== null && preview.key === kind + '|' + item.name ? 'rgba(10,132,255,0.08)' : 'transparent' } },
                    React.createElement('div', { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (item.chapter === null ? '' : '第' + String(item.chapter) + '章 ') + String(item.title)),
                    React.createElement('div', { style: { fontSize: 10.5, color: C.sub, marginTop: 2 } }, fmtTime(item.mtime) + '　' + fmtBytes(item.bytes)),
                    React.createElement(
                      'div',
                      { style: { display: 'flex', gap: 5, marginTop: 5 } },
                      React.createElement('button', { onClick: () => void view(item), disabled: busy, style: { ...btn(), padding: '1px 7px', fontSize: 10.5 } }, '查看'),
                      React.createElement('button', { onClick: () => void restore(item), disabled: busy, style: { ...btn(), padding: '1px 7px', fontSize: 10.5, color: C.accent, borderColor: C.accent + '55' } }, '恢复'),
                      React.createElement('button', { onClick: () => void purge(item), disabled: busy, style: { ...btn('danger'), padding: '1px 7px', fontSize: 10.5 } }, '✕ 彻底删'),
                    ),
                  ),
                ),
          ),
        )

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, ...cardStyle, overflow: 'hidden' } },
        loading
          ? React.createElement(Empty, null, '读取中…')
          : React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'div',
                { style: { flex: 1, minHeight: 0, display: 'flex' } },
                column('候选稿', '🗂', drafts, 'draft'),
                column('正文', '📄', texts, 'text'),
                React.createElement(
                  'div',
                  { style: { width: '38%', minWidth: 0, display: 'flex', flexDirection: 'column' } },
                  React.createElement('div', { style: { padding: '7px 11px', fontSize: 11, fontWeight: 600, color: C.sub, background: C.rail, borderBottom: '1px solid ' + C.border, flexShrink: 0 } }, preview === null ? '👁 预览' : '👁 ' + String(preview.title) + '（' + String(preview.chars) + ' 字）'),
                  React.createElement(
                    'div',
                    { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px', fontSize: 12.5, lineHeight: 1.9, whiteSpace: 'pre-wrap' } },
                    preview === null ? React.createElement('span', { style: { color: C.sub, fontSize: 11.5 } }, '点左边「查看」看原文') : preview.text,
                  ),
                ),
              ),
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid ' + C.border, flexShrink: 0 } },
                React.createElement('span', { style: { fontSize: 11.5, color: C.sub } }, '共 ' + String(texts.length + drafts.length) + ' 项（正文 ' + String(texts.length) + ' · 候选稿 ' + String(drafts.length) + '）'),
                React.createElement('div', { style: { flex: 1 } }),
                React.createElement(
                  'button',
                  {
                    onClick: () => {
                      void (async () => {
                        await load()
                        toast('回收站已重新读取：' + String(texts.length + drafts.length) + ' 项')
                      })()
                    },
                    disabled: busy,
                    style: { ...btn(), padding: '2px 9px', fontSize: 11 },
                    title: '重新读取回收站',
                  },
                  '↻ 刷新',
                ),
                React.createElement('button', { onClick: () => void purgeAll(), disabled: busy || texts.length + drafts.length === 0, style: btn('solidDanger') }, '🗑 清空回收站'),
              ),
            ),
      )
    }

    // ══════════════════════════════════════════════════════════
    // 偏好档案页
    // ══════════════════════════════════════════════════════════
    /**
     * 从成品小说学习。
     *
     * 四步：上传 → 粗扫挑重要块 → 精读 → 汇总。
     * 每一步都能停，因为一本书可能要几十次模型调用。
     */
    function LearnPanel({ toast, onApply }) {
      const [tasks, setTasks] = useState([])
      const [task, setTask] = useState(null)
      const [busy, setBusy] = useState('')
      const [progress, setProgress] = useState('')
      const [err, setErr] = useState('')
      // 判定列表默认收起：报告才是主角，不该被挤到最下面
      // 判定理由默认收起，点开展开、展开时按钮变绿
      const [showVerdicts, setShowVerdicts] = useState(false)

      const loadTasks = async () => {
        try {
          const d = await rpc('learn.list')
          setTasks(d.tasks || [])
        } catch (e) {
          setErr(String(e.message || e))
        }
      }

      useEffect(() => {
        void loadTasks()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const upload = async (file) => {
        setBusy('upload')
        setErr('')
        try {
          const buf = await file.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let bin = ''
          const CH = 0x8000
          for (let i = 0; i < bytes.length; i += CH) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
          }
          const b64 = btoa(bin)
          const r = await rpc('learn.import', { name: file.name, data: b64 })
          toast('已切块：' + String(r.chunks) + ' 块，共 ' + String(r.chars) + ' 字')
          await loadTasks()
          const g = await rpc('learn.get', { taskId: r.taskId })
          setTask(g)
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      /** 删一个任务 */
      const delTask = async (t) => {
        if (!window.confirm('删除「' + String(t.name) + '」？\n\n会一并删掉这本书的切块、判定、精读结果和报告，不可恢复。')) return
        try {
          await rpc('learn.delete', { taskId: t.taskId })
          if (task !== null && task.taskId === t.taskId) setTask(null)
          toast('已删除：' + String(t.name))
          await loadTasks()
        } catch (e) {
          setErr(String(e.message || e))
        }
      }

      /** 清空全部任务 */
      const clearAll = async () => {
        if (tasks.length === 0) return
        if (!window.confirm('清空全部 ' + String(tasks.length) + ' 个任务？\n\n所有上传的书、判定、精读结果都会删掉，不可恢复。')) return
        setBusy('clear')
        setErr('')
        let n = 0
        for (const t of tasks) {
          try {
            await rpc('learn.delete', { taskId: t.taskId })
            n += 1
          } catch {
            /* 单个失败就跳过 */
          }
        }
        setTask(null)
        await loadTasks()
        setBusy('')
        toast('已清空 ' + String(n) + ' 个任务')
      }

      const openTask = async (id) => {
        setBusy('open')
        setErr('')
        try {
          const g = await rpc('learn.get', { taskId: id })
          setTask(g)
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      /** 粗扫全部块（分批，可中断） */
      const scanAll = async () => {
        if (task === null) return
        const total = task.verdicts.length
        setBusy('scan')
        setErr('')

        // 「下一块从哪开始」必须按已扫过的最大序号算，不能拿「已判定条数」当序号：
        // 模型一批可能只回 30 条判定，条数 < 实际扫过的块数，
        // 用条数当 from 会反复重扫同一段，永远到不了终点。
        const decidedIdx = task.verdicts.filter((v) => v.decided === true).map((v) => v.index)
        let from = decidedIdx.length === 0 ? 0 : Math.max(...decidedIdx) + 1

        try {
          let guard = 0
          const maxRounds = Math.ceil(total / 10) + 5
          for (;;) {
            guard += 1
            if (guard > maxRounds) {
              setErr('粗扫循环太多次，可能模型一直没返回完整判定。已扫的会保留，可以再点一次继续。')
              break
            }
            setProgress('粗扫 ' + String(from) + '/' + String(total))
            const r = await rpc('learn.scan', { taskId: task.taskId, from, batchSize: 40 })
            // 后端说 done，或者这轮一条判定都没拿到且进度没前进，就停
            if (r.done === true) break
            if (Number(r.to) <= from) {
              setErr('这一批没拿到判定，已停在 ' + String(from) + '/' + String(total) + '，再点一次会从断点继续。')
              break
            }
            from = Number(r.to)
          }
          setProgress('')
          await openTask(task.taskId)
        } catch (e) {
          setErr(String(e.message || e))
          setProgress('')
        } finally {
          setBusy('')
        }
      }

      /** 精读所有被判为重要的块 */
      const digestAll = async () => {
        if (task === null) return
        const todo = task.verdicts.filter((v) => v.keep === true && v.digested !== true)
        if (todo.length === 0) {
          toast('没有待精读的块')
          return
        }
        if (!window.confirm('要精读 ' + String(todo.length) + ' 块吗？\n\n会调用模型 ' + String(todo.length) + ' 次，中途可以停下。')) return
        setBusy('digest')
        setErr('')
        let done = 0
        for (const v of todo) {
          setProgress('精读 ' + String(done) + '/' + String(todo.length))
          try {
            await rpc('learn.digest', { taskId: task.taskId, index: v.index })
            done += 1
          } catch (e) {
            setErr('第 ' + String(v.index + 1) + ' 块失败：' + String(e.message || e))
            break
          }
        }
        setProgress('')
        toast('精读完成 ' + String(done) + ' 块')
        setBusy('')
        await openTask(task.taskId)
      }

      const summarize = async () => {
        if (task === null) return
        setBusy('sum')
        setErr('')
        try {
          await rpc('learn.summarize', { taskId: task.taskId })
          toast('汇总完成')
          await openTask(task.taskId)
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy('')
        }
      }

      const keepCount = task === null ? 0 : task.verdicts.filter((v) => v.keep === true).length
      const decidedCount = task === null ? 0 : task.verdicts.filter((v) => v.decided === true).length

      const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 7, border: '1px solid ' + C.border, marginBottom: 4 }

      return React.createElement(
        'div',
        { style: { ...cardStyle, padding: 14, marginBottom: 12 } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '📚 从成品小说学习'),
          React.createElement('div', { style: { flex: 1 } }),
          React.createElement(
            'label',
            { style: { ...btn('primary'), display: 'inline-flex', alignItems: 'center', gap: 6, cursor: busy === '' ? 'pointer' : 'default' } },
            busy === 'upload' ? '解析中…' : '选择文件',
            React.createElement('input', {
              type: 'file',
              accept: '.txt,.md,.docx,.epub',
              style: { display: 'none' },
              onChange: (e) => {
                const f = e.target.files !== null && e.target.files.length > 0 ? e.target.files[0] : null
                if (f !== null) void upload(f)
                e.target.value = ''
              },
            }),
          ),
        ),
        React.createElement(
          'div',
          { style: { fontSize: 11, color: C.sub, lineHeight: 1.7, marginBottom: 10 } },
          '支持 .txt / .md / .docx / .epub。先粗扫让模型挑出值得学的段落，再精读那些段落，最后汇总成本书的写法。',
        ),

        err === '' ? null : React.createElement('div', { style: { fontSize: 11.5, color: C.danger, marginBottom: 8, lineHeight: 1.7 } }, err),

        progress === '' ? null : React.createElement('div', { style: { fontSize: 11, color: C.accent, marginBottom: 8 } }, progress + ' …'),

        // 任务列表
        tasks.length === 0
          ? null
          : React.createElement(
              'div',
              { style: { marginBottom: 10 } },
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 } },
                React.createElement('span', { style: { fontSize: 11, color: C.sub, flex: 1 } }, '以往的任务（' + String(tasks.length) + '）'),
                React.createElement(
                  'button',
                  { onClick: () => void clearAll(), disabled: busy !== '', style: { ...btn('danger'), padding: '2px 9px', fontSize: 10.5 } },
                  busy === 'clear' ? '清空中…' : '🗑 清空全部',
                ),
              ),
              ...tasks.slice(0, 8).map((t) =>
                React.createElement(
                  'div',
                  { key: t.taskId, style: { ...rowStyle, background: task !== null && task.taskId === t.taskId ? 'rgba(10,132,255,0.08)' : 'transparent' } },
                  React.createElement('span', { style: { fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(t.name)),
                  React.createElement(Chip, { tone: C.sub }, String(t.chunks) + '块'),
                  t.scanned > 0 ? React.createElement(Chip, { tone: C.ok }, '扫' + String(t.scanned)) : null,
                  t.digested > 0 ? React.createElement(Chip, { tone: C.accent }, '读' + String(t.digested)) : null,
                  t.hasReport ? React.createElement(Chip, { tone: C.ok }, '有报告') : null,
                  React.createElement('button', { onClick: () => void openTask(t.taskId), style: { ...btn(), padding: '1px 8px', fontSize: 10.5 } }, '打开'),
                  React.createElement(
                    'button',
                    { onClick: () => void delTask(t), disabled: busy !== '', title: '删除这个任务', style: { ...btn(), padding: '1px 7px', fontSize: 10.5, color: C.danger, borderColor: C.danger + '55' } },
                    '✕',
                  ),
                ),
              ),
              tasks.length > 8
                ? React.createElement('div', { style: { fontSize: 10, color: C.sub, padding: '2px 0' } }, '还有 ' + String(tasks.length - 8) + ' 个任务没显示（用「清空全部」一起删）')
                : null,
            ),

        // 当前任务
        task === null
          ? null
          : React.createElement(
              'div',
              null,
              React.createElement(
                'div',
                { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } },
                String(task.meta.name),
                React.createElement('span', { style: { fontSize: 11, color: C.sub, fontWeight: 400, marginLeft: 8 } },
                  String(task.meta.chunks) + ' 块 · ' + String(task.meta.chars) + ' 字 · 已判定 ' + String(decidedCount) + ' · 重要 ' + String(keepCount) + ' · 已精读 ' + String(task.digested)),
              ),

              // 步骤条：当前该点的高亮蓝色，做过的打勾，没到的灰掉
              React.createElement(
                'div',
                { style: { display: 'flex', gap: 8, margin: '10px 0', flexWrap: 'wrap' } },
                ...(function () {
                  const scanDone = decidedCount >= task.verdicts.length && task.verdicts.length > 0
                  const todoDigest = task.verdicts.filter((v) => v.keep === true && v.digested !== true).length
                  const digestDone = keepCount > 0 && todoDigest === 0
                  const hasReport = task.report !== null && task.reportMd !== ''
                  const steps = [
                    {
                      key: 'scan',
                      label: busy === 'scan' ? '粗扫中…' : '① 粗扫挑重要块',
                      state: scanDone ? 'done' : busy === 'scan' ? 'active' : 'todo',
                      enabled: busy === '' && !scanDone,
                      onClick: () => void scanAll(),
                    },
                    {
                      key: 'digest',
                      label: busy === 'digest' ? '精读中…' : digestDone ? '② 精读已完成' : '② 精读 ' + String(todoDigest) + ' 块',
                      state: digestDone ? 'done' : busy === 'digest' ? 'active' : decidedCount > 0 ? 'active' : 'todo',
                      // 扫过一部分就能精读——不必等 100% 扫完，避免卡死
                      enabled: busy === '' && keepCount > 0 && todoDigest > 0,
                      onClick: () => void digestAll(),
                    },
                    {
                      key: 'sum',
                      label: busy === 'sum' ? '汇总中…' : hasReport ? '③ 报告已生成' : '③ 汇总成报告',
                      state: hasReport ? 'done' : busy === 'sum' ? 'active' : digestDone ? 'active' : 'todo',
                      enabled: busy === '' && digestDone,
                      onClick: () => void summarize(),
                    },
                  ]
                  return steps.map((s) => {
                    const active = s.state === 'active'
                    const done = s.state === 'done'
                    return React.createElement(
                      'button',
                      {
                        key: s.key,
                        onClick: s.onClick,
                        disabled: !s.enabled,
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 14px',
                          borderRadius: 8,
                          fontSize: 12,
                          fontWeight: active ? 600 : 400,
                          border: '1px solid ' + (active ? C.accent : done ? C.ok + '66' : C.border),
                          background: active ? C.accent : done ? 'rgba(52,199,89,0.10)' : 'transparent',
                          color: active ? '#fff' : done ? C.ok : C.sub,
                          cursor: s.enabled ? 'pointer' : 'default',
                          opacity: s.enabled || done ? 1 : 0.55,
                        },
                      },
                      done ? '✓' : active ? '▸' : '○',
                      s.label,
                    )
                  })
                })(),
              ),

              // 判定理由（放在报告上方，随时能看到）
              decidedCount === 0
                ? null
                : React.createElement(
                    'div',
                    { style: { marginTop: 4 } },
                    React.createElement(
                      'button',
                      {
                        onClick: () => setShowVerdicts((v) => !v),
                        style: {
                          ...btn(),
                          padding: '5px 12px',
                          fontSize: 11.5,
                          width: '100%',
                          textAlign: 'left',
                          fontWeight: showVerdicts ? 600 : 400,
                          // 展开时变绿，一眼看出当前是开着的
                          background: showVerdicts ? 'rgba(52,199,89,0.14)' : 'transparent',
                          border: '1px solid ' + (showVerdicts ? C.ok : C.border),
                          color: showVerdicts ? C.ok : C.text,
                        },
                      },
                      (showVerdicts ? '▾ 收起' : '▸ 展开') + '　' + String(decidedCount) + ' 块的判定理由',
                    ),
                    showVerdicts === false
                      ? null
                      : React.createElement(
                          'div',
                          { style: { maxHeight: 260, overflowY: 'auto', marginTop: 6, border: '1px solid ' + C.border, borderRadius: 8, padding: 6 } },
                          ...task.verdicts
                            .filter((v) => v.decided === true)
                            .slice(0, 60)
                            .map((v) =>
                              React.createElement(
                                'div',
                                { key: 'vt' + String(v.index), style: { ...rowStyle, alignItems: 'flex-start', opacity: v.keep === true ? 1 : 0.55 } },
                                React.createElement(Chip, { tone: v.keep === true ? C.ok : C.sub }, v.keep === true ? '重要' : '跳过'),
                                React.createElement(
                                  'div',
                                  { style: { flex: 1, minWidth: 0 } },
                                  React.createElement('div', { style: { fontSize: 11.5, fontWeight: 600 } }, String(v.title) + '（' + String(v.chars) + ' 字）' + (v.digested === true ? ' ✓已精读' : '')),
                                  React.createElement('div', { style: { fontSize: 10.5, color: C.sub, lineHeight: 1.6 } }, String(v.why)),
                                ),
                              ),
                            ),
                        ),
                  ),

              // 报告
              task.report === null || task.reportMd === ''
                ? null
                : React.createElement(
                    'div',
                    { style: { marginTop: 10, padding: 12, borderRadius: 8, background: C.rail, border: '1px solid ' + C.accent + '44' } },
                    React.createElement(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                      React.createElement('span', { style: { fontSize: 12.5, fontWeight: 700 } }, '📄 这本书的写法'),
                      React.createElement('div', { style: { flex: 1 } }),
                      React.createElement(
                        'button',
                        {
                          onClick: () => onApply(task.reportMd),
                          style: { ...btn('primary'), padding: '2px 10px', fontSize: 11 },
                        },
                        '追加到偏好档案',
                      ),
                    ),
                    React.createElement(
                      'div',
                      { style: { fontSize: 11.5, lineHeight: 1.9, whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto', overflowX: 'hidden', paddingRight: 4 } },
                      String(task.reportMd),
                    ),
                  ),
            ),

      )
    }

    function ProfilePage({ state, onRefresh, toast }) {
      const [text, setText] = useState('')
      const [before, setBefore] = useState('')
      const [types, setTypes] = useState([])
      const [typeTrash, setTypeTrash] = useState([])
      const [showTrash, setShowTrash] = useState(false)
      const [busy, setBusy] = useState(false)
      // ── 提炼规律 ──
      const [pen, setPen] = useState(null) // { total, good, bad, pending }
      const [distillResult, setDistillResult] = useState(null) // { rules: [], model, usedSegments }
      const [distillPicked, setDistillPicked] = useState({})
      const [distilling, setDistilling] = useState(false)
      const textRef = useRef('')
      const beforeRef = useRef('')
      const saveRef2 = useRef(null)
      textRef.current = text
      beforeRef.current = before

      useEffect(() => {
        leaveFlow.add('profile', {
          get: () => ({
            dirty: textRef.current !== beforeRef.current,
            label: '作者偏好档案',
            save: () => (saveRef2.current === null ? Promise.resolve() : saveRef2.current()),
          }),
        })
        return () => leaveFlow.add('profile', null)
      }, [])

      const loadPending = useCallback(async () => {
        try {
          const d = await rpc('distill.pending')
          setPen(d)
        } catch {
          setPen(null)
        }
      }, [])

      useEffect(() => {
        void loadPending()
      }, [loadPending])

      const runDistill = async () => {
        if (pen !== null && pen.total === 0) {
          window.alert('全书还没有标注：先在候选稿里逐段点 👍 / 👎，再回来提炼。')
          return
        }
        const tip =
          pen === null
            ? '开始提炼？'
            : pen.pending > 0
              ? '有 ' + String(pen.pending) + ' 条新标注待提炼。\n\n会调一次模型，把标注压成规律。继续？'
              : '没有新标注，会用全部 ' + String(pen.total) + ' 条重提炼一次。\n\n继续？'
        if (!window.confirm(tip)) return
        setDistilling(true)
        setDistillResult(null)
        try {
          const d = await rpc('distill.run')
          const picked = {}
          for (const r of d.rules) picked[r.id] = true
          setDistillResult(d)
          setDistillPicked(picked)
        } catch (e) {
          window.alert(String(e.message || e))
        } finally {
          setDistilling(false)
        }
      }

      const applyDistill = async () => {
        if (distillResult === null) return
        const chosen = distillResult.rules.filter((r) => distillPicked[r.id] === true)
        if (chosen.length === 0) {
          window.alert('一条都没选')
          return
        }
        setBusy(true)
        try {
          const d = await rpc('distill.apply', { rules: chosen })
          window.alert('已写进档案：新增 ' + String(d.added) + ' 条（好 ' + String(d.addedGood) + ' · 坏 ' + String(d.addedBad) + '）')
          setDistillResult(null)
          await load()
          await loadPending()
          onRefresh()
        } catch (e) {
          window.alert(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const [p, t] = await Promise.all([rpc('profile.get'), rpc('types.list')])
          setText(p.text)
          setBefore(p.text)
          setTypes(t.types || [])
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }, [toast])

      useEffect(() => {
        void load()
      }, [load])

      const save = async () => {
        setBusy(true)
        try {
          const d = await rpc('profile.save', { text, dedupe: true })
          const removed = Array.isArray(d.removed) ? d.removed : []
          if (removed.length > 0) {
            // 后端已经把重复条目删掉了，这里同步回显
            const fresh = await rpc('profile.get')
            setText(String(fresh.text))
            setBefore(String(fresh.text))
            toast('已保存，并合并了 ' + String(removed.length) + ' 条重复：' + removed.slice(0, 3).join('；') + (removed.length > 3 ? ' 等' : ''))
            onRefresh()
          } else {
            setBefore(text)
            toast('档案已保存')
            onRefresh()
          }
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      saveRef2.current = save

      /**
       * 清掉旧版本留下的说明行（「由 dsh-novel-craft …」「候选目录：…」那几条）。
       * 只删以 > 开头、且含这些特征的行，别的引用块动。
       */
      const cleanLegacy = async () => {
        const lines = String(text).split('\n')
        const out = []
        let dropped = 0
        for (const line of lines) {
          const t = line.trim()
          if (
            t.startsWith('>') &&
            (/dsh-novel-craft/u.test(t) || /候选目录：/u.test(t) || /原文证据在/u.test(t) || /自动块（begin/u.test(t))
          ) {
            dropped += 1
            continue
          }
          out.push(line)
        }
        if (dropped === 0) {
          toast('没找到旧说明行')
          return
        }
        setText(out.join('\n').replace(/\n{3,}/gu, '\n\n'))
        toast('已清掉 ' + String(dropped) + ' 行旧说明，点「保存档案」生效')
      }

      const clear = async () => {
        if (!window.confirm('清空当前档案？\n\n旧档案会先备份到 .dsh-novel-craft/备份/。')) return
        setBusy(true)
        try {
          const d = await rpc('profile.clear')
          toast('已清空' + (d.backup ? '，备份在 ' + String(d.backup) : ''))
          await load()
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const bindType = async (name) => {
        setBusy(true)
        try {
          await rpc('types.bind', { name })
          toast(name === '' ? '已解绑' : '已绑定类型「' + name + '」')
          await load()
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const createType = async () => {
        const name = window.prompt('新建类型（例如：兽人校园、都市重生）\n\n同类型的书共用这份偏好档案。')
        if (name === null || String(name).trim() === '') return
        setBusy(true)
        try {
          await rpc('types.create', { name: String(name).trim() })
          toast('类型已创建并绑定')
          await load()
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const saveAs = async () => {
        const name = window.prompt('把当前档案存为类型：', state !== null && state.profile !== undefined ? String(state.profile.type || '') : '')
        if (name === null || String(name).trim() === '') return
        setBusy(true)
        try {
          await rpc('types.saveAs', { name: String(name).trim() })
          await rpc('types.bind', { name: String(name).trim() })
          toast('已存为类型并绑定')
          await load()
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const delType = async () => {
        const cur = state !== null && state.profile !== undefined ? String(state.profile.type || '') : ''
        if (cur === '') return
        if (!window.confirm('删除类型「' + cur + '」？\n\n整个类型移到类型回收站，本书解绑。')) return
        setBusy(true)
        try {
          await rpc('types.delete', { name: cur })
          toast('已移入类型回收站')
          await load()
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const loadTypeTrash = async () => {
        try {
          const d = await rpc('types.trashList')
          setTypeTrash(d.items || [])
          setShowTrash(true)
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const restoreType = async (item) => {
        if (!window.confirm('恢复类型「' + item.typeName + '」？')) return
        try {
          await rpc('types.trashRestore', { name: item.dirName })
          const d = await rpc('types.trashList')
          setTypeTrash(d.items || [])
          await load()
          toast('已恢复类型「' + item.typeName + '」')
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const purgeType = async (item) => {
        if (!window.confirm('彻底删除类型「' + item.typeName + '」？\n\n不可恢复。')) return
        try {
          await rpc('types.trashPurge', { name: item.dirName })
          const d = await rpc('types.trashList')
          setTypeTrash(d.items || [])
          toast('已彻底删除')
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const purgeTypeAll = async () => {
        if (typeTrash.length === 0) return
        if (!window.confirm('清空类型回收站？\n\n会彻底删除 ' + String(typeTrash.length) + ' 个类型，不可恢复。')) return
        try {
          await rpc('types.trashPurgeAll')
          setTypeTrash([])
          toast('已清空')
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const currentType = state !== null && state.profile !== undefined ? String(state.profile.type || '') : ''

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 10, overflowY: 'auto', overflowX: 'hidden', paddingRight: 2 } },
        // 类型条
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', padding: '8px 10px', ...cardStyle, flexShrink: 0 } },
          React.createElement('span', { style: { fontSize: 11.5, color: C.sub } }, '本书类型'),
          React.createElement(
            'select',
            {
              value: currentType,
              disabled: busy,
              onChange: (e) => void bindType(e.target.value),
              style: { ...inputStyle, padding: '3px 7px' },
            },
            currentType === '' ? React.createElement('option', { value: '', disabled: true }, types.length === 0 ? '还没有类型' : '— 选一个类型 —') : null,
            ...types.map((x) => React.createElement('option', { key: x.name, value: x.name }, x.name + (x.chars > 0 ? '（' + String(x.chars) + ' 字）' : '（空）'))),
          ),
          React.createElement('button', { onClick: () => void createType(), disabled: busy, style: { ...btn(), padding: '3px 9px', fontSize: 11.5 } }, '＋ 新建类型'),
          React.createElement('button', { onClick: () => void saveAs(), disabled: busy, style: { ...btn(), padding: '3px 9px', fontSize: 11.5 } }, '存为类型'),
          React.createElement('button', { onClick: () => void clear(), disabled: busy, style: { ...btn('danger'), padding: '3px 9px', fontSize: 11.5 } }, '清空档案'),
          currentType === '' ? null : React.createElement('button', { onClick: () => void delType(), disabled: busy, style: { ...btn('danger'), padding: '3px 9px', fontSize: 11.5 } }, '✕ 删除类型'),
          React.createElement('button', { onClick: () => void loadTypeTrash(), disabled: busy, style: { ...btn(), padding: '3px 9px', fontSize: 11.5 } }, '♻ 类型回收站'),
          React.createElement('div', { style: { flex: 1 } }),
          text !== before ? React.createElement(Chip, { tone: C.warn }, '未保存') : null,
          React.createElement('button', { onClick: () => void save(), disabled: busy || text === before, style: btn('primary') }, '保存档案'),
        ),
        // 从成品小说学习
        React.createElement(LearnPanel, {
          toast,
          onApply: (md) => {
            const block = '\n\n<!-- 来源：成品小说分析 -->\n' + String(md).trim() + '\n'
            setText((prev) => String(prev).replace(/\s+$/u, '') + block)
            toast('已追加到档案，记得点「保存档案」')
          },
        }),
        // 提炼工具条
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', ...cardStyle, flexShrink: 0, flexWrap: 'wrap' } },
          React.createElement(
            'button',
            { onClick: () => void runDistill(), disabled: distilling || busy, style: btn('primary') },
            distilling ? '提炼中…' : '✨ 提炼规律',
          ),
          pen === null
            ? React.createElement('span', { style: { fontSize: 11.5, color: C.sub } }, '读不到标注')
            : React.createElement(
                'span',
                { style: { fontSize: 11.5, color: C.sub } },
                '全书 ' + String(pen.total) + ' 条标注（👍' + String(pen.good) + ' · 👎' + String(pen.bad) + '）',
                pen.pending > 0
                  ? React.createElement('span', { style: { color: C.warn, marginLeft: 8 } }, String(pen.pending) + ' 条待提炼')
                  : React.createElement('span', { style: { color: C.ok, marginLeft: 8 } }, '都提炼过了'),
              ),
          React.createElement('div', { style: { flex: 1 } }),
          React.createElement('span', { style: { fontSize: 11, color: C.sub } }, '把标好的段落压成规律，直接写进下面这份档案'),
        ),
        // 档案正文
        React.createElement(
          'div',
          { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', ...cardStyle, overflow: 'hidden' } },
          React.createElement(
            'div',
            { style: { padding: '7px 11px', fontSize: 10.5, color: C.sub, borderBottom: '1px solid ' + C.border, flexShrink: 0, wordBreak: 'break-all' } },
            state !== null && state.profile !== undefined && state.profile.path !== '' ? String(state.profile.path) : '（还没定位到档案）',
          ),
          React.createElement('textarea', {
            value: text,
            onChange: (e) => setText(e.target.value),
            placeholder: '在这里写能复用的写作规律：作者喜欢什么、讨厌什么。写稿时会读这一份。',
            style: { flex: 1, minHeight: 0, resize: 'none', border: 'none', outline: 'none', padding: '10px 12px', fontSize: 12.5, lineHeight: 1.9, background: 'transparent', color: C.text, fontFamily: 'inherit' },
          }),
        ),
        // 类型回收站
        showTrash
          ? React.createElement(
              'div',
              { style: { ...cardStyle, flexShrink: 0, maxHeight: 200, display: 'flex', flexDirection: 'column' } },
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px', borderBottom: '1px solid ' + C.border, flexShrink: 0 } },
                React.createElement('span', { style: { fontSize: 11.5, fontWeight: 600 } }, '♻ 类型回收站'),
                React.createElement('div', { style: { flex: 1 } }),
                React.createElement('button', { onClick: () => void purgeTypeAll(), disabled: typeTrash.length === 0, style: { ...btn('danger'), padding: '2px 8px', fontSize: 11 } }, '清空'),
                React.createElement('button', { onClick: () => setShowTrash(false), style: { ...btn(), padding: '2px 8px', fontSize: 11 } }, '关闭'),
              ),
              React.createElement(
                'div',
                { style: { overflow: 'auto' } },
                typeTrash.length === 0
                  ? React.createElement('div', { style: { padding: 12, color: C.sub, fontSize: 11.5 } }, '空的')
                  : typeTrash.map((it) =>
                      React.createElement(
                        'div',
                        { key: it.dirName, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px', borderBottom: '1px solid ' + C.border } },
                        React.createElement('div', { style: { flex: 1, minWidth: 0 } }, it.typeName + '　', React.createElement('span', { style: { color: C.sub, fontSize: 10.5 } }, fmtTime(it.stamp) + '　' + String(it.chars) + ' 字')),
                        React.createElement('button', { onClick: () => void restoreType(it), style: { ...btn(), padding: '2px 8px', fontSize: 11, color: C.accent, borderColor: C.accent + '55' } }, '恢复'),
                        React.createElement('button', { onClick: () => void purgeType(it), style: { ...btn('danger'), padding: '2px 8px', fontSize: 11 } }, '✕ 彻底删'),
                      ),
                    ),
              ),
            )
          : null,
        // ── 提炼结果：勾选要采纳的规律 ──
        distillResult === null
          ? null
          : React.createElement(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 950,
                  background: 'rgba(0,0,0,0.30)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 20,
                },
                onMouseDown: (e) => {
                  if (e.target === e.currentTarget && distilling !== true) setDistillResult(null)
                },
              },
              React.createElement(
                'div',
                {
                  style: {
                    width: 'min(680px, 100%)',
                    maxHeight: '100%',
                    background: C.card,
                    border: '1px solid ' + C.border,
                    borderRadius: 12,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                  },
                },
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid ' + C.border, flexShrink: 0 } },
                  React.createElement('span', { style: { fontWeight: 700, fontSize: 13 } }, '✨ 提炼结果'),
                  React.createElement(Chip, null, distillResult.rules.length + ' 条'),
                  React.createElement(Chip, null, '用了 ' + distillResult.usedSegments + ' 段标注'),
                  React.createElement('div', { style: { flex: 1 } }),
                  React.createElement('button', { onClick: () => setDistillResult(null), style: { ...btn(), padding: '2px 9px', fontSize: 11.5 } }, '关闭'),
                ),
                React.createElement(
                  'div',
                  { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 12 } },
                  React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginBottom: 8 } }, '勾掉不像你口味的；剩下的会写进「已验证偏好 / 避免的写法」。'),
                  ...distillResult.rules.map((r) =>
                    React.createElement(
                      'div',
                      {
                        key: r.id,
                        style: {
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                          padding: '7px 9px',
                          marginBottom: 5,
                          border: '1px solid ' + (r.mark === 'good' ? C.ok + '55' : C.danger + '55'),
                          borderRadius: 8,
                          background: r.mark === 'good' ? 'rgba(52,199,89,0.06)' : 'rgba(255,59,48,0.05)',
                        },
                      },
                      React.createElement('input', {
                        type: 'checkbox',
                        checked: distillPicked[r.id] === true,
                        onChange: (e) => setDistillPicked({ ...distillPicked, [r.id]: e.target.checked }),
                        style: { marginTop: 4 },
                      }),
                      React.createElement(
                        'div',
                        { style: { flex: 1, minWidth: 0 } },
                        React.createElement(
                          'div',
                          { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                          React.createElement(Chip, { tone: r.mark === 'good' ? C.ok : C.danger }, r.mark === 'good' ? '👍 要这样' : '👎 别这样'),
                          React.createElement('span', { style: { fontSize: 12.5, lineHeight: 1.7 } }, r.text),
                        ),
                        r.evidence.length === 0
                          ? null
                          : React.createElement(
                              'details',
                              { style: { marginTop: 3 } },
                              React.createElement('summary', { style: { fontSize: 10.5, color: C.sub, cursor: 'pointer' } }, '来自 ' + String(r.evidence.length) + ' 段'),
                              ...r.evidence.map((ev, i) =>
                                React.createElement(
                                  'div',
                                  { key: 'ev' + String(i), style: { fontSize: 10.5, color: C.sub, lineHeight: 1.7, marginTop: 3, paddingLeft: 8, borderLeft: '2px solid ' + C.border } },
                                  '第' + String(ev.chapter) + '章 ' + String(ev.file).replace(/\.txt$/iu, '') + ' · 第' + String(ev.index + 1) + '段：' + ev.text,
                                ),
                              ),
                            ),
                      ),
                    ),
                  ),
                ),
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderTop: '1px solid ' + C.border, flexShrink: 0 } },
                  React.createElement('span', { style: { flex: 1, fontSize: 11, color: C.sub } }, '模型：' + String(distillResult.model)),
                  React.createElement('button', { onClick: () => void applyDistill(), disabled: busy, style: btn('primary') },
                    '采纳 ' + String(distillResult.rules.filter((r) => distillPicked[r.id] === true).length) + ' 条写进档案'),
                ),
              ),
            ),
      )
    }

    // ══════════════════════════════════════════════════════════
    // 情节体检页
    // ══════════════════════════════════════════════════════════
    function PlotPage({ toast }) {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [showAllDebts, setShowAllDebts] = useState(false)
      // 一致性检查（纯规则，不花钱）
      const [cons, setCons] = useState(null)
      const [headBusy, setHeadBusy] = useState(false)
      // 别称建议
      const [aliasSug, setAliasSug] = useState(null)
      const [aliasBusy, setAliasBusy] = useState(false)
      // 建卡弹窗：null = 关着，否则 { name, card, busy, err }
      const [cardMaker, setCardMaker] = useState(null)
      // 正在让模型猜哪个字段（空字符串 = 没在猜）
      const [guessBusy, setGuessBusy] = useState('')

      const load = async () => {
        setLoading(true)
        try {
          const d = await rpc('plot.analysis')
          setData(d)
          const c = await rpc('consistency.check')
          setCons(c)
          const al = await rpc('people.suggestAliases', { minHits: 3 })
          setAliasSug(al)
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => {
        void load()
      }, [])

      /** 把一条别称写进角色卡 */
      const adoptAlias = async (c) => {
        setAliasBusy(true)
        try {
          await rpc('people.setAliases', { name: c.name, add: [c.alias] })
          toast('已把「' + String(c.alias) + '」记到 ' + String(c.name) + ' 名下')
          const al = await rpc('people.suggestAliases', { minHits: 3 })
          setAliasSug(al)
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setAliasBusy(false)
        }
      }

      /** 打开建卡弹窗 */
      const openCardMaker = (name) => {
        setCardMaker({
          name,
          // 只给一个姓名的空壳。字段该有哪些，交给模型按书的类型判断，
          // 或者由作者自己加——这个插件不只服务兽人小说。
          card: { 姓名: name },
          busy: false,
          err: '',
        })
      }

      /** 让模型读前文生成草稿 */
      const genCard = async () => {
        if (cardMaker === null) return
        setCardMaker((c) => ({ ...c, busy: true, err: '' }))
        try {
          const r = await rpc('people.cardDraft', { name: cardMaker.name })
          setCardMaker((c) => ({ ...c, card: r.card, busy: false, evidence: r.evidence }))
          toast('已根据前文生成，检查一遍再保存')
        } catch (e) {
          setCardMaker((c) => ({ ...c, busy: false, err: String(e.message || e) }))
        }
      }

      /** 写盘 */
      const saveCard = async () => {
        if (cardMaker === null) return
        setCardMaker((c) => ({ ...c, busy: true, err: '' }))
        try {
          await rpc('people.cardSave', { name: cardMaker.name, card: cardMaker.card })
          toast('已建卡：' + String(cardMaker.name))
          setCardMaker(null)
          await load()
        } catch (e) {
          setCardMaker((c) => ({ ...c, busy: false, err: String(e.message || e) }))
        }
      }

      /** 让模型猜某一个字段 */
      const guessField = async (field) => {
        if (cardMaker === null) return
        setGuessBusy(field)
        try {
          const cur = cardMaker.card[field]
          const r = await rpc('people.fieldGuess', {
            name: cardMaker.name,
            field,
            current: typeof cur === 'string' ? cur : '',
          })
          setCardMaker((c) => (c === null ? c : { ...c, card: { ...c.card, [field]: r.value } }))
          toast(field + ' → ' + String(r.value))
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setGuessBusy('')
        }
      }

      /** 改一个字段 */
      const setCardField = (k, v) => {
        setCardMaker((c) => (c === null ? c : { ...c, card: { ...c.card, [k]: v } }))
      }

      /** 给所有缺头部的总结补结构化头（只补头，不重写正文） */
      const fillHeads = async () => {
        const m = await rpc('summary.headsMissing')
        if (m.missing.length === 0) {
          toast('所有总结都有索引头了')
          return
        }
        if (!window.confirm('有 ' + String(m.missing.length) + ' 章总结缺索引头。\n\n会调 ' + String(m.missing.length) + ' 次模型，只补头部、不改正文。继续？')) return
        setHeadBusy(true)
        let done = 0
        for (const it of m.missing) {
          try {
            const r = await rpc('summary.fillHead', { chapter: it.chapter })
            if (r.skipped !== true) done += 1
          } catch (e) {
            toast('第' + String(it.chapter) + '章失败：' + String(e.message || e))
          }
        }
        setHeadBusy(false)
        toast('已补 ' + String(done) + ' 章索引头')
        await load()
      }

      if (loading) return React.createElement(Empty, null, '正在分析全书…这要读完所有章节，可能要几秒')
      if (data === null) return React.createElement(Empty, null, '分析失败')

      const tensions = data.tensions || []
      const issues = data.issues || []
      const debts = data.debts || []
      const shown = showAllDebts ? debts : debts.slice(0, 20)
      const over = data.overdueCount === undefined ? 0 : data.overdueCount

      return React.createElement(
        'div',
        { style: { height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 } },
        // 张力曲线
        React.createElement(
          'div',
          { style: { ...cardStyle, padding: '12px 14px', flexShrink: 0 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
            React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '📈 张力曲线'),
            React.createElement(Chip, null, String(data.stats.chapters) + ' 章'),
            React.createElement(Chip, null, '剧情总结 ' + String(data.stats.summaries)),
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('button', { onClick: () => void load(), style: { ...btn(), padding: '2px 9px', fontSize: 11 } }, '↻ 重新分析'),
          ),
          React.createElement('div', { style: { fontSize: 10.5, color: C.sub, marginBottom: 8 } }, '按正文里的冲突信号估的，不是你的判断。虚线部分尤其只作参考。'),
          ...tensions.map((t) =>
            React.createElement(
              'div',
              { key: 't' + String(t.chapter), style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 } },
              React.createElement('span', { style: { width: 52, fontSize: 11, color: C.sub, textAlign: 'right', flexShrink: 0 } }, '第' + String(t.chapter) + '章'),
              React.createElement(
                'div',
                { style: { flex: 1, height: 14, background: 'rgba(0,0,0,0.05)', borderRadius: 4, overflow: 'hidden', position: 'relative' } },
                React.createElement('div', {
                  style: {
                    width: Math.round((t.value / 5) * 100) + '%',
                    height: '100%',
                    background: t.value >= 4 ? C.danger : t.value >= 3 ? C.warn : C.accent,
                    opacity: t.source === 'manual' ? 1 : 0.55,
                    borderRadius: 4,
                  },
                }),
              ),
              React.createElement('span', { style: { width: 30, fontSize: 11, color: C.sub, flexShrink: 0 } }, String(t.value) + ' 分'),
              React.createElement(Chip, { tone: t.source === 'manual' ? C.ok : undefined }, t.source === 'manual' ? '你标的' : '估'),
            ),
          ),
        ),
        // 结构问题
        React.createElement(
          'div',
          { style: { ...cardStyle, padding: '12px 14px', flexShrink: 0 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
            React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '🔍 结构问题'),
            React.createElement(Chip, null, String(issues.length) + ' 条'),
          ),
          issues.length === 0
            ? React.createElement('div', { style: { fontSize: 11.5, color: C.sub } }, '没查出结构问题')
            : React.createElement(
                'div',
                null,
                ...issues.map((x, i) =>
                  React.createElement(
                    'div',
                    {
                      key: 'i' + String(i),
                      style: {
                        padding: '7px 9px',
                        marginBottom: 5,
                        borderRadius: 8,
                        border: '1px solid ' + (x.level === 'warn' ? C.warn + '55' : C.border),
                        background: x.level === 'warn' ? 'rgba(255,159,10,0.07)' : 'transparent',
                      },
                    },
                    React.createElement(
                      'div',
                      { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 } },
                      React.createElement(Chip, { tone: x.level === 'warn' ? C.warn : C.sub }, x.level === 'warn' ? '⚠ 注意' : 'ℹ 提示'),
                      React.createElement('span', { style: { fontSize: 11.5, fontWeight: 600 } }, String(x.code)),
                      x.chapter === null || x.chapter === undefined ? null : React.createElement(Chip, null, '第' + String(x.chapter) + '章'),
                    ),
                    React.createElement('div', { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.8 } }, String(x.message)),
                  ),
                ),
              ),
        ),
        // 一致性检查
        cons === null
          ? null
          : React.createElement(
              'div',
              { style: { ...cardStyle, padding: '12px 14px', flexShrink: 0 } },
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '🔗 一致性检查'),
                React.createElement(Chip, { tone: cons.issues.length === 0 ? C.ok : C.warn }, cons.issues.length === 0 ? '没问题' : cons.issues.length + ' 条'),
                React.createElement('div', { style: { flex: 1 } }),
                headBusy
                  ? React.createElement(Chip, { tone: C.accent }, '正在补索引头…')
                  : React.createElement(
                      'button',
                      { onClick: () => void fillHeads(), disabled: headBusy, style: { ...btn(), padding: '2px 9px', fontSize: 11 } },
                      '✚ 补全索引头',
                    ),
              ),
              React.createElement(
                'div',
                { style: { fontSize: 10.5, color: C.sub, marginBottom: 8, lineHeight: 1.7 } },
                '纯规则检查，不调模型、不花钱：总结有没有漏记人、有没有人没卡、总结的索引头齐不齐。',
              ),
              cons.issues.length === 0
                ? React.createElement('div', { style: { fontSize: 11.5, color: C.ok } }, '没查出问题')
                : React.createElement(
                    'div',
                    null,
                    ...cons.issues.map((x, i) =>
                      React.createElement(
                        'div',
                        {
                          key: 'ci' + String(i),
                          style: {
                            padding: '7px 9px',
                            marginBottom: 5,
                            borderRadius: 8,
                            border: '1px solid ' + (x.level === 'warn' ? C.warn + '55' : C.border),
                            background: x.level === 'warn' ? 'rgba(255,159,10,0.07)' : 'transparent',
                          },
                        },
                        React.createElement(
                          'div',
                          { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 } },
                          React.createElement(Chip, { tone: x.level === 'warn' ? C.warn : C.sub }, x.level === 'warn' ? '⚠ 注意' : 'ℹ 提示'),
                          React.createElement('span', { style: { fontSize: 11.5, fontWeight: 600 } }, String(x.code)),
                        ),
                        React.createElement('div', { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.8 } }, String(x.message)),
                        // 无卡角色：每个名字挂一个「建卡」按钮
                        x.code === '无卡角色' && cons.names !== undefined && cons.names.length > 0
                          ? React.createElement(
                              'div',
                              { style: { display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 } },
                              ...cons.names.map((n) =>
                                React.createElement(
                                  'button',
                                  {
                                    key: 'mk-' + String(n),
                                    onClick: () => void openCardMaker(String(n)),
                                    style: { ...btn(), padding: '1px 9px', fontSize: 11, color: C.accent, borderColor: C.accent + '55' },
                                  },
                                  '✚ ' + String(n),
                                ),
                              ),
                            )
                          : null,
                        x.code === '未登场'
                          ? React.createElement(
                              'div',
                              { style: { fontSize: 10.5, color: C.sub, marginTop: 6 } },
                              '这些是规划里的后手，还没写到。不用急。',
                            )
                          : null,
                      ),
                    ),
                  ),
            ),
        // 建卡弹窗
        cardMaker === null
          ? null
          : React.createElement(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 1200,
                  background: 'rgba(0,0,0,0.45)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 20,
                },
                onClick: () => setCardMaker(null),
              },
              React.createElement(
                'div',
                {
                  onClick: (e) => e.stopPropagation(),
                  style: {
                    width: 'min(620px, 100%)',
                    maxHeight: '82vh',
                    overflow: 'auto',
                    background: C.bg,
                    color: C.text,
                    borderRadius: 14,
                    border: '1px solid ' + C.border,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
                  },
                },
                // 标题
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid ' + C.border } },
                  React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '给「' + String(cardMaker.name) + '」建卡'),
                  React.createElement('div', { style: { flex: 1 } }),
                  React.createElement('button', { onClick: () => setCardMaker(null), style: { ...btn(), padding: '2px 9px', fontSize: 11 } }, '关闭'),
                ),
                // 内容
                React.createElement(
                  'div',
                  { style: { padding: '12px 14px' } },
                  React.createElement(
                    'div',
                    { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.8, marginBottom: 10 } },
                    '这个人只在前文出现过，没有设定。可以手动填，也可以让模型读完他出场的段落再生成——生成后能改。',
                  ),
                  React.createElement(
                    'button',
                    { onClick: () => void genCard(), disabled: cardMaker.busy, style: { ...btn('primary'), marginBottom: 12 } },
                    cardMaker.busy ? '模型在读前文…' : '✨ 分析前文生成',
                  ),
                  cardMaker.evidence === undefined
                    ? null
                    : React.createElement(
                        'div',
                        { style: { fontSize: 10.5, color: C.sub, marginBottom: 10 } },
                        '读了第 ' + cardMaker.evidence.chapters.join('、') + ' 章的 ' + String(cardMaker.evidence.paragraphs) + ' 段，大纲 ' + String(cardMaker.evidence.outlineHits) + ' 处',
                      ),
                  cardMaker.err === ''
                    ? null
                    : React.createElement('div', { style: { fontSize: 11.5, color: C.danger, marginBottom: 10, lineHeight: 1.7 } }, cardMaker.err),
                  // 字段：按这张卡实际有的 key 渲染，不预设任何题材专属字段
                  ...Object.keys(cardMaker.card).map((k) => {
                    const long = /备注|说明|描述|外形|外貌|背景|关系|其他/u.test(k)
                    const val = cardMaker.card[k]
                    const text = typeof val === 'string' ? val : JSON.stringify(val)
                    return React.createElement(
                      'div',
                      { key: 'cf-' + k, style: { marginBottom: 9 } },
                      React.createElement(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 } },
                        React.createElement('span', { style: { fontSize: 11, color: C.sub } }, k),
                        React.createElement(
                          'button',
                          {
                            onClick: () => void guessField(k),
                            disabled: guessBusy !== '',
                            title: '让模型按前文猜一个值',
                            style: {
                              border: '1px solid ' + C.accent + '55',
                              background: guessBusy === k ? C.accent : 'transparent',
                              color: guessBusy === k ? '#fff' : C.accent,
                              borderRadius: 5,
                              fontSize: 10,
                              lineHeight: 1,
                              padding: '2px 5px',
                              cursor: guessBusy !== '' ? 'default' : 'pointer',
                            },
                          },
                          guessBusy === k ? '…' : '✨',
                        ),
                        Object.keys(cardMaker.card).length > 1 && k !== '姓名'
                          ? React.createElement(
                              'button',
                              {
                                onClick: () => {
                                  const next = { ...cardMaker.card }
                                  delete next[k]
                                  setCardMaker((c) => (c === null ? c : { ...c, card: next }))
                                },
                                style: { border: 'none', background: 'transparent', color: C.sub, fontSize: 10, cursor: 'pointer', padding: 0 },
                                title: '删掉这个字段',
                              },
                              '✕',
                            )
                          : null,
                      ),
                      long
                        ? React.createElement('textarea', {
                            value: text,
                            onChange: (e) => setCardField(k, e.target.value),
                            style: { ...inputStyle, width: '100%', minHeight: 90, resize: 'vertical', lineHeight: 1.8, fontFamily: 'inherit' },
                          })
                        : React.createElement('input', {
                            value: text,
                            onChange: (e) => setCardField(k, e.target.value),
                            style: { ...inputStyle, width: '100%' },
                          }),
                    )
                  }),
                  React.createElement(
                    'button',
                    {
                      onClick: () => {
                        const n = window.prompt('新字段叫什么？（例如：职业、年龄、门派、可疑之处）')
                        if (n === null || n.trim() === '') return
                        setCardField(n.trim(), '')
                      },
                      style: { ...btn(), padding: '2px 10px', fontSize: 11, marginBottom: 4 },
                    },
                    '＋ 添加字段',
                  ),
                ),
                // 底部
                React.createElement(
                  'div',
                  { style: { display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid ' + C.border } },
                  React.createElement('div', { style: { flex: 1, fontSize: 10.5, color: C.sub } }, '保存后写进 人物/' + String(cardMaker.name) + '.json'),
                  React.createElement(
                    'button',
                    { onClick: () => void saveCard(), disabled: cardMaker.busy, style: btn('primary') },
                    cardMaker.busy ? '保存中…' : '保存这张卡',
                  ),
                ),
              ),
            ),
        // 别称建议
        aliasSug === null || aliasSug.candidates.length === 0
          ? null
          : React.createElement(
              'div',
              { style: { ...cardStyle, padding: '12px 14px', flexShrink: 0 } },
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '👤 别称识别'),
                React.createElement(Chip, { tone: C.accent }, aliasSug.candidates.length + ' 个候选'),
                React.createElement('div', { style: { flex: 1 } }),
                aliasBusy ? React.createElement(Chip, { tone: C.accent }, '写入中…') : null,
              ),
              React.createElement(
                'div',
                { style: { fontSize: 10.5, color: C.sub, marginBottom: 8, lineHeight: 1.7 } },
                '从正文里猜出来的称呼。采纳后，写作包与一致性检查都会把「' + '李哥' + '」当成「李满」。标「冲突」的是同一个称呼命中多人，选一个。',
              ),
              ...aliasSug.candidates.slice(0, 20).map((c, i) =>
                React.createElement(
                  'div',
                  {
                    key: 'al' + String(i),
                    style: {
                      padding: '6px 9px',
                      marginBottom: 4,
                      borderRadius: 6,
                      border: '1px solid ' + (c.suggested === true ? C.ok + '55' : c.conflict === true ? C.warn + '55' : C.border),
                      background: c.suggested === true ? 'rgba(52,199,89,0.06)' : c.conflict === true ? 'rgba(255,159,10,0.06)' : 'transparent',
                    },
                  },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
                    React.createElement(
                      Chip,
                      { tone: c.suggested === true ? C.ok : c.conflict === true ? C.warn : undefined },
                      c.suggested === true ? '✓ 建议选它' : c.conflict === true ? '⚠ 说不准是谁' : c.hits + ' 次',
                    ),
                    React.createElement('span', { style: { fontSize: 12 } }, String(c.name) + ' ← 「' + String(c.alias) + '」'),
                    c.conflict === true ? React.createElement('span', { style: { fontSize: 10, color: C.sub } }, '(可能是 ' + String(c.owners.join(' / ')) + ')') : null,
                    React.createElement('div', { style: { flex: 1 } }),
                    React.createElement(
                      'button',
                      { onClick: () => void adoptAlias(c), disabled: aliasBusy, style: { ...btn(), padding: '1px 8px', fontSize: 10.5, color: C.accent, borderColor: C.accent + '55' } },
                      '采纳',
                    ),
                  ),
                  // 冲突项把上下文摊开，作者自己看是谁在叫谁
                  c.conflict !== true || c.contexts === undefined || c.contexts.length === 0
                    ? null
                    : React.createElement(
                        'div',
                        { style: { marginTop: 4, paddingLeft: 4 } },
                        c.guess === undefined || c.guess === null
                          ? null
                          : React.createElement(
                              'div',
                              { style: { fontSize: 10, color: c.suggested === true ? C.ok : C.sub, marginBottom: 2 } },
                              '上下文里常一起出现的是「' + String(c.guess) + '」，倾向指他。',
                            ),
                        ...c.contexts.slice(0, 2).map((ctx, k) =>
                          React.createElement(
                            'div',
                            { key: 'ctx' + String(k), style: { fontSize: 10, color: C.sub, lineHeight: 1.7, marginTop: 2 } },
                            '第' + String(ctx.chapter) + '章 …' + String(ctx.before) + '【' + String(ctx.alias) + '】' + String(ctx.after) + '…' +
                              (ctx.nearNames.length === 0 ? '' : '　附近：' + ctx.nearNames.join('、')),
                          ),
                        ),
                      ),
                ),
              ),
            ),
        // 伏笔清单
        React.createElement(
          'div',
          { style: { ...cardStyle, padding: '12px 14px', flexShrink: 0 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '🪝 伏笔清单'),
            React.createElement(Chip, { tone: over > 0 ? C.warn : C.ok }, String(over) + ' 条未收'),
            React.createElement(Chip, null, '共 ' + String(debts.length) + ' 条'),
            React.createElement('div', { style: { flex: 1 } }),
            debts.length > 20
              ? React.createElement('button', { onClick: () => setShowAllDebts(!showAllDebts), style: { ...btn(), padding: '2px 9px', fontSize: 11 } }, showAllDebts ? '只看前 20 条' : '显示全部 ' + String(debts.length) + ' 条')
              : null,
          ),
          React.createElement(
            'div',
            { style: { fontSize: 10.5, color: C.sub, marginBottom: 8, lineHeight: 1.7 } },
            '按大纲里「埋 / 收」两栏的名字配对的。名字换了叫法就配不上，所以这里既有真漏收，也有解析噪音——宁可多报，你自己筛。',
          ),
          debts.length === 0
            ? React.createElement('div', { style: { fontSize: 11.5, color: C.sub } }, '大纲里没读到「埋」和「收」')
            : React.createElement(
                'div',
                null,
                ...shown.map((d, i) =>
                  React.createElement(
                    'div',
                    {
                      key: 'd' + String(i),
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '5px 9px',
                        marginBottom: 3,
                        borderRadius: 6,
                        border: '1px solid ' + (d.overdue === true ? C.warn + '44' : C.border),
                        background: d.overdue === true ? 'rgba(255,159,10,0.05)' : 'transparent',
                      },
                    },
                    React.createElement(Chip, { tone: d.paidChapter === null || d.paidChapter === undefined ? (d.overdue === true ? C.warn : C.sub) : C.ok }, d.paidChapter === null || d.paidChapter === undefined ? '未收' : '已收'),
                    React.createElement('span', { style: { flex: 1, minWidth: 0, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(d.name)),
                    React.createElement('span', { style: { fontSize: 10.5, color: C.sub, flexShrink: 0 } },
                      '第' + String(d.plantedChapter) + '章埋' +
                      (d.paidChapter === null || d.paidChapter === undefined ? (d.overdue === true ? ' · 欠 ' + String(d.openChapters) + ' 章' : '') : ' · 第' + String(d.paidChapter) + '章收')),
                  ),
                ),
                debts.length > shown.length
                  ? React.createElement('div', { style: { fontSize: 10.5, color: C.sub, marginTop: 6 } }, '还有 ' + String(debts.length - shown.length) + ' 条没显示')
                  : null,
              ),
        ),
      )
    }

    // ══════════════════════════════════════════════════════════
    // 设定页
    // ══════════════════════════════════════════════════════════
    function FilesPage({ toast }) {
      const [items, setItems] = useState([])
      const [others, setOthers] = useState([])
      const [loading, setLoading] = useState(true)
      const [picked, setPicked] = useState(null)
      // 哪些多文件项展开着（角色卡 / 剧情总结 / 其他）
      const [open, setOpen] = useState({})
      // 新建文件 / 智能归档
      const [createBox, setCreateBox] = useState(null) // { dir, name, text }
      const [archiveBox, setArchiveBox] = useState(null) // { text, busy, result }
      const [refreshKey, setRefreshKey] = useState(0)
      // 点了哪个「缺失」的项：右边直接给添加界面
      const [missingKey, setMissingKey] = useState('')
      // 扫描识别结果
      const [scanBox, setScanBox] = useState(null)

      useEffect(() => {
        void (async () => {
          setLoading(true)
          try {
            const d = await rpc('files.checklist')
            setItems(d.items || [])
            setOthers(d.others || [])
          } catch (e) {
            toast(String(e.message || e))
          } finally {
            setLoading(false)
          }
        })()
      }, [toast, refreshKey])

      const reload = () => setRefreshKey((k) => k + 1)

      // 顶栏刷新时也重读文件清单
      useEffect(() => {
        const h = () => setRefreshKey((k) => k + 1)
        window.addEventListener('novel-studio:refresh', h)
        return () => window.removeEventListener('novel-studio:refresh', h)
      }, [])

      /** 当前打开的文件有没有未保存的改动 */
      const fileDirty = picked !== null && picked.editing === true && picked.text !== picked.before

      const openFile = async (path, name) => {
        // 上一个文件还没保存就先问一句
        if (fileDirty) {
          const ok = window.confirm('「' + String(picked.name) + '」的修改还没保存，确定要换一个文件吗？')
          if (!ok) return
        }
        try {
          const d = await rpc('file.read', { path })
          setPicked({ name: d.name, text: d.text, before: d.text, chars: d.chars, path: d.path, editing: false })
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      /** 保存当前文件的修改 */
      const saveFile = async () => {
        if (picked === null) return
        try {
          const d = await rpc('file.save', { path: picked.path, text: picked.text })
          toast('已保存 ' + String(d.rel) + '（' + String(d.chars) + ' 字），原文件备份在 备份/' )
          setPicked({ ...picked, before: picked.text, editing: false, chars: d.chars })
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      /** 扫描文件夹，让模型认领文件归属 */
      const doScan = async () => {
        setScanBox({ busy: true, list: [] })
        try {
          const d = await rpc('files.scan')
          setScanBox({ busy: false, list: d.assignments || [], scanned: d.scanned || 0, model: d.model || '' })
        } catch (e) {
          setScanBox(null)
          toast(String(e.message || e))
        }
      }

      const applyScan = async () => {
        if (scanBox === null || scanBox.list.length === 0) return
        try {
          const d = await rpc('files.bind', { assignments: scanBox.list })
          toast('已认领 ' + String(d.saved) + ' 个文件')
          setScanBox(null)
          reload()
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      /** 手动新建一个文件 */
      const doCreate = async () => {
        if (createBox === null) return
        const name = String(createBox.name || '').trim()
        if (name === '') {
          toast('要填文件名')
          return
        }
        const rel = createBox.dir === '' ? name : createBox.dir + '/' + name
        try {
          const d = await rpc('file.create', { path: rel, text: createBox.text || '' })
          toast('已新建 ' + String(d.rel))
          setCreateBox(null)
          reload()
          void openFile(d.path, name)
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      /** 让模型判断该归到哪儿 */
      const doClassify = async () => {
        if (archiveBox === null) return
        if (String(archiveBox.text || '').trim() === '') {
          toast('先把内容贴进来')
          return
        }
        setArchiveBox({ ...archiveBox, busy: true, result: null })
        try {
          const d = await rpc('file.classify', { text: archiveBox.text })
          setArchiveBox({ ...archiveBox, busy: false, result: d })
        } catch (e) {
          setArchiveBox({ ...archiveBox, busy: false })
          toast(String(e.message || e))
        }
      }

      /** 确认归档 */
      const doApplyArchive = async () => {
        if (archiveBox === null || archiveBox.result === null) return
        const r = archiveBox.result
        const text = String(archiveBox.text || '')
        try {
          if (r.mode === 'create') {
            const target = r.target.endsWith('/') ? r.target + (r.note || '新文件.md') : r.target
            const d = await rpc('file.create', { path: target, text })
            toast('已新建 ' + String(d.rel))
          } else {
            const d = await rpc('file.append', { path: r.target, text })
            toast('已追加到 ' + String(d.rel) + '（+' + String(d.addedChars) + ' 字）')
          }
          setArchiveBox(null)
          reload()
        } catch (e) {
          toast(String(e.message || e))
        }
      }

      const toggle = (key) => setOpen({ ...open, [key]: open[key] !== true })
      const isOpen = (key) => open[key] === true

      // 一行：清单项本身
      const row = (key, label, right, opts) => {
        const o = opts === undefined ? {} : opts
        return React.createElement(
          'div',
          {
            key: 'r' + key,
            onClick: o.onClick,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: o.sub === true ? '5px 10px 5px 26px' : '7px 10px',
              borderBottom: '1px solid ' + C.border,
              cursor: 'pointer',
              background: o.active === true ? 'rgba(10,132,255,0.09)' : 'transparent',
            },
          },
          o.sub === true
            ? null
            : React.createElement('span', { style: { fontSize: 10, color: C.sub, width: 10, flexShrink: 0 } }, o.expandable === true ? (o.expanded === true ? '▾' : '▸') : ''),
          o.dotGlyph === undefined ? null : React.createElement('span', { style: { fontSize: 12, color: o.dotColor, flexShrink: 0, fontWeight: 700 } }, o.dotGlyph),
          React.createElement('span', { style: { fontSize: o.sub === true ? 11 : 12, fontWeight: o.sub === true ? 400 : 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: o.sub === true ? C.sub : 'inherit' } }, label),
          React.createElement('span', { style: { fontSize: 10, color: C.sub, flexShrink: 0 } }, right === undefined ? '' : right),
        )
      }

      const left = React.createElement(
        'div',
        { style: { width: 300, flexShrink: 0, overflow: 'auto', ...cardStyle } },
        loading
          ? React.createElement('div', { style: { padding: 14, color: C.sub, fontSize: 12 } }, '读取中…')
          : React.createElement(
              'div',
              null,
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: C.rail, borderBottom: '1px solid ' + C.border } },
                React.createElement('span', { style: { fontSize: 11, fontWeight: 600, color: C.sub, flex: 1 } }, '设定文件'),
                React.createElement(
                  'button',
                  { onClick: () => setCreateBox({ dir: '', name: '', text: '' }), style: { ...btn(), padding: '1px 7px', fontSize: 10.5 }, title: '手动新建一个文件' },
                  '＋ 新建',
                ),
                React.createElement(
                  'button',
                  { onClick: () => setArchiveBox({ text: '', busy: false, result: null }), style: { ...btn(), padding: '1px 7px', fontSize: 10.5 }, title: '贴一段内容，让模型判断该放进哪个文件' },
                  '🪄 归档',
                ),
                React.createElement(
                  'button',
                  { onClick: () => void doScan(), disabled: scanBox !== null, style: { ...btn(), padding: '1px 7px', fontSize: 10.5 }, title: '扫描文件夹，让模型认领文件归属' },
                  '🔍 识别',
                ),
                React.createElement(
                  'button',
                  {
                    onClick: () => {
                      reload()
                      toast('已重新读取设定文件清单')
                    },
                    style: { ...btn(), padding: '1px 7px', fontSize: 10.5 },
                    title: '重新读取磁盘——外部改过文件后点这个',
                  },
                  '↻',
                ),
              ),
              ...items.map((it) => {
                const missing = it.exists !== true
                // 所有项都统一成「点一项 → 展开 → 点文件打开」，单文件也一样，
                // 这样行为一致，而且一个类别绑了多个文件时也能全列出来。
                const rows = [
                  row(it.key, it.key, it.path, {
                    dotColor: missing ? C.danger : C.ok,
                    dotGlyph: missing ? '✗' : '✓',
                    expandable: it.files.length > 0,
                    expanded: isOpen(it.key),
                    onClick: () => {
                      if (missing) {
                        setPicked(null)
                        setMissingKey(it.key)
                        return
                      }
                      toggle(it.key)
                    },
                  }),
                ]
                // 展开后列出具体的文件
                if (isOpen(it.key)) {
                  if (it.files.length === 0) {
                    rows.push(
                      row(it.key + '|__empty__', '（这里还没有文件）', '', {
                        sub: true,
                        dotGlyph: '✗',
                        dotColor: C.danger,
                        onClick: () => {
                          setPicked(null)
                          setMissingKey(it.key)
                        },
                      }),
                    )
                  }
                  for (const f of it.files) {
                    rows.push(
                      row(it.key + '|' + f.name, f.name.replace(/\.(json|md)$/iu, ''), '', {
                        sub: true,
                        active: picked !== null && picked.name === f.name,
                        onClick: () => void openFile(f.path, f.name),
                      }),
                    )
                  }
                }
                return rows
              }),
              // 其他文件
              others.length === 0
                ? null
                : React.createElement(
                    'div',
                    null,
                    row('__others__', '其他文件', String(others.length) + ' 个', {
                      expandable: true,
                      expanded: isOpen('__others__'),
                      onClick: () => toggle('__others__'),
                    }),
                    ...(isOpen('__others__')
                      ? others.map((f) =>
                          row('__o__' + f.name, f.name, f.scope, {
                            sub: true,
                            active: picked !== null && picked.name === f.name,
                            onClick: () => void openFile(f.path, f.name),
                          }),
                        )
                      : []),
                  ),
            ),
      )

      // 点了一个缺文件的项：右边直接给「添加」界面
      const missingItem = missingKey === '' ? null : items.find((x) => x.key === missingKey) || null

      const missingUI =
        missingItem === null
          ? null
          : React.createElement(
              'div',
              { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, ...cardStyle, overflow: 'hidden' } },
              React.createElement(
                'div',
                { style: { padding: '8px 12px', borderBottom: '1px solid ' + C.border, fontSize: 12.5, fontWeight: 600, color: C.danger, flexShrink: 0 } },
                '✗ 还没有「' + missingItem.key + '」',
              ),
              React.createElement(
                'div',
                { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '28px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 } },
                React.createElement('div', { style: { fontSize: 34, opacity: 0.25 } }, '📄'),
                React.createElement('div', { style: { fontSize: 12.5, color: C.sub, textAlign: 'center', lineHeight: 1.9, maxWidth: 420 } },
                  '这本书还没有「' + missingItem.key + '」。',
                  React.createElement('br'),
                  String(missingItem.note),
                  React.createElement('br'),
                  React.createElement('span', { style: { fontSize: 11, opacity: 0.8 } }, '默认路径：' + String(missingItem.path)),
                ),
                React.createElement(
                  'div',
                  { style: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' } },
                  React.createElement(
                    'button',
                    {
                      onClick: () => {
                        const dir = missingItem.path.includes('/') ? missingItem.path.slice(0, missingItem.path.lastIndexOf('/')) : ''
                        const name = missingItem.path.split('/').pop() || '新文件.md'
                        setCreateBox({ dir, name, text: '' })
                      },
                      style: btn('primary'),
                    },
                    '＋ 现在建一个',
                  ),
                  React.createElement(
                    'button',
                    {
                      onClick: () => void doScan(),
                      style: btn(),
                    },
                    '🔍 让模型去文件夹里找',
                  ),
                  React.createElement(
                    'button',
                    { onClick: () => setMissingKey(''), style: btn() },
                    '知道了',
                  ),
                ),
              ),
            )

      const right = React.createElement(
        'div',
        { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, ...cardStyle, overflow: 'hidden' } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 11px', fontSize: 11, color: C.sub, borderBottom: '1px solid ' + C.border, flexShrink: 0, flexWrap: 'wrap' } },
          React.createElement('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-all' } },
            picked === null ? '点左边任意一项打开' : String(picked.name) + '　' + fmtChars(picked.text.replace(/\s/gu, '').length),
          ),
          picked === null
            ? null
            : picked.editing === true
              ? React.createElement(
                  React.Fragment,
                  null,
                  picked.text !== picked.before ? React.createElement(Chip, { tone: C.warn }, '未保存') : null,
                  React.createElement('button', { onClick: () => setPicked({ ...picked, text: picked.before, editing: false }), style: { ...btn(), padding: '2px 9px', fontSize: 11 } }, '取消'),
                  React.createElement('button', { onClick: () => void saveFile(), disabled: picked.text === picked.before, style: { ...btn('primary'), padding: '2px 9px', fontSize: 11 } }, '保存'),
                )
              : React.createElement(
                  React.Fragment,
                  null,
                  React.createElement('button', { onClick: () => setPicked({ ...picked, editing: true }), style: { ...btn(), padding: '2px 9px', fontSize: 11 } }, '✎ 编辑'),
                  React.createElement('button', {
                    onClick: () => {
                      setPicked(null)
                    },
                    style: { ...btn(), padding: '2px 9px', fontSize: 11 },
                  }, '关闭'),
                ),
        ),
        picked !== null && picked.editing === true
          ? React.createElement('textarea', {
              value: picked.text,
              onChange: (e) => setPicked({ ...picked, text: e.target.value }),
              style: {
                flex: 1,
                minHeight: 0,
                resize: 'none',
                border: 'none',
                outline: 'none',
                padding: '10px 14px',
                fontSize: 12.5,
                lineHeight: 1.9,
                background: 'transparent',
                color: C.text,
                fontFamily: 'inherit',
              },
            })
          : React.createElement(
              'div',
              { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 14px', fontSize: 12.5, lineHeight: 1.9, whiteSpace: 'pre-wrap' } },
              picked === null ? '' : picked.text,
            ),
      )

      // 扫描识别结果弹层
      const scanUI =
        scanBox === null
          ? null
          : React.createElement(
              'div',
              {
                style: { position: 'fixed', inset: 0, zIndex: 956, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
                onMouseDown: (e) => {
                  if (e.target === e.currentTarget && scanBox.busy !== true) setScanBox(null)
                },
              },
              React.createElement(
                'div',
                { style: { width: 'min(600px, 100%)', maxHeight: '100%', background: C.card, color: C.text, border: '1px solid ' + C.border, borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
                React.createElement(
                  'div',
                  { style: { padding: '10px 14px', borderBottom: '1px solid ' + C.border, fontSize: 13.5, fontWeight: 700, flexShrink: 0 } },
                  '🔍 自动识别',
                ),
                React.createElement(
                  'div',
                  { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: 14 } },
                  scanBox.busy === true
                    ? React.createElement('div', { style: { color: C.sub, fontSize: 12.5, padding: '20px 0', textAlign: 'center' } }, '正在扫描文件夹，让模型认领…')
                    : scanBox.list.length === 0
                      ? React.createElement('div', { style: { color: C.sub, fontSize: 12.5, lineHeight: 1.9 } },
                          '没有找到需要认领的文件。',
                          React.createElement('br'),
                          scanBox.scanned === 0 ? '（所有文件都已经归位了）' : '（扫了 ' + String(scanBox.scanned) + ' 个文件，模型一个都没认出来）',
                        )
                      : React.createElement(
                          'div',
                          null,
                          React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginBottom: 8 } }, '扫了 ' + String(scanBox.scanned) + ' 个文件，认出 ' + String(scanBox.list.length) + ' 个：'),
                          ...scanBox.list.map((a, i) =>
                            React.createElement(
                              'div',
                              { key: 'sc' + String(i), style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', marginBottom: 4, border: '1px solid ' + C.border, borderRadius: 8 } },
                              React.createElement(Chip, { tone: C.accent }, String(a.key)),
                              React.createElement('span', { style: { flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(a.name)),
                              React.createElement('span', { style: { fontSize: 10.5, color: C.sub } }, String(a.scope)),
                            ),
                          ),
                        ),
                ),
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid ' + C.border, flexShrink: 0 } },
                  React.createElement('span', { style: { flex: 1, fontSize: 10.5, color: C.sub } }, scanBox.model === undefined || scanBox.model === '' ? '' : '模型：' + String(scanBox.model)),
                  React.createElement('button', { onClick: () => setScanBox(null), disabled: scanBox.busy === true, style: btn() }, '关闭'),
                  scanBox.busy === true || scanBox.list.length === 0
                    ? null
                    : React.createElement('button', { onClick: () => void applyScan(), style: btn('primary') }, '按这个认领'),
                ),
              ),
            )

      // 新建文件弹层
      const createUI =
        createBox === null
          ? null
          : React.createElement(
              'div',
              {
                style: { position: 'fixed', inset: 0, zIndex: 955, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
                onMouseDown: (e) => {
                  if (e.target === e.currentTarget) setCreateBox(null)
                },
              },
              React.createElement(
                'div',
                { style: { width: 'min(560px, 100%)', background: C.card, color: C.text, border: '1px solid ' + C.border, borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.35)', padding: 16 } },
                React.createElement('div', { style: { fontSize: 13.5, fontWeight: 700, marginBottom: 10 } }, '＋ 新建文件'),
                React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginBottom: 6 } }, '放在哪儿'),
                React.createElement(
                  'select',
                  {
                    value: createBox.dir,
                    onChange: (e) => setCreateBox({ ...createBox, dir: e.target.value }),
                    style: { ...inputStyle, width: '100%', marginBottom: 10 },
                  },
                  React.createElement('option', { value: '' }, '根目录'),
                  React.createElement('option', { value: '设定' }, '设定/'),
                  React.createElement('option', { value: '人物' }, '人物/（角色卡）'),
                  React.createElement('option', { value: '剧情' }, '剧情/'),
                ),
                React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginBottom: 6 } }, '文件名（带后缀 .md / .json / .txt）'),
                React.createElement('input', {
                  value: createBox.name,
                  onChange: (e) => setCreateBox({ ...createBox, name: e.target.value }),
                  placeholder: '例如：势力表.md',
                  style: { ...inputStyle, width: '100%', marginBottom: 10 },
                }),
                React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginBottom: 6 } }, '初始内容（可留空，建完再写）'),
                React.createElement('textarea', {
                  value: createBox.text,
                  onChange: (e) => setCreateBox({ ...createBox, text: e.target.value }),
                  rows: 8,
                  style: { ...areaStyle, fontSize: 12 },
                }),
                React.createElement(
                  'div',
                  { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 } },
                  React.createElement('button', { onClick: () => setCreateBox(null), style: btn() }, '取消'),
                  React.createElement('button', { onClick: () => void doCreate(), style: btn('primary') }, '创建'),
                ),
              ),
            )

      // 智能归档弹层
      const archiveUI =
        archiveBox === null
          ? null
          : React.createElement(
              'div',
              {
                style: { position: 'fixed', inset: 0, zIndex: 955, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
                onMouseDown: (e) => {
                  if (e.target === e.currentTarget && archiveBox.busy !== true) setArchiveBox(null)
                },
              },
              React.createElement(
                'div',
                { style: { width: 'min(620px, 100%)', maxHeight: '100%', background: C.card, color: C.text, border: '1px solid ' + C.border, borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
                React.createElement(
                  'div',
                  { style: { padding: '10px 14px', borderBottom: '1px solid ' + C.border, fontSize: 13.5, fontWeight: 700, flexShrink: 0 } },
                  '🪄 智能归档',
                ),
                React.createElement(
                  'div',
                  { style: { padding: 14, overflow: 'auto' } },
                  React.createElement('div', { style: { fontSize: 11.5, color: C.sub, marginBottom: 6 } }, '把一段内容贴进来（比如从别处复制的人物设定、世界观、某章梗概），模型会判断它该放进哪个文件。'),
                  React.createElement('textarea', {
                    value: archiveBox.text,
                    onChange: (e) => setArchiveBox({ ...archiveBox, text: e.target.value }),
                    rows: 10,
                    placeholder: '粘贴内容…',
                    style: { ...areaStyle, fontSize: 12 },
                  }),
                  archiveBox.result === null
                    ? null
                    : React.createElement(
                        'div',
                        { style: { marginTop: 12, border: '1px solid ' + C.accent + '55', borderRadius: 8, padding: '10px 12px', background: 'rgba(10,132,255,0.06)' } },
                        React.createElement(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' } },
                          React.createElement(Chip, { tone: C.accent }, archiveBox.result.mode === 'create' ? '新建' : '追加'),
                          React.createElement('span', { style: { fontSize: 12.5, fontWeight: 600 } }, String(archiveBox.result.target) + (archiveBox.result.mode === 'create' && archiveBox.result.note ? archiveBox.result.note : '')),
                        ),
                        React.createElement('div', { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.8 } }, String(archiveBox.result.reason)),
                      ),
                ),
                React.createElement(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid ' + C.border, flexShrink: 0 } },
                  React.createElement('span', { style: { flex: 1, fontSize: 10.5, color: C.sub } }, archiveBox.result === null ? '' : '模型：' + String(archiveBox.result.model)),
                  React.createElement('button', { onClick: () => setArchiveBox(null), disabled: archiveBox.busy === true, style: btn() }, '取消'),
                  archiveBox.result === null
                    ? React.createElement('button', { onClick: () => void doClassify(), disabled: archiveBox.busy === true, style: btn('primary') }, archiveBox.busy === true ? '判断中…' : '让模型判断')
                    : React.createElement('button', { onClick: () => void doApplyArchive(), style: btn('primary') }, '按这个归档'),
                ),
              ),
            )

      return React.createElement(
        'div',
        { style: { display: 'flex', height: '100%', minHeight: 0, gap: 12 } },
        left,
        missingUI === null ? right : missingUI,
        createUI,
        archiveUI,
        scanUI,
      )
    }


    // ══════════════════════════════════════════════════════════
    // 设置页
    // ══════════════════════════════════════════════════════════
    /**
     * 目录选择器。
     *
     * 两个诉求：
     * 1. 不要手打路径——能点就点
     * 2. 打开就把「像作品的地方」列出来，不用一层层翻
     *
     * 顶部是扫描到的候选（dir.discover），下面是当前位置的子文件夹（dir.list）。
     */
    function DirPicker({ kind, initial, onPick, onClose, toast }) {
      const [list, setList] = useState(null)
      const [found, setFound] = useState(null)
      const [scanning, setScanning] = useState(true)
      const [loading, setLoading] = useState(true)
      const [picked, setPicked] = useState(String(initial || ''))
      const [err, setErr] = useState('')

      const load = async (target) => {
        setLoading(true)
        setErr('')
        try {
          const d = await rpc('dir.list', { path: target })
          setList(d)
          if (target === '' || target === undefined) setPicked(d.path)
        } catch (e) {
          setErr(String(e.message || e))
          setList(null)
        } finally {
          setLoading(false)
        }
      }

      const discover = async (from) => {
        setScanning(true)
        try {
          const d = await rpc('dir.discover', { from: from === undefined ? '' : from })
          setFound(d)
        } catch {
          setFound(null)
        } finally {
          setScanning(false)
        }
      }

      useEffect(() => {
        void discover()
        void load(String(initial || ''))
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const wanted = kind === 'candidates' ? 'candidates' : 'project'
      const wantedLabel = wanted === 'candidates' ? '候选目录' : '作品根'

      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 9px',
        borderRadius: 7,
        border: '1px solid ' + C.border,
        marginBottom: 4,
      }

      /**
       * 一行扫描结果。
       *
       * 选「候选目录」时扫出来的几乎都是作品根——不能因为类型不匹配就不给点，
       * 应该点了一下子推导到它下面的 候选稿/第N章。
       */
      const hitRow = (it) => {
        const direct = it.kind === wanted
        const canDerive = wanted === 'candidates' && it.kind === 'project'
        const canUse = direct || canDerive
        const use = () => {
          void (async () => {
            if (direct) {
              setPicked(String(it.path))
              onPick(String(it.path))
              onClose()
              return
            }
            // 作品根 → 推导它的候选目录
            try {
              const r = await rpc('dir.candidateOf', { projectDir: String(it.path) })
              setPicked(String(r.candidateDir))
              onPick(String(r.candidateDir))
              onClose()
              if (typeof toast === 'function') {
                toast('已选「' + String(r.name) + '」的候选目录：第' + String(r.nextChapter) + '章')
              }
            } catch (e) {
              if (typeof toast === 'function') toast(String(e.message || e))
            }
          })()
        }
        return React.createElement(
          'div',
          { key: 'hit-' + String(it.path), style: { ...rowStyle, background: 'rgba(10,132,255,0.05)' } },
          React.createElement('span', { style: { fontSize: 13 } }, it.kind === 'project' ? '📚' : '🗂'),
          React.createElement(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(it.name)),
            React.createElement('div', { style: { fontSize: 10, color: C.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(it.path)),
          ),
          it.current === true ? React.createElement(Chip, { tone: C.accent }, '当前在写') : null,
          React.createElement(Chip, { tone: it.kind === wanted ? C.ok : C.sub }, String(it.kindLabel)),
          canUse
            ? React.createElement(
                'button',
                {
                  onClick: use,
                  style: { ...btn(), padding: '1px 9px', fontSize: 10.5, color: C.accent, borderColor: C.accent + '55' },
                },
                direct ? '用这个' : '用它的候选目录',
              )
            : null,
        )
      }

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 1200,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          },
          onClick: () => onClose(),
        },
        React.createElement(
          'div',
          {
            onClick: (e) => e.stopPropagation(),
            style: {
              width: 'min(720px, 100%)',
              maxHeight: '82vh',
              display: 'flex',
              flexDirection: 'column',
              background: C.bg,
              color: C.fg,
              borderRadius: 14,
              border: '1px solid ' + C.border,
              boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
              overflow: 'hidden',
            },
          },
          // 标题栏
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid ' + C.border } },
            React.createElement('div', { style: { fontSize: 13, fontWeight: 700 } }, '选择' + wantedLabel),
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('button', { onClick: () => onClose(), style: { ...btn(), padding: '2px 9px', fontSize: 11 } }, '关闭'),
          ),
          // 内容
          React.createElement(
            'div',
            { style: { padding: '10px 14px', overflowY: 'auto', flex: 1 } },

            // 扫描结果
            React.createElement('div', { style: { fontSize: 11, fontWeight: 700, color: C.sub, marginBottom: 6 } }, '扫描到的位置' + (scanning ? '（正在扫…）' : found !== null && found.found !== undefined ? '（' + found.found.length + ' 个）' : '')),
            found === null || found.found === undefined || found.found.length === 0
              ? React.createElement('div', { style: { fontSize: 11, color: C.sub, marginBottom: 10 } }, scanning ? '识别中…' : '这附近没找到作品，往下翻目录，或直接在下面选。')
              : React.createElement(
                  'div',
                  { style: { marginBottom: 10 } },
                  ...found.found.map((it) => hitRow(it)),
                ),

            // 当前目录
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 6px' } },
              React.createElement('div', { style: { fontSize: 11, fontWeight: 700, color: C.sub } }, '当前位置'),
              React.createElement('div', { style: { flex: 1 } }),
              list !== null && list.parent !== undefined && list.parent !== ''
                ? React.createElement('button', { onClick: () => void load(list.parent), style: { ...btn(), padding: '1px 8px', fontSize: 10.5 } }, '↑ 上一级')
                : null,
            ),
            list !== null && list.path !== undefined
              ? React.createElement('div', { style: { fontSize: 10.5, color: C.sub, marginBottom: 6, wordBreak: 'break-all' } }, String(list.path))
              : null,

            err !== ''
              ? React.createElement('div', { style: { fontSize: 11, color: C.danger || C.warn, marginBottom: 8 } }, err)
              : null,

            loading
              ? React.createElement('div', { style: { fontSize: 11, color: C.sub, padding: 12 } }, '读取中…')
              : list === null
                ? null
                : list.items.length === 0
                  ? React.createElement('div', { style: { fontSize: 11, color: C.sub, padding: '6px 0' } }, '这层没有子文件夹')
                  : React.createElement(
                      'div',
                      null,
                      ...list.items.map((it) =>
                        React.createElement(
                          'div',
                          { key: 'd-' + String(it.path), style: rowStyle },
                          React.createElement('span', { style: { fontSize: 13 } }, '📁'),
                          React.createElement(
                            'div',
                            {
                              onClick: () => void load(String(it.path)),
                              style: { flex: 1, minWidth: 0, cursor: 'pointer' },
                            },
                            React.createElement(
                              'div',
                              { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } },
                              React.createElement('span', null, String(it.name)),
                              it.kindLabel === '' ? null : React.createElement(Chip, { tone: it.kind === wanted ? C.ok : C.sub }, String(it.kindLabel)),
                            ),
                          ),
                          React.createElement('button', { onClick: () => void load(String(it.path)), style: { ...btn(), padding: '1px 8px', fontSize: 10.5 } }, '进入'),
                          React.createElement(
                            'button',
                            {
                              onClick: () => {
                                setPicked(String(it.path))
                                onPick(String(it.path))
                                onClose()
                              },
                              style: { ...btn(), padding: '1px 8px', fontSize: 10.5, color: C.accent, borderColor: C.accent + '55' },
                            },
                            '选它',
                          ),
                        ),
                      ),
                    ),
          ),
          // 底部
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: '1px solid ' + C.border } },
            React.createElement('div', { style: { flex: 1, fontSize: 10.5, color: C.sub, wordBreak: 'break-all' } }, picked === '' ? '还没选' : picked),
            list !== null && list.path !== undefined
              ? React.createElement(
                  'button',
                  {
                    onClick: () => {
                      onPick(String(list.path))
                      onClose()
                    },
                    style: { ...btn('primary') },
                  },
                  '用当前目录',
                )
              : null,
          ),
        ),
      )
    }

    function SettingsPage({ state, onRefresh, toast }) {
      const cfg = state !== null && state.config !== undefined ? state.config : {}
      const [candidateDir, setCandidateDir] = useState(String(cfg.candidateDir || ''))
      const [projectDir, setProjectDir] = useState(String(cfg.projectDir || ''))
      const [busy, setBusy] = useState(false)
      // 目录选择器：null = 关着，'candidates' / 'project' = 正在选哪一项
      const [picker, setPicker] = useState(null)
      const [fontSize, setFontSize] = useState(Number(cfg.readFontSize === undefined ? 13.5 : cfg.readFontSize))
      const [uiScale, setUiScale] = useState(Number(cfg.uiScale === undefined ? 1 : cfg.uiScale))

      useEffect(() => {
        setCandidateDir(String(cfg.candidateDir || ''))
        setProjectDir(String(cfg.projectDir || ''))
        setFontSize(Number(cfg.readFontSize === undefined ? 13.5 : cfg.readFontSize))
        setUiScale(Number(cfg.uiScale === undefined ? 1 : cfg.uiScale))
      }, [cfg.candidateDir, cfg.projectDir, cfg.readFontSize, cfg.uiScale])

      const save = async () => {
        setBusy(true)
        try {
          await rpc('config.save', { candidateDir, projectDir })
          toast('配置已保存')
          onRefresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      return React.createElement(
        'div',
        { style: { maxWidth: 640 } },
        picker === null
          ? null
          : React.createElement(DirPicker, {
              kind: picker,
              initial: picker === 'candidates' ? candidateDir : projectDir,
              onPick: (v) => {
                if (picker === 'candidates') setCandidateDir(v)
                else setProjectDir(v)
              },
              onClose: () => setPicker(null),
              toast,
            }),
        React.createElement(
          'div',
          { style: { ...cardStyle, padding: 14 } },
          React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 4 } }, '候选目录'),
          React.createElement('div', { style: { fontSize: 11, color: C.sub, marginBottom: 7, lineHeight: 1.7 } }, '抽卡时候选稿落在哪儿。形如：…\\作品\\.dsh-novel-craft\\候选稿\\第12章'),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8 } },
            React.createElement('input', { value: candidateDir, onChange: (e) => setCandidateDir(e.target.value), style: { ...inputStyle, flex: 1, minWidth: 0 } }),
            React.createElement('button', { onClick: () => setPicker('candidates'), style: { ...btn(), whiteSpace: 'nowrap' } }, '📂 浏览'),
          ),
          React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600, margin: '14px 0 4px' } }, '作品根（可选）'),
          React.createElement('div', { style: { fontSize: 11, color: C.sub, marginBottom: 7, lineHeight: 1.7 } }, '留空则从候选目录自动向上探测。填了就以它为准。'),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8 } },
            React.createElement('input', { value: projectDir, onChange: (e) => setProjectDir(e.target.value), style: { ...inputStyle, flex: 1, minWidth: 0 } }),
            React.createElement('button', { onClick: () => setPicker('project'), style: { ...btn(), whiteSpace: 'nowrap' } }, '📂 浏览'),
            projectDir !== ''
              ? React.createElement('button', { onClick: () => setProjectDir(''), style: { ...btn(), whiteSpace: 'nowrap' } }, '清空')
              : null,
          ),
          React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600, margin: '16px 0 4px' } }, '阅读字号'),
          React.createElement('div', { style: { fontSize: 11, color: C.sub, marginBottom: 7, lineHeight: 1.7 } }, '候选稿段落和正文编辑区的字大小。觉得字小就调大。'),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            ...[
              { v: 12, label: '小' },
              { v: 13.5, label: '标准' },
              { v: 15, label: '大' },
              { v: 17, label: '特大' },
              { v: 19, label: '巨大' },
            ].map((o) =>
              React.createElement(
                'button',
                {
                  key: 'fs' + String(o.v),
                  onClick: () => {
                    setFontSize(o.v)
                    void (async () => {
                      try {
                        await rpc('config.save', { readFontSize: o.v })
                        toast('阅读字号已设为' + o.label)
                        onRefresh()
                      } catch (e) {
                        toast(String(e.message || e))
                      }
                    })()
                  },
                  style: {
                    ...btn(),
                    padding: '4px 12px',
                    fontSize: 12,
                    background: Math.abs(fontSize - o.v) < 0.1 ? C.accent : 'transparent',
                    color: Math.abs(fontSize - o.v) < 0.1 ? '#fff' : C.text,
                    borderColor: Math.abs(fontSize - o.v) < 0.1 ? C.accent : C.border,
                  },
                },
                o.label,
              ),
            ),
          ),
          React.createElement(
            'div',
            { style: { fontSize: 11, color: C.sub, marginTop: 6 } },
            '预览：' + '这一段的字会按 ' + String(fontSize) + 'px 显示。',
          ),
          React.createElement('div', { style: { fontSize: 12.5, fontWeight: 600, margin: '16px 0 4px' } }, '界面缩放'),
          React.createElement('div', { style: { fontSize: 11, color: C.sub, marginBottom: 7, lineHeight: 1.7 } }, '整体放大导航、说明文字。改完立即生效，不用重启。'),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            ...[
              { v: 1, label: '标准' },
              { v: 1.1, label: '110%' },
              { v: 1.2, label: '120%' },
              { v: 1.35, label: '135%' },
            ].map((o) =>
              React.createElement(
                'button',
                {
                  key: 'us' + String(o.v),
                  onClick: () => {
                    void (async () => {
                      try {
                        await rpc('config.save', { uiScale: o.v })
                        toast('界面缩放已设为 ' + o.label)
                        onRefresh()
                      } catch (e) {
                        toast(String(e.message || e))
                      }
                    })()
                  },
                  style: {
                    ...btn(),
                    padding: '4px 12px',
                    fontSize: 12,
                    background: Math.abs(uiScale - o.v) < 0.01 ? C.accent : 'transparent',
                    color: Math.abs(uiScale - o.v) < 0.01 ? '#fff' : C.text,
                    borderColor: Math.abs(uiScale - o.v) < 0.01 ? C.accent : C.border,
                  },
                },
                o.label,
              ),
            ),
          ),
          React.createElement('button', { onClick: () => void save(), disabled: busy, style: { ...btn('primary'), marginTop: 14 } }, busy ? '保存中…' : '保存配置'),
        ),
        state !== null && state.project !== null
          ? React.createElement(
              'div',
              { style: { ...cardStyle, padding: 14, marginTop: 12, fontSize: 11.5, color: C.sub, lineHeight: 1.9, wordBreak: 'break-all' } },
              '当前作品：' + String(state.project.name),
              React.createElement('br'),
              '作品根：' + String(state.project.dir),
              React.createElement('br'),
              '识别方式：' + (state.project.source === 'setting' ? '设置里手填' : '自动探测'),
            )
          : null,
      )
    }

    // ══════════════════════════════════════════════════════════
    // 外壳
    // ══════════════════════════════════════════════════════════
    const PAGES = [
      { id: 'chapters', icon: '📖', label: '章节' },
      { id: 'drafts', icon: '✍️', label: '候选稿' },
      { id: 'trash', icon: '🗑', label: '回收站' },
      { id: 'plot', icon: '📈', label: '情节' },
      { id: 'profile', icon: '📋', label: '偏好档案' },
      { id: 'files', icon: '📁', label: '设定' },
      { id: 'settings', icon: '⚙️', label: '设置' },
    ]

    function Studio() {
      const [page, setPage] = useState('chapters')
      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(true)
      const [notice, setNotice] = useState('')
      const [bookPicker, setBookPicker] = useState(false)
      const [refreshing, setRefreshing] = useState(false)
      // 切页面时的未保存确认（就地弹，不依赖外层浮层）
      const [pageAsk, setPageAsk] = useState(null)

      /** 切页前先问：有脏就挂起，没有就直接切 */
      const gotoPage = (id) => {
        if (id === page) return
        const dirty = typeof leaveFlow.dirtyOnes === 'function' ? leaveFlow.dirtyOnes() : []
        if (dirty.length === 0) {
          setPage(id)
          return
        }
        setPageAsk({ target: id, dirty })
      }

      const refresh = useCallback(async () => {
        try {
          const d = await rpc('state', { force: true })
          setState(d)
        } catch (e) {
          setNotice(String(e.message || e))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void refresh()
      }, [refresh])

      const toast = useCallback((msg) => {
        setNotice(msg)
        window.setTimeout(() => setNotice(''), 6000)
      }, [])

      const title = state !== null && state.project !== null ? state.project.name : '未识别作品'
      const totals = state !== null && state.totals !== undefined ? state.totals : { chapters: 0, chars: 0 }

      // 界面缩放：用 zoom 整体放大导航与小字
      const scale = state !== null && state.config !== undefined && state.config.uiScale !== undefined ? Number(state.config.uiScale) : 1
      const safeScale = Number.isFinite(scale) && scale >= 0.8 && scale <= 1.6 ? scale : 1

      return React.createElement(
        'div',
        { style: { display: 'flex', height: '100%', minHeight: 0, background: C.bg, color: C.text, fontSize: 13, zoom: safeScale } },
        bookPicker
          ? React.createElement(DirPicker, {
              kind: 'project',
              initial: state !== null && state.project !== null ? String(state.project.dir) : '',
              onPick: (v) => {
                void (async () => {
                  try {
                    const r = await rpc('book.switch', { projectDir: v })
                    toast('已切到「' + String(r.name) + '」，下一章候选目录：第' + String(r.nextChapter) + '章')
                    await refresh()
                  } catch (e) {
                    toast(String(e.message || e))
                  }
                })()
              },
              onClose: () => setBookPicker(false),
              toast,
            })
          : null,
        // 左导航
        React.createElement(
          'div',
          { style: { width: 168, flexShrink: 0, borderRight: '1px solid ' + C.border, background: C.card, display: 'flex', flexDirection: 'column', padding: '10px 8px' } },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, padding: '4px 8px 12px' } }, '📚 小说工坊'),
          ...PAGES.map((p) =>
            React.createElement(
              'button',
              {
                key: p.id,
                onClick: () => gotoPage(p.id),
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: page === p.id ? 'rgba(10,132,255,0.12)' : 'transparent',
                  color: page === p.id ? C.accent : C.text,
                  fontWeight: page === p.id ? 600 : 400,
                  borderRadius: 8,
                  padding: '7px 9px',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  marginBottom: 2,
                },
              },
              React.createElement('span', null, p.icon),
              React.createElement('span', null, p.label),
            ),
          ),
          React.createElement('div', { style: { flex: 1 } }),
          React.createElement('div', { style: { fontSize: 10.5, color: C.sub, padding: '6px 8px', lineHeight: 1.7 } }, String(totals.chapters) + ' 章 · ' + fmtChars(totals.chars)),
          React.createElement('div', { style: { fontSize: 9.5, color: C.sub, padding: '0 8px 4px', opacity: 0.6 } }, 'v2.15.4'),
          React.createElement('button', { onClick: () => leaveFlow.request(() => setOpen(false)), style: { ...btn('ghost'), fontSize: 11.5, textAlign: 'left' } }, '← 收起工作台'),
        ),
        // 右内容
        React.createElement(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: '1px solid ' + C.border, background: C.card, flexShrink: 0 } },
            React.createElement(
              'button',
              {
                onClick: () => setBookPicker(true),
                title: '换一本 / 查看识别到的作品',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  border: '1px solid ' + C.border,
                  background: C.bg,
                  color: C.text,
                  borderRadius: 8,
                  padding: '3px 9px',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                  maxWidth: 320,
                },
              },
              React.createElement('span', null, '📚'),
              React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
              React.createElement('span', { style: { fontSize: 10, color: C.sub } }, '▾'),
            ),
            React.createElement('span', { style: { fontSize: 11, color: C.sub } }, String(totals.chapters) + ' 章 · ' + fmtChars(totals.chars)),
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement(
              'button',
              {
                onClick: () => {
                  void (async () => {
                    setRefreshing(true)
                    try {
                      await refresh()
                      // 当前页若有自己独立的数据源（回收站、设定…），也让它重读
                      window.dispatchEvent(new CustomEvent('novel-studio:refresh'))
                      toast('已重新读取：' + String(totals.chapters) + ' 章 · ' + fmtChars(totals.chars))
                    } finally {
                      setRefreshing(false)
                    }
                  })()
                },
                disabled: refreshing,
                style: { ...btn(), padding: '3px 10px', fontSize: 11.5 },
              },
              refreshing ? '↻ 读取中…' : '↻ 刷新',
            ),
          ),
          notice === '' ? null : React.createElement('div', { style: { padding: '7px 16px', fontSize: 11.5, color: C.sub, borderBottom: '1px solid ' + C.border, background: 'rgba(10,132,255,0.06)' } }, notice),
          React.createElement(
            'div',
            { style: { flex: 1, minHeight: 0, padding: 14, overflow: 'hidden' } },
            loading
              ? React.createElement(Empty, null, '读取中…')
              : page === 'chapters'
                ? React.createElement(ChapterPage, { state, onRefresh: refresh, toast })
                : page === 'drafts'
                  ? React.createElement(DraftsPage, { state, onRefresh: refresh, toast })
                  : page === 'trash'
                    ? React.createElement(TrashPage, { toast })
                    : page === 'plot'
                      ? React.createElement(PlotPage, { toast })
                    : page === 'profile'
                      ? React.createElement(ProfilePage, { state, onRefresh: refresh, toast })
                      : page === 'files'
                        ? React.createElement(FilesPage, { toast })
                        : React.createElement(SettingsPage, { state, onRefresh: refresh, toast }),
          ),
        ),
        // 切页面的未保存确认（就地渲染，不依赖外层浮层）
        pageAsk === null
          ? null
          : React.createElement(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 960,
                  background: 'rgba(0,0,0,0.38)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 20,
                },
              },
              React.createElement(
                'div',
                {
                  style: {
                    width: 'min(420px, 100%)',
                    background: C.card,
                    color: C.text,
                    border: '1px solid ' + C.border,
                    borderRadius: 12,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
                    padding: 18,
                  },
                },
                React.createElement('div', { style: { fontSize: 13.5, fontWeight: 700, marginBottom: 6 } }, '⚠️ 还有没保存的修改'),
                ...pageAsk.dirty.map((g) =>
                  React.createElement('div', { key: g.id, style: { fontSize: 12, color: C.sub, lineHeight: 1.9 } }, '· ' + String(g.label)),
                ),
                React.createElement(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' } },
                  React.createElement('button', { onClick: () => setPageAsk(null), style: btn() }, '取消'),
                  React.createElement(
                    'button',
                    {
                      onClick: () => {
                        const target = pageAsk.target
                        setPageAsk(null)
                        setPage(target)
                      },
                      style: btn('danger'),
                    },
                    '不保存',
                  ),
                  React.createElement(
                    'button',
                    {
                      onClick: async () => {
                        const ask = pageAsk
                        setPageAsk(null)
                        for (const g of ask.dirty) {
                          try {
                            await g.save()
                          } catch {
                            // 单处保存失败不挡切换
                          }
                        }
                        setPage(ask.target)
                      },
                      style: btn('primary'),
                    },
                    '保存并离开',
                  ),
                ),
              ),
            ),
      )
    }

    /** 侧栏入口按钮 */
    /**
     * 侧栏底部的入口。
     *
     * 这个插槽是「设置旁边的可选动作」，水平排一排，同槽还有别的插件。
     * 所以不能设 width:100%——那会独占整行，把别人挤成竖排。
     * 也不能让文字换行，用 nowrap + flexShrink:0 保持自己的宽度。
     * 侧栏收成 56px 轨道时（wide=false）只留图标。
     */
    function Entry(props) {
      const open = useOpen()
      const wide = props !== null && props !== undefined && props.wide === false ? false : true
      return React.createElement(
        'button',
        {
          onClick: () => setOpen(!open),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            border: 'none',
            background: open ? 'rgba(10,132,255,0.12)' : 'transparent',
            color: open ? C.accent : 'inherit',
            padding: '6px 7px',
            borderRadius: 7,
            fontSize: 12,
            lineHeight: 1.2,
            cursor: 'pointer',
          },
          title: '小说工坊（点一下打开）',
        },
        React.createElement('span', { style: { fontSize: 13 } }, '📚'),
        wide ? React.createElement('span', null, '小说工坊') : null,
      )
    }

    exports.inject = ['slots']
    exports.apply = function (ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'novel-studio', order: 9, label: () => '小说工坊' }, () => React.createElement(Entry)),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'novel-studio-panel', order: 25 }, () =>
          React.createElement(Shell, null),
        ),
      )
    }

    /** 浮层外壳：只管开合，内容交给 Studio */
    function Shell() {
      const open = useOpen()
      const [pending, setPending] = useState(leaveFlow.pending)

      useEffect(() => leaveFlow.subscribe(() => setPending(leaveFlow.pending)), [])

      if (!open) return null

      // 未保存确认层：保存 / 不保存 / 取消
      const ask =
        pending === null
          ? null
          : React.createElement(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 980,
                  background: 'rgba(0,0,0,0.45)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 20,
                },
              },
              React.createElement(
                'div',
                {
                  style: {
                    width: 'min(420px, 100%)',
                    background: C.card,
                    color: C.text,
                    border: '1px solid ' + C.border,
                    borderRadius: 12,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
                    padding: 18,
                  },
                },
                React.createElement('div', { style: { fontSize: 13.5, fontWeight: 700, marginBottom: 8 } }, '⚠️ 还有没保存的修改'),
                ...pending.dirty.map((g) =>
                  React.createElement('div', { key: g.id, style: { fontSize: 12.5, color: C.sub, lineHeight: 1.9 } }, '· ' + String(g.label)),
                ),
                React.createElement(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' } },
                  React.createElement('button', { onClick: () => leaveFlow.cancel(), style: btn() }, '取消'),
                  React.createElement('button', { onClick: () => leaveFlow.resolveSave(false), style: btn('danger') }, '不保存'),
                  React.createElement('button', { onClick: () => leaveFlow.resolveSave(true), style: btn('primary') }, '保存并离开'),
                ),
              ),
            )
      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 900,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          },
          onMouseDown: (e) => {
            if (e.target === e.currentTarget) leaveFlow.request(() => setOpen(false))
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 'min(1240px, 100%)',
              height: 'min(820px, 100%)',
              background: C.card,
              color: C.text,
              borderRadius: 14,
              border: '1px solid ' + C.border,
              boxShadow: '0 24px 70px rgba(0,0,0,0.35)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            },
          },
          React.createElement(Studio),
          ask,
        ),
      )
    }

    // 注意：不能写 module.exports = {...}——那会把上面挂在 exports 上的
    // apply / inject 一起覆盖掉，宿主就再也拿不到注册入口（表现为「没有 UI 入口」）。
    exports.Entry = Entry
    exports.Studio = Studio
    exports.Shell = Shell
    exports.rpc = rpc

    return module.exports
  },
})
