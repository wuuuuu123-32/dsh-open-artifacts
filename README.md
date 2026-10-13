# dsh-open-artifacts

给 DSH 加一个动作：**直接打开某个对话的产物文件夹**。

不用再自己翻 —— 侧边栏会话行的「⋯」菜单和对话标题旁各有一个入口，
点了就去读这个对话的会话日志，算出「它到底往哪些目录写过文件」，然后用资源管理器打开。

> 起因：DSH 生态里已有的几个「打开文件夹」插件（dsh-open-workspace、dsh-open-folder、
> dsh-open-explorer、dsh-session-manager、dsh-workspace-menu）打开的都是**工作区根目录**，
> 没有任何「会话 → 产物目录」的映射。而同一个工作区下动辄几十个对话，
> 打开根目录等于没打开 —— 真正想要的是「**这个**对话的产物在哪」。

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
2. 收集**成功**的 `write` / `edit` / `str_replace_editor` 调用 —— `tool/result` 里标了 `isError` 的会跳过；
3. 再补上 `deliverables/presented` 事件里登记过的产物路径；
4. 把这些路径按工作目录下的**顶层目录**归类。

所以结果是「这个对话真正写过东西的地方」，不是「工作区里有什么目录」。

工作区根目录下的散文件（`AGENTS.md`、`升级日志.md` 这类跨对话公用资产）会单独归类成一个提示项，
工作区之外的产出（比如这次顺手改的 `D:\ollama`）也会列出来、但标注「工作区之外」。

## 行为

| 情况 | 表现 |
|---|---|
| 只有 1 个产物目录 | 直接开窗，不弹任何东西 |
| 有多个 | 弹一个小列表，每项显示目录名 + 产出了几个文件 + 完整路径 |
| 一个都没有 | 提示「没有找到产物」，并给一个「打开工作区根目录」的兜底按钮 |

## 安装

```bash
dsh plugin --profile desktop add github:wuuuuu123-32/dsh-open-artifacts
```

装完**必须重启 DSH**（新增的插槽项不会热加载）。

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

- **用的是正式插槽，不是 DOM 注入**：`sidebar.workspaces.session.menu.item`（会话行 ⋯ 菜单）和
  `conversation.session.header.actions`（标题旁动作）。这两个插槽在 DSH `0.2.0-rc.2` 上都直接给
  `sessionId`，不需要去猜 DOM 结构。现存的那几个同类插件都是 2026-08/09 写的，
  靠 DOM 注入会话菜单，在 `0.2.0-rc.2` 上有失效风险。
- **打开目录走自建 host 路由**（`POST /__open-artifacts/open`），不用内置 `host.openPath()`：
  后者在 Windows 上走 `powershell Invoke-Item`，对**中文路径静默失败** —— 报告成功却不开窗。
  这里直接 `spawn('explorer.exe', [dir])`，Node 在 Windows 下用宽字符 API 传参，中文路径不需要额外编码。
- **只允许打开「这个会话产出过的目录」**：open 路由拿着 `sessionId` 重算一遍白名单，
  路径不在里面就 `403`，所以它不会变成一个任意路径开窗器。
- 路由限制 `127.0.0.1`，host 端结果缓存 30 秒。

实测：15.4 MB / 21073 个事件的会话约 **0.57 秒**，几百个事件的小会话 **20 毫秒**。

## 已知限制

- 只统计**新写出来的文件**。纯读取、以及脚本自己运行时生成的文件（比如 Python 脚本画出的图）
  不会出现在清单里 —— 会话日志里没有它们的绝对路径。
- 大会话首次点击有几百毫秒延迟（有 30 秒缓存，连续点很快）。
- 只在 Windows 上验证过（依赖 `explorer.exe`）。macOS / Linux 需要换掉打开方式那一行。

## 目录结构

```
lib/index.js             host 端：扫描会话日志 + 两个 HTTP 路由
lib/client.js            客户端：菜单项、标题栏按钮、选择弹窗（手写模块表，无构建步骤）
lib/scan-session-core.mjs 会话日志定位与产出路径推导
lib/zstd-session.mjs     多帧 zstd 解压（会话日志是逐帧压缩的 JSONL）
test/probe.mjs           脱离 DSH 单测扫描逻辑：node test/probe.mjs <sessionId>
```

## 许可

MIT
