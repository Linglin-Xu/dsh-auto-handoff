# Changelog

所有值得注意的变更都记录在这里。版本号遵循 Semantic Versioning。

## 0.3.0 — 2026-10-23

**默认改成手动交接 + 输入框底栏 UI。**

### 新增

- **手动模式**（新默认）：`autoHandoff: false`。交接由输入框底栏的「交接」按钮或 `POST /api/dsh-auto-handoff/queue` 触发；源会话正忙时返回 `202` 并**排队到本轮结束**再执行，不会切断正在运行的工具调用。
- **状态胶囊 + 阈值提醒**：输入框底栏常驻 `压缩 N · N 轮 · XX%`；阈值优先级与配色为 **压缩次数 > 轮数 > 占用量**（红 > 琥珀 > 蓝），到阈值时变色并在右上角弹一次提示（只提示，不自动切换）。
- **设置面板**：胶囊旁 ⚙ 内联编辑三个阈值与自动交接开关，持久化到 `$DSH_HOME/auto-handoff-ui.json`（重启不丢），也可用 `POST /api/dsh-auto-handoff/ui-config` 修改。
- **后台任务继承**：交接文档快照仍在运行的后台 job（id / 状态 / 最近输出）与存活子会话；交接后监听源会话的 job 事件，结束时把终态 + 输出尾巴转发到新会话（`ctx.jobs` 按会话围栏，没有转移所有权 API，完整输出仍需回旧会话查看）。
- `/status` 新增 `?sessionId=` 视图：返回 `turns` / `compactions` / `occupancy` / `jobs` / `prompts` / `queued`，供 UI 与脚本使用。

### 变更

- 客户端 UI 改为挂进 `conversation.composer.dock`（与底部统计同一行），槽位不可用时退回**左对齐悬浮条**；两处都有失败兜底，不会影响输入框渲染。
- 会话 id 从 `[data-conversation-session]` 读取（旧代码用的 `sessions.list.getSnapshot().current` 在 DSH 0.2 已不存在，导致状态与按钮失效）。

### 修复

- 摘要写入改为经 agent 收件箱排队（`user/message` 不再在第一个 turn 的 `system/message` 之前写入 surface）；修复交接出来的新会话**日志不可读、无法 resume** 的 `SessionFormatError`。
- 占用判定改用 `contextPressure` 投影（退回 `tokenMeter.measure().totalTokens`）；旧代码读已移除的 `projectedTokens/pressureTokens/contextWindow`，导致自动阈值**从不触发**。
- 交接的时序保证：新增内容指纹复核（摘要后、建会话后各一次）+ 收件箱排队输入检查，源会话在摘要期间继续工作时整次作废重来，避免把过期摘要交给新会话。

## 0.1.0 — 2026-09-28

首个公开版本：自动交接（`turn/end` + 占用阈值触发）、摘要 + 任务状态交接、浏览器自动切换、`/handoff` 与 `/status` 路由。
