---
name: auto-handoff
description: 会话交接：默认手动，点输入框底栏的「交接」按钮把当前对话压缩成交接文档（摘要 + 未完成任务 + 已改文件 + 后台任务清单），在同一个工作区的新会话里继续，浏览器自动切过去；到阈值只提示、不自动切换，可选自动模式。当用户提到上下文快满了、上下文太长、要压缩成摘要换个会话继续、交接上下文/换个新对话接着聊、context 80%、轮次阈值、长对话续接时使用。
whenToUse: 用户抱怨上下文变长/接近上限、要求把当前对话交接/压缩到新会话继续、要求查看或调整交接阈值与自动交接、或想知道上一次交接为什么没发生/发生了什么时加载。
---

# 会话交接（auto-handoff）

本技能由 **dsh-auto-handoff** 插件驱动。**默认是手动模式**：输入框底栏有一个状态胶囊（环形进度 + `12 轮 · 34%`，到阈值时会追加「压缩 N」「已排队」等标签）和「交接」按钮，按按钮才执行「摘要 → 新建会话 → 投递交接文档 → 浏览器切换」；agent 正跑着一轮时按钮会**排队到轮次结束**再执行，绝不切断工具调用。宿主侧同时负责阈值提示（轮数 / 占用 / 压缩次数）和 `/status` 指标。

## 触发方式

- **手动（默认）**：输入框底栏「交接」按钮，或 `POST /api/dsh-auto-handoff/queue`（`{sessionId}`）；若源会话不静默则返回 202 排队，等 `turn/end` / 空闲时自动执行。
- **提示阈值**：胶囊按 `promptRounds`（默认 10 轮）/ `promptPercent`（默认 0.6）/ `promptCompactions`（默认 2 次）变色并弹 toast，**只提示，不自动切换**（胶囊里数字与进度环会变色：蓝=品牌色 / 琥珀=轮数 / 红=压缩次数）。可在胶囊旁 ⚙ 面板或 `POST /api/dsh-auto-handoff/ui-config` 修改（持久化到 `$DSH_HOME/auto-handoff-ui.json`）。
- **自动（需显式开启）**：`autoHandoff: true` 时，同一会话满足「已完成轮数 ≥ `minRounds`（默认 3）」且「上下文占用 ≥ `threshold`（默认 0.8）」会自动交接一次。占用 = `contextPressure` 投影的 `projectedTokens ?? pressureTokens`（与 GUI 状态栏同一份投影；没有该投影时退回 `tokenMeter.measure().totalTokens`）÷ 该会话当前 provider/model 的 `contextWindow`。

补充约束：同一会话只交接一次（生成的新会话会再次受同一规则约束，因此长对话会一轮一轮自动续接）；有未结束的 turn、正在压缩、收件箱里还有排队输入、或会话正在跑自动 goal 时跳过本次，等下一个 `turn/end`；摘要写完后源会话又动了则整次作废重来；源会话只读，不修改、不取消、不迁移。

## 时序保证与 goal 守卫

交接只在源会话**静默**时发生，拒绝原因写进 `/status` 的 `decisions`：

| 原因 | 含义 |
| --- | --- |
| `source-open-turn` | 工具还在跑——**绝不切断** |
| `source-compacting` | 正在压缩 |
| `pending-input` | 排队输入会在旧会话开一轮，结果就落到旧会话 |
| `source-busy` | agent 不是 idle |
| `source-moved` | 摘要/建会话期间源会话又长了，整次作废重来 |
| `goal-active` | 会话正在跑自动 goal：交接会把工作劈成两半（`guardGoal` 默认开；手动可带 `{"force": true}` 绕过） |

交接后旧会话若又被唤醒（用户切回旧标签页、goal 续跑、后台成员回报），`/status` 记一条 `source-active-after-handoff`——那份工作只属于旧会话，新会话看不到。

**后台任务继承**：`ctx.jobs` 按 session 归属做授权围栏、没有转移所有权的 API，所以交接文档里会快照「仍在跑的后台 job（id / 状态 / 最近输出）+ 存活的子会话」，交接后插件继续监听源会话的 job 事件，结束时把状态和输出尾巴 **followup 到新会话**；完整输出仍需回旧会话查看。

## 交接时发生了什么

1. 读 `contextPressure` 投影（退回 `ctx.tokenMeter.measure(session).totalTokens`）判定占用；
2. 复用源会话自己的 system prompt + tools + 逐条消息（按 `maxInputChars` 从最新往回截断），在末尾追加一条压缩指令，走 `ctx.llm.stream()` 生成摘要——沿用前缀缓存，不额外计费上下文；`summaryMode: auto`（默认）在模型失败时降级成本地摘录，`llm` 严格、`digest` 完全不调用模型；
3. **带上任务状态，而不只是摘要**：从源会话的事件日志折叠出「当前待办清单」（最后一个 `todo/write`，与 `todos` 投影同规则）、「本段对话已改动的文件」（从 `tool/call` 参数里取路径）、「上一个用户请求原文」，拼成任务交接块附在摘要之后；
4. 用 `sessionController.create()` 建**同 cwd / 同 workspace / 同 agentPreset** 的新会话（走 `sessions.create()` 的会话没有 agent、没有持久化、侧边栏看不到）；
5. 投递 `<auto-handoff-checkpoint>` 文档：
   - **要续跑**（`autoContinue` 判定，默认 `auto` = 还有 `pending`/`in_progress` 项）→ 文档**本身就是新会话的第一条 prompt**，一条消息、一次唤醒，turn 1 立刻开跑；
   - **不续跑** → 进新会话的 **agent 收件箱**（`agent.send(message, 'next-turn', false)`，不唤醒），turn 1 里、system message 之后落地为首条用户消息，composer 显示为队列行。
   - 两条路都**绝不能**直接 append 到 surface：`user/message` 落在 turn 1 的 `system/message` 之前会让日志永久不可读（resume 报 `system/message requires a protected first surface head`）。
6. 浏览器侧只跑一个 2 秒轮询：`/status?sessionId=` 的响应带 `navigation`（不消费），发现新会话后 `openSession()` 切过去，并把新会话 id 记入 `localStorage`，刷新后仍停在正确会话；切换成功后再调 `/pending` 清掉记录；
7. 侧边栏保留源会话的完整历史，可随时回看。

## 手动操作（模型可用）

宿主暴露了 HTTP 路由，任何有 shell 的模型都可以直接调用：

```bash
# 查看交接状态（含每个会话最近一次判定与被跳过原因）
curl -s http://127.0.0.1:3080/api/dsh-auto-handoff/status

# 对当前会话执行一次交接（忽略轮次与阈值；源会话不静默时 409 并给出 reason）
curl -s -X POST http://127.0.0.1:3080/api/dsh-auto-handoff/handoff \
  -H 'content-type: application/json' \
  -d '{"sessionId":"<当前会话 id>"}'

# 队列式（用户点按钮走的就是这个）：忙时 202 排队到本轮结束
curl -s -X POST http://127.0.0.1:3080/api/dsh-auto-handoff/queue \
  -H 'content-type: application/json' \
  -d '{"sessionId":"<当前会话 id>"}'

# 读取并清除"待切换"记录（浏览器插件也在用；手动读取会让浏览器不再自动切换）
curl -s "http://127.0.0.1:3080/api/dsh-auto-handoff/pending?sessionId=<源会话 id>"
```

当前会话 id 可用 `$env:DSH_SESSION_ID`（PowerShell）/ `$DSH_SESSION_ID`（bash）读取。

## 安装与兼容性

随包分发的 **`INSTALL.md`** 是安装 / 兼容性 / 排障的唯一权威说明，内含「给 DSH Agent 的操作清单」，用户问"怎么装/兼容哪个版本"时先打开它。要点：

- 兼容 DSH **`>=0.1.7-alpha.1 <0.3.0`**（实测 `0.2.1-rc.3` / `0.2.0-rc.2`）；`≤0.1.0-rc.6` 不保证
- 安装：`dsh plugin --profile web add dsh-auto-handoff`（或 github / 本地 tgz / link）
- 装完必须：**重启 `dsh web`** → 浏览器 **Ctrl+Shift+R** → 把包内 `skill/` 复制到 `~/.dsh/skills/auto-handoff/`
- 自检：`curl -s http://127.0.0.1:3080/api/dsh-auto-handoff/status` 必须 `"ok": true`

## 配置

设置命名空间 `dsh-auto-handoff`。注意：新版 DSH 已移除 `~/.dsh/settings.yaml`（首次启动导入后改名为 `settings.yaml.imported`），配置现在落在 profile 的 `cordis.patch.yml`（等价于 GUI 设置页）；提示阈值也可以在输入框底栏胶囊的 ⚙ 面板里改（存到 `$DSH_HOME/auto-handoff-ui.json`）。字段：

```yaml
dsh-auto-handoff:
  enabled: true
  autoHandoff: false        # true = 恢复自动交接；默认手动（按钮 / /queue）
  threshold: 0.8            # 0~1，自动交接的占用比例阈值
  minRounds: 3              # 自动交接的最少完成轮数
  promptRounds: 10          # 提示：轮数
  promptPercent: 0.6        # 提示：占用比例
  promptCompactions: 2      # 提示：压缩次数
  uiEnabled: true           # 是否显示输入框底栏的状态胶囊与按钮
  summaryMode: auto         # auto | llm | digest：摘要失败是否降级为本地摘录
  maxInputChars: 20000      # 回放给摘要调用的字符预算（从最新往回保留）
  maxTokens: 4096           # 摘要输出上限
  provider: ''              # 摘要调用指定 provider（留空则用源会话路由）
  model: ''                 # 摘要调用指定 model（留空则用源会话路由）
  debug: true               # 让 /status 返回逐会话 decisions
  carryTasks: true          # 把待办清单 / 已改文件 / 上一个请求 / 后台任务搬进新会话
  autoContinue: auto        # auto | always | never：新会话是否自己接着跑
  continuePrompt: '继续…'   # 自动续跑时投递给新会话的那条消息
  guardGoal: true           # 有活跃 goal 时拒绝交接
```

阈值判定需要知道 `contextWindow`，因此**首次自动触发前该会话必须至少发出过一次请求**（有 `request/header`）。若路由取不到容量，插件不会自动触发，并把原因写进 `/status` 的 `decisions`。

## 排障

1. `curl -s http://127.0.0.1:3080/api/dsh-auto-handoff/status`：看 `handoffs`、`stats`（`checks` / `handoffs` / `failures` / `degraded` / `lastError`）、`decisions`。
2. 若始终不触发，看 `decisions` 里该会话的 `reason`：轮数不够（`below-min-rounds`）、占用没到阈值（`below-threshold`，带 `ratio`）、用量/容量未知（`no-request-header` / `no-provider-usage-yet` / `context-window-unresolved`）、测量异常（`occupancy-error` / `measure-failed`）、`goal-active`、`enabled: false`、已交接过一次、或该会话此刻不静默（`source-open-turn` / `pending-input` / `source-moved` / `source-busy` 等）。
3. 修完配置后无需重启即可生效（设置热更新）；插件本身的新增/删除需要重启 `dsh web`。
4. 插件自检（不需要 dsh 运行；用 Node 解析钩子定位依赖，不建 junction）：
   `powershell -ExecutionPolicy Bypass -File <插件目录>\test\run-tests.ps1`（或 `npm test`）；找不到依赖时设 `DSH_INSTALL`。
5. 插件源码与完整说明：本包目录下的 `README.md` / `INSTALL.md`。
6. `/status` 里每条 `handoffs` 记录带 `delivery`（`prompt` / `inbox` / `none`）/ `continued` / `continueSkipReason` / `summarySource` / `degraded` / `truncated` / `carriedTasks` / `goalPhase`：可直接看出文档是模型摘要还是本地摘录、有没有自动续跑、没续跑的原因（`disabled` / `no-live-agent` / `no-session-controller` / `prompt-failed`）、摘要有没有被截断。
