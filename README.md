# 小说工坊 · dsh-novel-workbench

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的一页式小说创作工作台。

写长篇最难受的不是写不出来，是**写着写着人物崩了、伏笔丢了、前文忘了**。这个插件不替你写，它做的是把「写这一章需要知道的一切」整理好端到你面前。

---

## 它解决什么

**旧做法**：每次写新章，翻七八个文件——大纲、人物卡、前几章正文、伏笔清单——翻完上下文也乱了。

**这个插件**：点一下「开新章」，自动挑出这一章用得上的材料，拼成一份写作包：

```
近 10 章剧情总结    全文，一条不删
10 章之前           每章一句话
例外：本章要出场的配角在前面出现过 → 把那几章升级成全文
本章大纲            前后各 1 章给全字段
更远的大纲          只在提到相关人物时，带「目标 + 埋」
上一章正文          只取结尾 1400 字（接话用）
人物卡              名字（含别称）出现才读
```

**每次都会告诉你读了什么、省了多少**，不是黑盒。

---

## 安装

**两步都要做**：先装包，再把它挂进 profile 的组合层。只做第一步，包装好了但界面里什么都没有。

### 1. 装包

**推荐走 npm**（不碰 GitHub，国内配个镜像就能装）：

```bash
dsh plugin --profile web add dsh-novel-workbench
```

连不上 npm、或者想跟最新提交走，就改用 GitHub 源（装出来是同一个包）：

```bash
dsh plugin --profile web add github:ShanJun-pro-max/dsh-novel-workbench
```

**`--profile web` 必须写在 `add` 前面。** 新版 dsh 把 `--profile` 定为必填项，而且它属于 `plugin` 这一层——写成 `dsh plugin add --profile web …` 会报：

```
error: required option '--profile <name>' not specified
```

因为 `add` 之后的内容会原样转给 pnpm，dsh 自己没读到 `--profile`。

profile 名怎么选：用 `dsh web` 就是 `web`；用桌面版客户端就是 `desktop`。不确定就看 `~/.dsh/profiles/` 下有哪些目录。

### 2. 挂进组合

```bash
node ./node_modules/dsh-novel-workbench/install.mjs web
```

脚本只做一件事：把 `dsh-novel-workbench` 写进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`。手动做也行——在那个文件里找到：

```json
"dsh": { "profile": { "bundles": [ "...", "这里加一行 dsh-novel-workbench" ] } }
```

（这一步别省。`dsh plugin add` 只把包装进 `node_modules`，组合层是独立的另一份配置，插件自带的 `cordis.patch.yml` 靠它才会被应用。）

### 3. 重启

**重启 dsh web**，侧栏底部出现「📚 小说工坊」，点开看左侧导航最底部的版本号（最新是 `v2.21.2`）。

本地开发：

```bash
dsh plugin --profile web add file:/path/to/dsh-novel-workbench
node /path/to/dsh-novel-workbench/install.mjs web
```

---

## 更新

```bash
# 1. 让它重新解析到最新版（npm 装的就拉最新版本，github 装的就拉最新提交）
dsh plugin --profile web update dsh-novel-workbench

# 2. 重启 dsh web
```

开工作台看左下角版本号有没有变。（`dsh.profile.bundles` 里的那一行只需加一次，更新时不用再动。）

> ⚠️ **重复执行 `add` 是没用的。** 对 `github:` 来源，pnpm 会把解析到的**提交**写进 `pnpm-lock.yaml`；
> 第二次 `add` 看到 spec 没变，会说 `Lockfile is up to date, resolution step is skipped` /
> `Already up to date`，然后原样跳过——包还是旧的。必须用 `update` 才会重新解析。

### 装了插件市场的话

市场会自己判断有没有新版本：它读你仓库 `package.json` 的 `version`，和本地装的比。**远端版本号更大 → 已安装列表里出现「更新」按钮，点一下就装。**

所以发版时务必改版本号（本项目用 `version.ps1`）；只推提交不改版本号的话，市场只会标一句「有新提交（未发版）」而不给更新按钮 —— 这是市场的规则，不是插件的问题。

**还是旧版本？** 先把依赖清掉再装：

```bash
# Windows
rmdir /s /q "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-novel-workbench"
dsh plugin --profile web update dsh-novel-workbench
```

从源码装的（`file:` 方式）更新更简单：

```bash
cd /path/to/dsh-novel-workbench
git pull
```

然后重启 dsh web。

---

## 快速开始

### 1. 准备作品目录

插件按约定找文件。最小结构：

```
你的小说/
├─ 大纲.md              ← 全书章节骨架
├─ 正文/
│  ├─ 第001章-标题.txt
│  └─ 第002章-标题.txt
└─ 剧情/
   ├─ 第1章 剧情总结.md
   └─ 第2章 剧情总结.md
```

**全部可选**，缺什么插件会标红提醒你补。推荐再放：

```
├─ 设定/
│  ├─ 立项.md
│  ├─ 世界观.md
│  ├─ 人物设定.md
│  ├─ _口径.md          ← 名字表、时间线、写作禁忌
│  └─ 道具与增益台账.md
└─ 人物/
   ├─ 陆铮.json
   └─ 萧烬.json
```

### 2. 配置

侧栏 → 小说工坊 → ⚙️ 设置：

| 字段 | 说明 |
| --- | --- |
| 候选目录 | 抽卡候选稿落点，如 `…/作品/.dsh-novel-studio/候选稿/第12章` |
| 作品根 | 留空则从候选目录向上自动探测 |
| 模型 | 留空用 dsh 当前默认模型 |

### 3. 开始用

- **章节** — 看全书进度，点标题编辑，点「📝 总结」一键生成剧情总结
- **候选稿** — 「✍️ 开新章」让模型给写作方向 → 写多篇候选 → 逐段 👍/👎 → 合稿定稿
- **情节** — 张力曲线、伏笔欠账、一致性检查、别称识别
- **偏好档案** — 标过的段落压成可复用的写作规律，按「类型」跨书继承
- **回收站** — 删掉的章节 / 候选稿 / 类型都能找回
- **设定** — 浏览、编辑、新建、归档所有设定文件

---

## 核心功能

### 开新章

```
① 这一章写什么   → 编辑本章设定（目标 / 禁止发生 / 出场人物 / 要求）
② 方向          → 模型给 3–16 个写法方向，勾选要写的
③ 写候选        → 一次一篇，看得见进度，可随时停
④ 完成          → 去候选稿逐段标 👍/👎
```

写稿时**不会跳页**，状态不会丢。

### 剧情总结带索引头

```markdown
---
chapter: 11
characters: [陆铮, 萧烬, 闫振军, 柯朗]
location: [城东老院子]
planted: [萧烬体质收不住, 闫振军单独留话]
paid: []
---

# 第11章 剧情总结

## 核心剧情点
- ...（正文照旧，怎么写都行）
```

**头上 6 行给机器查，下面照旧给你写。** 有了它才能查「李满在第几章退场」。

`characters` 用**规则**提取（扫正文里出现的已知角色名），不调模型——比模型准，而且免费。

### 别称识别

小说里没人一直叫全名。插件会扫出「李哥」「萧先生」这类称呼，并且：

- **共现分析**：抓每次出现的前后 50 字，看这段窗口里还出现了谁

```
「萧总」出现 3 次
  第4章 "小程。""萧总。""我给他那张卡"   附近：萧烬
  第4章 "稍等。""萧总，没有记录。"        附近：萧烬
                                → 推测：萧烬
```

- **同姓不排除**：「萧先生」可能是萧烬也可能是萧宗平，两个都列出来
- **你拍板**：机器只给依据，标 `✓ 建议选它` / `⚠ 说不准是谁`

采纳后写进角色卡 `"别称": ["李哥"]`，索引、一致性检查、写作包选人三处都认。

### 情节体检

| 检查 | 说明 |
| --- | --- |
| 张力曲线 | 按正文冲突信号估分，标出「中段塌陷」「全程平缓」 |
| 伏笔欠账 | 大纲里「埋 / 收」配对，找出该收没收的 |
| 一致性 | 总结漏记人、有卡没出场、总结缺索引头（**纯规则，不花钱**） |

### 偏好档案按类型继承

写完一本兽人小说，建个类型「兽人校园」。下本同类型的书绑同一个类型，**自动继承所有偏好规律**。

类型库在 `~/.dsh/novel-studio-types/`，跨书共用。删错能恢复。

---

## 数据存在哪

| 内容 | 位置 |
| --- | --- |
| 章节正文 | `<作品>/正文/` |
| 剧情总结 | `<作品>/剧情/` |
| 人物卡 | `<作品>/人物/*.json` |
| 候选稿 | `<作品>/.dsh-novel-studio/候选稿/第N章/` |
| 标注 | `<作品>/.dsh-novel-studio/候选稿/第N章/.dsh-novel-studio/marks.json` |
| 偏好档案 | `<作品>/.dsh-novel-studio/作者偏好档案.md` |
| 备份 | `<作品>/.dsh-novel-studio/备份/` |
| 类型库 | `~/.dsh/novel-studio-types/` |

**全部是普通文件**，随时能用编辑器打开、能用 Git 管理、能手动改。


---

## 安全设计

| 机制 | 说明 |
| --- | --- |
| 删除 | 一律先进回收站，可恢复；回收站里再「彻底删」才真删 |
| 覆盖 | 改正文 / 总结 / 设定文件前**自动备份**到 `.dsh-novel-studio/备份/` |
| 未保存 | 改正文没保存就切页面 / 关窗口，会弹确认 |
| 路径 | 只能读写作品目录内的 `.md` / `.txt` / `.json`，越界拒绝 |
| 接口 | 只接受本机回环请求 |

---

## 常见问题

**入口没出现？**
重启 dsh web。还不行就 `Ctrl + F5` 硬刷新（浏览器会缓存旧 bundle）。

**装的时候报 `error: required option '--profile <name>' not specified`？**
把 `--profile web` 挪到 `add` 前面：`dsh plugin --profile web add github:…`。
`--profile` 属于 `plugin` 这一层，写在 `add` 之后会被当成要转给 pnpm 的参数，dsh 自己读不到。

**装/更新时报 `ERR_PNPM_GIT_RESOLVE_FAILED`、`Connection was reset`？**
这一步是 pnpm 在跑 `git ls-remote` 解析仓库，和插件本身无关——机器连不上 github.com。三选一：

```bash
# 1) 先开代理（最常见）
# 2) 只给 git 配代理，端口换成你自己的
git config --global http.https://github.com.proxy http://127.0.0.1:7890

# 3) 有 SSH key 的话走 SSH 传输（pnpm 输出里推荐的那条）
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

同一屏里那句 `git-hosted plugins build on install via their prepare script` 是 dsh 的通用提示，
这个包没有 `prepare` 脚本，忽略即可。

**「这个 dsh 没挂 LLM 服务」？**
开新章、生成总结、识别别称这些要调模型。在设置里指定模型，或确认 dsh 已有默认模型。

**文件明明在，清单却标红？**
点那个 ✗，右边有三个选项：手动新建 / 让模型去文件夹里找 / 知道了。
找到后归属关系会记在 `.dsh-novel-studio/文件归属.json`，以后就认了。

**总结里的 HTML 注释是什么？**
`<!-- dsh-novel-craft:auto:begin -->` 那对，是提炼规律时标记自动生成区块用的。别删。

---

## 开发

```bash
# 语法检查
npm run check

# 装到本地 profile
dsh plugin --profile web add file:$(pwd)
```

结构：

```
lib/
├─ index.js            插件入口（注册唯一 RPC 端点 /novel-studio/api/）
├─ client.js           前端（宿主只加载这一个文件，不能拆）
├─ server/
│  ├─ api.js           74 个业务接口
│  ├─ context.js       路径约定、项目识别、配置读写
│  ├─ summary.js       总结提示词、头部解析、输出清洗
│  ├─ distill.js       提炼规律
│  └─ pack-assemble.js 写作包取材策略
└─ core/               纯逻辑（读文件、合稿、分章、情节分析）
```

**后端只有一个 HTTP 端点**，前端用 `{ a: '动作名' }` 分发。加功能只加一个方法。

改完代码**必须重启 dsh web** 才生效。

---

## 功能总览

完整的功能说明、设计思路、数据存放位置、已知限制，见 [功能总览.md](./功能总览.md)。

---

## 更新日志

每个版本改了什么，见 [CHANGELOG.md](./CHANGELOG.md)。

---

## License

MIT
