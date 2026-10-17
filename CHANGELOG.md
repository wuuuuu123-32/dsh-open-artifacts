# 更新日志

本文件由 release.mjs 维护。

## v0.4.3 — 2026-10-17

- 运行要求统一为 Node.js **>=22.15**：会话日志用 zstd 解码，依赖该版本起稳定的 API；版本不够时直接报错说明，不再静默失败
- 修正 zstd 帧头 FCS 字段长度计算（`fcsSize`），带 content-size 的帧不再被读错
- 缺少 zstd API 时给出明确提示，而不是崩在类型错误上
- README 同步这两处

## v0.4.2 — 2026-10-16

- 产物根收窄回 Blender 建模产物：默认 `E:\AgentArtifacts\blender`，避免几十 MB 的 .blend 混在工作区的对话目录里
- 其它对话产出照旧按工作区约定的 `<工作区>\<主题>\` 收集；想换地方设环境变量 `DSH_ARTIFACT_ROOT`

## v0.4.1 — 2026-10-16

- 支持产物根放在工作区之外
- 能识别外部程序（例如 Blender）写出的产出，而不只统计本进程写入的文件

## v0.4.0 — 2026-10-15

- 有新版本时会在界面右下角提示你。
- 新增 lib/update.mjs：查 GitHub Releases 的 latest，跟 package.json 的版本号做语义化比较；结果缓存 6 小时（内存 + ~/.dsh/.cache/dsh-open-artifacts-update.json），网络失败退避 30 分钟
- host 端新增 GET /__open-artifacts/update（默认吃缓存，?force=1 强制重查），并在 DSH 启动 3 秒后后台查一次
- 客户端在 shell.overlay 加更新卡片：当前版本 → 最新版本、可展开的 Release 说明、「打开 Release 页面」、「忽略这个版本」（记在 localStorage，同一版本不再打扰，更高版本仍会提示）
- 新增两个离线单测：test/update.test.mjs（22 组断言：版本比较 / 缓存 / 失败退避）、test/client.test.mjs（14 组断言：插槽注册 / 显示条件 / 卡片渲染），npm test 一把跑完
- README 补「有新版本会提示你」一节
- 说明：这个包没有发布到 npm（registry 返回 404），更新源只有 GitHub Releases。
