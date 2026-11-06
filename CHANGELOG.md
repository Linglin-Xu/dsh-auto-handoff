# Changelog

所有值得注意的变更都记录在这里。版本号遵循 Semantic Versioning。

## 0.4.1 — 2026-11-06

**界面重做：跟着宿主主题走，信息更少但更准。** 只动浏览器半边（`lib/client.js`），宿主协议与 HTTP 接口完全不变。

### 变更

- **跟随宿主主题**：颜色全部改用 `--dsw-alias-*` 主题令牌（缺令牌时回落到旧色），light/dark 都正常；所有规则作用域在 `[data-dsh-auto-handoff]` 与 `.ah-` 前缀下，不再可能污染宿主样式。
- **胶囊重做**：一圈**环形进度**表示上下文占用比例，主文本改为 `轮数 · 百分比`；`压缩 N` / `已排队` / `goal` 只在真的有意义时出现，空闲会话保持安静（同排已有宿主自己的 usage pill）。
- **按钮与面板**：补齐 hover / 按下 / `:focus-visible` / 禁用态；⚙ 面板加了标题栏、× 关闭、带单位的输入框（隐藏 number 箭头）、取消/保存 footer、Esc 与点击外部关闭、`aria-expanded` 同步。
- **toast 分级**：左侧 3px 强调条区分提示（琥珀）与失败（红），跟随主题；点击关闭，8 秒自动消失。
- **交接反馈更早也更稳**：点击后立刻在胶囊里转圈显示「交接中…」，失败直接把原因写在胶囊里（`goal-active` 用琥珀而非红），并用 hold 时间窗避免被下一次 2 秒轮询抹掉。
- **尺寸对齐**：胶囊高度与同排宿主 pill 一致（22px），不会把输入框底栏撑高；悬浮条兜底模式保留毛玻璃底。

## 0.4.0 — 2026-11-06

**按「需求目的不变、实现重来」重写。** 目标功能照旧：手动优先地把当前对话交接进新会话，阈值只提示，源会话只读。实现拆成可单测的模块，并补上三类此前只能靠运气的地方：自动 goal 会话被劈成两半、摘要 provider 故障直接丢掉整次交接、每 2 秒两个轮询 + 全量重扫日志。

### 新增

- **摘要降级链 `summaryMode`**：`auto`（默认，模型失败 → 确定性本地摘录）/ `llm`（严格，失败即 `502`）/ `digest`（不调用模型）。交接文档永远有内容，`handoff` 记录新增 `summarySource`、`degraded`、`truncated`。
- **goal 守卫 `guardGoal`**（默认开）：会话正在跑自动 goal 时拒绝交接（自动模式跳过并记 `goal-active`，手动返回 `409`，`{"force":true}` 可绕过）——否则 goal 驱动会继续在旧会话里推进，同一件事被劈成两半。
- **续跑路径合并投递**：需要续跑时，交接文档**本身就是**新会话的第一条 prompt（一条消息、一次唤醒），不再是「先排队文档、再发一条『继续』」。
- `/status?sessionId=` 附带 `navigation`（**不消费**），浏览器半边靠它完成切换；`/pending` 仍保留，切换成功后清理。
- `handoff` 记录新增 `delivery` / `continued` / `continueSkipReason` / `goalPhase`；`/status` 的 `stats` 新增 `degraded` 与 `lastHandoffAt`。
- `test/resolve-install.mjs`：用 Node 解析钩子替代 junction 定位 `@deepseek-ai/*`，测试不再需要管理员权限；新增 `test/metrics.test.mjs`、`test/checkpoint.test.mjs`。

### 变更

- **模块拆分**：`lib/index.js` 从 1410 行拆成 `config` / `metrics` / `replay` / `checkpoint` / `summary` / `format` + 引擎（`index.js`）；纯函数各自可测（37 项），宿主半边集成检查约 110 项断言。
- **计数器增量折叠**：轮数/压缩次数按 `snapshotEvents()` 的长度增量推进，不再每 2 秒把整条日志重扫一遍；`compaction/start` 之后遇到 `turn/start|turn/end` 视为陈旧锁自动解除（旧实现会让 `compacting` 永久为真，之后再也交接不了）。
- **配置只在启动时读一次**：`auto-handoff-ui.json` 改为内存缓存（旧实现每次取配置都 `readFileSync`，还在事件处理器里），保存时才写。
- **浏览器半边只保留一个轮询**：2 秒一次的 `/status` 同时负责胶囊与导航，不再并发两个请求；悬浮条只在位置真的变化时写样式（旧实现每 tick 强制一次重排）；按钮点击立即显示「交接中…」。
- **占用测量有缓存**：优先读 `contextPressure` 投影；退回 `tokenMeter.measure()` 时缓存 5 秒，`resolveModelInfo` 按 provider/model 缓存 10 分钟。
- 移除从未被读取的死配置 `cooldownMs`（0.3.0 起文档里列过，代码里没有任何地方使用）。
- 交接记录、pending 记录、decision 记录有 TTL 清理并节流（每 30 秒最多一次）；后台任务桥限制为 20 条并 15 分钟自动断开。

### 修复

- **交接后旧会话继续跑**：goal 驱动的会话不再被自动交接；交接后旧会话若又被唤醒，`/status` 仍会记 `source-active-after-handoff` 提醒你这份工作只属于旧会话。
- **摘要在 provider 故障时丢整次交接**：`auto` 模式降级为本地摘录并继续；严格模式把错误原文放进 `error.message`。
- **建会话期间源会话又动了却照样投递**：建会话之后再核对一次内容指纹，过期就一个字节都不投递（新会话留空，不会把用户导航到过期交接）。
- **`/status` 轮询与导航互相抢**：状态查询不再消费 pending 记录，丢帧/刷新后仍能补上切换。

## 0.3.1 — 2026-10-23

### 修复

- **「交接失败：no replayable messages」**：摘要输入改为锚定「最近一条 user 消息」（选定能装进 `maxInputChars` 的最早 user 消息），不再因为末尾全是大段工具结果、预算先耗尽而把所有消息裁空；工具调用/结果始终保持成对。
- **无可回放消息时不再拒绝按钮**：surface 里已经没有 user 消息（被完全压缩、或只剩工具/助手内容）时，跳过摘要模型调用，直接用「任务块（待办 / 已改文件 / 最后一个请求）」交接，并在 `/status` 的 handoff 记录里标 `summarized: false`。
- **交接成本可见**：每次交接的摘要调用把 `usage`（输入/输出/cacheRead token）记进 `/status` 的 handoff 记录，并在右上角 toast 里显示。

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
- **「交接失败：Messages tool calls need immediate results」**：带图片的消息（截图类工具结果很常见）不再整条丢弃，改为把图片块替换成文字占位，工具调用/结果保持一一配对；最后再加一层配对净化，孤立调用或孤立结果会被剔除，而不是让整次交接失败。
- **「交接失败：summarization truncated at the token cap」**：摘要输出上限 2048 → **4096**；命中上限时不再判失败，保留已生成的摘要并在交接文档里标注「摘要因输出长度上限被截断」（`/status` 记录 `truncated: true`）；超大回放按单块 3000 字符裁剪，保持工具调用/结果配对。

## 0.2.x 及更早 — 2026-09 ~ 2026-10

- **0.2.0**：交接文档携带「上一个用户请求原文」与「已改文件」清单；浏览器半边重试打开新会话直到列表 feed 出现。
- **0.1.x**：首个可用版本——`turn/end` + 占用阈值触发的自动交接、摘要 + 任务状态交接、浏览器自动切换、`/handoff` 与 `/status` 路由。
