# 更新日志

本文件由 release.mjs 维护。

## v0.4.0 — 2026-10-15

- 有新版本时会在界面右下角提示你。
- 新增 lib/update.mjs：查 GitHub Releases 的 latest，跟 package.json 的版本号做语义化比较；结果缓存 6 小时（内存 + ~/.dsh/.cache/dsh-open-artifacts-update.json），网络失败退避 30 分钟
- host 端新增 GET /__open-artifacts/update（默认吃缓存，?force=1 强制重查），并在 DSH 启动 3 秒后后台查一次
- 客户端在 shell.overlay 加更新卡片：当前版本 → 最新版本、可展开的 Release 说明、「打开 Release 页面」、「忽略这个版本」（记在 localStorage，同一版本不再打扰，更高版本仍会提示）
- 新增两个离线单测：test/update.test.mjs（22 组断言：版本比较 / 缓存 / 失败退避）、test/client.test.mjs（14 组断言：插槽注册 / 显示条件 / 卡片渲染），npm test 一把跑完
- README 补「有新版本会提示你」一节
- 说明：这个包没有发布到 npm（registry 返回 404），更新源只有 GitHub Releases。
