# Changelog

## 0.3.1 — 2026-10-23

### 修复

- **「交接失败：no replayable messages」**：摘要输入改为锚定「最近一条 user 消息」（选定能装进 `maxInputChars` 的最早 user 消息），不再因为末尾全是大段工具结果、预算先耗尽而把所有消息裁空；工具调用/结果始终保持成对。
- **无可回放消息时不再拒绝按钮**：surface 里已经没有 user 消息（被完全压缩、或只剩工具/助手内容）时，跳过摘要模型调用，直接用「任务块（待办 / 已改文件 / 最后一个请求）」交接，并在 `/status` 的 handoff 记录里标 `summarized: false`。

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

首个公开版本：自动交接（`turn/end` + 占用阈值触发）、摘要 + 任务状态交接、浏览器自动切换、`/handoff` 与 `/status` 路由。- 🐛 **「交接失败：Messages tool calls need immediate results」**：带图片的消息（截图类工具结果很常见）不再整条丢弃，改为把图片块替换成文字占位，工具调用/结果保持一一配对；并在最后加了一层配对净化，孤立调用或孤立结果会被剔除，而不是让整次交接失败。

- 🐛 **「交接失败：summarization truncated at the token cap」**：摘要输出上限 2048 → **4096**；命中上限时不再判失败，而是保留已生成的摘要并在交接文档里标注「摘要因输出长度上限被截断」，交接照常完成（`/status` 记录 `truncated: true`）；超大回放会按单块 6000 字符裁剪文本，保持工具调用/结果配对。

- 📈 **交接成本可见**：每次交接的摘要调用都会把 `usage`（输入/输出/cacheRead token）记进 `/status` 的 handoff 记录；超大回放按单块 3000 字符裁剪，最坏情况也有上界。

- 💬 **交接完成提示**：右上角 toast 显示本次摘要的输入/输出 token（含缓存读取），`/status` 的 `handoffs[].usage` 同步记录。


