# dsh-open-artifacts

给 DSH 加一个动作：**直接打开某个对话的产物文件夹**。

不用再自己翻 —— 侧边栏会话行的「⋯」菜单和对话标题旁各有一个入口，
点了就去读这个对话的会话日志，算出「它到底往哪些目录写过文件」，然后用资源管理器打开。

> **Blender 产物根**：默认 `E:\AgentArtifacts\blender`（2026-10-16 起，**只收 Blender 建模产物**，
> 免得几十 MB 的 .blend 混在工作区的对话目录里）。其它对话产出照旧按工作区 `AGENTS.md`
> 放在 `<工作区>\<主题>\`。想换地方就设环境变量 `DSH_ARTIFACT_ROOT`。

> 起因：DSH 生态里已有的几个「打开文件夹」插件（dsh-open-workspace、dsh-open-folder、
> dsh-open-explorer、dsh-session-manager、dsh-workspace-menu）打开的都是**工作区根目录**，
> 没有任何「会话 → 产物目录」的映射。而同一个工作区下动辄几十个对话，
> 打开根目录等于没打开 —— 真正想要的是「**这个**对话的产物在哪」。

它还会在 DSH 启动后自己查一次 GitHub Releases：装了旧版本的人会在界面右下角看到一张更新提示卡片
（见下方「有新版本会提示你」）。

## 和现成做法比

| 方案 | 打开的位置 | 按会话区分 |
|---|---|---|
| dsh-open-workspace / dsh-open-folder / dsh-open-explorer | 工作区根目录 | ❌ 所有对话都一样 |
| dsh-reveal-files | 某一个产物文件所在的目录 | ⚠️ 得先点到具体文件 |
| **本插件** | **该对话真正产出过文件的目录** | ✅ 从会话日志算出来 |

## 它怎么知道产物在哪

DSH 的会话日志（`~/.dsh/sessions/<工作区编码>/<会话 id>/session.v4.jsonl.zstd`）里记着每一次工具调用。
本插件逐帧解压 zstd，然后：

1. 取日志首帧的 `{"type":"session",…,"cwd":…}` 作为这个对话的工作目录（比投影缓存可靠）；
2. 收集**成功**的写入类调用，两种事件都要扫：
   - `tool/call` —— 模型直接调 `write` / `edit` / `str_replace_editor`，失败看 `tool/result` 里的 `isError`；
   - `tool/ptc-dispatch` —— `run_code` 里调 `tools.write` / `tools.edit`。子进程里的调用**不会**产生
     `tool/call`，只有这一条事件，它自带 `isError`。
     （2026-10-15 补：漏掉它会让「整场都走 run_code」的对话被算成零产出 —— 点「产物」却提示「没有找到产物」。）
3. 再补上 `present` 登记过的交付物路径，同样是两种来源：PTC 里调用的看 `tool/ptc-dispatch` 的
   `files[].path`，顶层调用的看 `deliverables/presented` 事件；
4. 把这些路径按工作目录下的**顶层目录**归类。

所以结果是「这个对话真正写过东西的地方」，不是「工作区里有什么目录」。

工作区根目录下的散文件（`AGENTS.md`、`升级日志.md` 这类跨对话公用资产）会单独归类成一个提示项，
工作区之外的产出（比如这次顺手改的 `D:\ollama`）也会列出来、但标注「工作区之外」。

### 补充：外部程序写的产出（2026-10-16）

上面四步有个盲区：**产出不一定由 `write` 工具写出来**。Blender 的
`bpy.ops.wm.save_as_mainfile`、`run_code` 里 `node:fs` 的 `copyFileSync` ——
这些在日志里一条写入记录都没有，明明是磁盘上最实在的产物，第 2 步却看不见，
界面于是提示「没有找到产物」。本机第一次用 Blender 建模就栽在这上面。

2026-10-16 起补第 5 步：

5. 扫 **Blender 产物根**（默认 `E:\AgentArtifacts\blender`）下的顶层目录，把 mtime 落在
   `[会话开始 - 5min, 最后活动 + 5min]` 窗口内的列为候选，标注「Blender 产物（按时间推断…）」。
   根下每个子目录 = 一次建模对话（`mug`、`<下一个模型>`）。

> 这是**推断**，不是证据：同一时间窗里其它对话的目录也会被列进来。
> 所以它只用于展示与打开，**绝不进任何可删列表** —— 删错别人的产物是不可逆的。
> 想让它更准：把产物目录名起得跟对话主题一致，产出后立刻点一次确认。

## 行为

| 情况 | 表现 |
|---|---|
| 只有 1 个产物目录 | 直接开窗，不弹任何东西 |
| 有多个 | 弹一个小列表，每项显示目录名 + 产出了几个文件 + 完整路径 |
| 一个都没有 | 提示「没有找到产物」，并给「打开 Blender 产物目录」/「打开工作区根目录」两个兜底按钮 |
| 想新建一个 | 弹窗页脚有「新建产物目录」，输入名字后**在工作区下**建好并直接打开（预填从标题里抠出的候选名） |

## 产物目录守门

光有「打开」还不够 —— 产物得先**真的**待在各自的目录里。工作区里那条「一个对话一个产物目录」
的约定只写在 `AGENTS.md` 里，是一段文字，没有强制力，于是文件常常直接落在工作区根目录，
事后只能靠翻会话日志找回来。

2026-10-16 起，**Blender 建模产物**单独挪出了工作区（默认 `E:\AgentArtifacts\blender`）：
模型文件按 `<Blender 产物根>\<项目名>\` 分目录。

> ⚠️ 范围只管 Blender 建模。2026-10-16 曾把「所有对话产物」都改到工作区外的产物根，
> 当天按用户要求**回退**了：非 Blender 的产出照旧留在 `<工作区>\<主题>\`。

本插件挂 `tools/pre-execute`，只在一种情况下拦下写入：

> **往工作区根目录新建一个非 `.md` 文件。**

拦下时返回 `deny` 加一段 `reason`（指向工作区的产物目录约定），模型看到就知道该换个地方、
再把 `file_path` 改进去重试。（Blender 产物写在 `E:\AgentArtifacts\blender\` 下，
在工作区之外，这条守门本来就不拦。）
有意放行的情况：

- 子目录里的任何写入 —— 建目录这件事已经发生了
- 根目录的 `*.md` —— `AGENTS.md`、`升级日志.md`、`基建备忘.md` 这类**跨会话**公共文档
- 已经存在的文件 —— 改公共资产不算「这次对话的新产出」

`tools/pre-execute` 的 decision 里**没有**「改写参数」这种能力（`PreToolDecision` 只有
`allow` / `deny` / `cancel` / `ask`，`exec.arguments` 是只读的），所以只能「拒绝 + 说明」，
让模型自己重试 —— 也正因为如此，拦截条件收得很窄，免得住变成一个碍事的插件。

## 有新版本会提示你

插件在 DSH 启动后 3 秒去查一次 GitHub Releases，跟本地 `package.json` 里的版本号比大小，
有新版本就在界面右下角浮一张卡片：

- 显示「当前 0.3.1 → 最新 0.4.0」，点「更新说明」展开这条 Release 的正文（发布时的 `--notes`）；
- 「打开 Release 页面」跳到 GitHub；
- 「忽略这个版本」把版本号记进 `localStorage` —— 同一个版本不再打扰，下次发了更高的版本还会提示。

几个设计取舍：

- **只认 GitHub Releases**：这个包没有发布到 npm（`registry.npmjs.org/dsh-open-artifacts` 返回 404），
  Releases 是唯一权威来源；每次发布都建好 tag + Release，所以「最新 Release 的 tag」就是「最新版本号」。
- **缓存 6 小时**：`api.github.com` 未认证限额是 60 次/小时，而界面每次挂载都要问一次。
  检查结果（内存 + `~/.dsh/.cache/dsh-open-artifacts-update.json`）6 小时内有效，界面永远先读缓存；
  网络失败再退避 30 分钟，免得连点刷新把限额打光。
- **失败一律静默**：离线、代理挂了、被限流，什么都不弹、也不报错 —— 查更新失败不该打扰人。
- **检查放在 host 端**：浏览器直连 `api.github.com` 会被 CORS 挡住（该 API 不放开跨源），
  所以走 `GET /__open-artifacts/update`（默认吃缓存，`?force=1` 强制重查，同样只允许 127.0.0.1）。

## 安装

```bash
dsh plugin --profile desktop add github:wuuuuu123-32/dsh-open-artifacts
```

装完**必须重启 DSH**（新增的插槽项不会热加载）。

以后升级：在市场（dshmarket）插件页点「更新」，或重跑上面那条命令。装了旧版本时，
插件自己也会在右下角提示。

<details>
<summary>手动安装（不用 <code>dsh plugin</code> 时）</summary>

把本仓库放到任意目录，然后在 profile 里建链接并登记：

```bash
cd ~/.dsh/profiles/desktop
pnpm add /path/to/dsh-open-artifacts        # 或用 junction / symlink 指过去
```

`~/.dsh/profiles/desktop/package.json` 里要有：

```json
{
  "dependencies": { "dsh-open-artifacts": "link:D:/path/to/dsh-open-artifacts" },
  "dsh": { "profile": { "bundles": ["dsh-open-artifacts"] } }
}
```

❗ 改这个 JSON 时**不要写 BOM**（PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会加 BOM，
DSH 启动时 `JSON.parse` 直接抛 `SyntaxError: Unexpected token '﻿'`，表现为界面打不开）。
用 `[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))`。

</details>

## 实现要点

- **产出路径有两种来源，缺一不可**：`tool/call`（模型直调）和 `tool/ptc-dispatch`（`run_code` 里的嵌套调用）。
  PTC 模式下 DSH 只把整次 `run_code` 记成一条 `tool/call`，程序内部调用的 `tools.write` / `tools.edit` /
  `tools.present` 各留一条 `tool/ptc-dispatch`，带着 `name` / `arguments` / `isError` —— 信息够用。
- **用的是正式插槽，不是 DOM 注入**：`sidebar.workspaces.session.menu.item`（会话行 ⋯ 菜单）和
  `conversation.session.header.actions`（标题旁动作）。这两个插槽在 DSH `0.2.0-rc.2` 上都直接给
  `sessionId`，不需要去猜 DOM 结构。现存的那几个同类插件都是 2026-08/09 写的，
  靠 DOM 注入会话菜单，在 `0.2.0-rc.2` 上有失效风险。
- **打开目录走自建 host 路由**（`POST /__open-artifacts/open`），不用内置 `host.openPath()`：
  后者在 Windows 上走 `powershell Invoke-Item`，对**中文路径静默失败** —— 报告成功却不开窗。
  这里直接 `spawn('explorer.exe', [dir])`，Node 在 Windows 下用宽字符 API 传参，中文路径不需要额外编码。
- **只允许打开「这个会话产出过的目录」**：open 路由拿着 `sessionId` 重算一遍白名单，
  路径不在里面就 `403`，所以它不会变成一个任意路径开窗器。
- **更新检查是纯函数模块**（`lib/update.mjs`）：版本比较、Release 折算、缓存与退避都不碰 DSH 的 API，
  `fetchImpl` / `now` / `cacheFile` 全是注入的 —— 所以能脱离 DSH 直接跑单测（`test/update.test.mjs`）。
  缓存文件写在 `~/.dsh/.cache/` 而不是插件目录里：本机是 `link:` 安装，插件目录就是 git 仓库，
  往里丢缓存会污染 `git status`。
- 路由限制 `127.0.0.1`，扫描结果缓存 30 秒、更新检查缓存 6 小时。

实测：15.4 MB / 21073 个事件的会话约 **0.57 秒**，几百个事件的小会话 **20 毫秒**。

## 已知限制

- 只统计**日志里能看到路径的写入**：`write` / `edit` 写了哪个文件、`present` 声明了哪个文件。
  纯读取，以及脚本自己运行时生成的文件（比如 Python 脚本画出来的图）不会出现在清单里 ——
  会话日志里没有它们的绝对路径。想要这类产物进清单，在 `present` 里声明一下就行。
- 大会话首次点击有几百毫秒延迟（有 30 秒缓存，连续点很快）。
- 更新检查要能连上 `api.github.com`：离线、被限流时静默跳过，不会提示更新（功能本身不受影响）。
- 只在 Windows 上验证过（依赖 `explorer.exe`）。macOS / Linux 需要换掉打开方式那一行。

## 目录结构

```
lib/index.js             host 端：扫描会话日志 + 四个 HTTP 路由 + 产物目录守门 + 更新检查的接线
lib/client.js            客户端：菜单项、标题栏按钮、选择弹窗、更新提示（手写模块表，无构建步骤）
lib/scan-session-core.mjs 会话日志定位与产出路径推导
lib/update.mjs           更新检查：GitHub Releases 比对 + 6 小时缓存（无 DSH 依赖，可单测）
lib/zstd-session.mjs     多帧 zstd 解压（会话日志是逐帧压缩的 JSONL）
test/probe.mjs           脱离 DSH 单测扫描逻辑：node test/probe.mjs <sessionId>
test/update.test.mjs     lib/update.mjs 单测：版本比较 / Release 折算 / 缓存 / 失败退避
test/client.test.mjs     lib/client.js 离线单测：stub 掉 window 与 require，验证插槽注册与更新卡片
```

全部单测：

```bash
npm test        # = node test/update.test.mjs && node test/client.test.mjs
```

## 许可

MIT
