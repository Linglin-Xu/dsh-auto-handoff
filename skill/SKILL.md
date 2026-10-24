---
name: auto-handoff
description: 上下文自动交接：每 3 轮对话后若上下文占用达到 80% 左右，自动把整段对话压缩成一份摘要、在同一工作区新建会话并把摘要作为首条消息交接过去，随后自动把浏览器切到新会话，用户无需任何额外操作。也支持手动立即交接、查看交接状态、调整阈值。当用户提到上下文快满了、自动压缩、自动开新会话/新对话、交接上下文、context 80%、轮次阈值、长对话续接时使用。
whenToUse: 用户抱怨上下文变长/接近上限、要求"自动开新会话继续聊"、要求查看或调整自动交接配置、或需要立刻压缩当前对话并换会话继续时加载。
---

# 自动上下文交接（auto-handoff）

本技能由 **dsh-auto-handoff** 插件驱动。**默认是手动模式**：用户在输入框右侧看到一个状态胶囊（`12 轮 · 34% · 压缩 2`）和「交接」按钮，按按钮才会执行「压缩 → 新建会话 → 注入摘要 → 通知浏览器切换」；agent 正跑着一轮时按钮会**排队到轮次结束**再执行。宿主侧同时负责阈值提示（轮数 / 占用 / 压缩次数）和 `/status` 指标。

## 触发方式

- **手动（默认）**：输入框右侧「交接」按钮，或 `POST /api/dsh-auto-handoff/queue`（`{sessionId}`）；若源会话不静默则返回 202 排队，等 `turn/end` / 空闲时自动执行。
- **提示阈值**：胶囊按 `promptRounds`（默认 10 轮）/ `promptPercent`（默认 0.6）/ `promptCompactions`（默认 2 次）变色并弹 toast，**只提示，不自动切换**。可在胶囊旁 ⚙ 面板或 `POST /api/dsh-auto-handoff/ui-config` 修改（持久化到 `$DSH_HOME/auto-handoff-ui.json`）。
- **自动（需显式开启）**：`autoHandoff: true` 时，同一会话满足「已完成轮数 ≥ `minRounds`（默认 3）」且「上下文占用 ≥ `threshold`（默认 0.8）」会自动交接一次。占用 = `contextPressure` 投影的 `projectedTokens ?? pressureTokens`（与 GUI 状态栏同一份投影；没有该投影时退回 `tokenMeter.measure().totalTokens`）÷ 该会话当前 provider/model 的 `contextWindow`。

补充约束：同一会话只交接一次（生成的新会话会再次受同一规则约束，因此长对话会一轮一轮自动续接）；有未结束的 turn、正在压缩、或收件箱里还有排队输入时跳过本次，等下一个 `turn/end`；摘要写完后源会话又动了则整次作废重来；源会话只读，不修改、不取消、不迁移。

时序保证（为什么不会切断 / 白跑 / 串会话）：交接只在源会话**静默**时发生，拒绝原因写进 `/status` 的 `decisions`——`source-open-turn`（工具还在跑，绝不切断）、`source-compacting`、`pending-input`（排队输入会在旧会话开一轮，结果就落到旧会话）、`source-busy`（agent 非 idle）、`source-moved`（摘要/建会话期间源会话又长了，重来）。交接后旧会话若又被唤醒，`/status` 记一条 `source-active-after-handoff`。

**后台任务继承**：`ctx.jobs` 按 session 归属做授权围栏、没有转移所有权的 API，所以交接文档里会快照「仍在跑的后台 job（id / 状态 / 最近输出）+ 存活的子会话」，交接后插件继续监听源会话的 job 事件，结束时把状态和输出尾巴 **followup 到新会话**；完整输出仍需回旧会话查看。

## 交接时发生了什么

1. 读 `contextPressure` 投影（退回 `ctx.tokenMeter.measure(session).totalTokens`）判定占用达标；
2. 复用源会话自己的 system prompt + tools + 逐条消息（按 `maxInputChars` 从最新往回截断），在末尾追加一条压缩指令，走 `ctx.llm.stream()` 生成摘要——沿用前缀缓存，不额外计费上下文；
3. **带上任务状态，而不只是摘要**：再从源会话的事件日志折叠出「当前待办清单」（最后一个 `todo/write`，与 `todos` 投影同规则）、「本段对话已改动的文件」（从 `tool/call` 参数里取路径）、「上一个用户请求原文」，拼成任务交接块附在摘要之后；
4. 用摘要 + 任务交接块构造一条 `user/message`，带 `<auto-handoff-checkpoint>` 包装与「把它当作已建立的上下文、直接继续任务」的框定，经新会话的 **agent 收件箱排队**（`agent.send(message, 'next-turn', false)`，不唤醒），在 turn 1 里、system message 之后落地为**新会话的首条用户消息**——绝不能直接 append 到 surface，否则日志永久不可读（resume 报 `system/message requires a protected first surface head`）；
5. 新会话继承 `cwd`、`agentPreset`，并立即 `flush` 落盘；源会话 id 记在 `/status` 的 handoff 记录里（controller 路径不写 header 的 `parentSession`）；
6. **自动续跑**：交接块里还有 `pending` / `in_progress` 项（或配置 `autoContinue: always`）时，用 `ctx.sessionController.prompt()` 立刻向新会话投递一条「继续」，Agent 不等用户开口就接着干；任务已全部完成则保持安静；
7. 浏览器侧客户端插件轮询宿主状态，发现新会话后自动 `openSession()` 切换过去（并把新会话 id 记入 `localStorage`，刷新后仍停在正确会话）；
8. 侧边栏保留源会话的完整历史，可随时回看。

## 手动操作（模型可用）

宿主暴露了 HTTP 路由，任何有 shell 的模型都可以直接调用：

```bash
# 查看交接状态（含每个会话最近一次判定与被跳过原因）
curl -s http://127.0.0.1:3080/api/dsh-auto-handoff/status

# 立刻对当前会话执行一次交接（忽略轮次与阈值；但源会话不静默时返回 409）
curl -s -X POST http://127.0.0.1:3080/api/dsh-auto-handoff/handoff \
  -H 'content-type: application/json' \
  -d '{"sessionId":"<当前会话 id>","reason":"manual"}'

# 读取并清除"待切换"记录（浏览器插件也在用；手动读取会让浏览器不再自动切换）
curl -s "http://127.0.0.1:3080/api/dsh-auto-handoff/pending?sessionId=<源会话 id>"
```

当前会话 id 可用 `$env:DSH_SESSION_ID`（PowerShell）/ `$DSH_SESSION_ID`（bash）读取。

## 安装与兼容性

随包分发的 **`INSTALL.md`** 是安装 / 兼容性 / 排障的唯一权威说明，内含「给 DSH Agent 的操作清单」，用户问"怎么装/兼容哪个版本"时先打开它。要点：

- 兼容 DSH **`>=0.1.7-alpha.1 <0.3.0`**（实测 `0.2.0-rc.2`）；`≤0.1.0-rc.6` 不保证
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
  maxInputChars: 20000      # 回放给摘要调用的字符预算（从最新往回保留）
  maxTokens: 4096           # 摘要输出上限
  provider: ''              # 摘要调用指定 provider（留空则用源会话路由）
  model: ''                 # 摘要调用指定 model（留空则用源会话路由）
  cooldownMs: 60000         # 同一会话两次交接的最小间隔
  debug: false              # 让 /status 返回更详细的判定过程
  carryTasks: true          # 把待办清单 / 已改文件 / 上一个请求 / 后台任务搬进新会话
  autoContinue: auto        # auto | always | never：新会话是否自己接着跑
  continuePrompt: '继续…'   # 自动续跑时投递给新会话的那条消息
```

阈值判定需要知道 `contextWindow`，因此**首次自动触发前该会话必须至少发出过一次请求**（有 `request/header`）。若路由取不到容量，插件不会自动触发，并把原因写进 `/status` 的 `decisions`。

## 排障

1. `curl -s http://127.0.0.1:3080/api/dsh-auto-handoff/status`：看 `handoffs`、`lastDecision`、`reason`。
2. 若始终不触发，看 `decisions` 里该会话的 `reason`：轮数不够（`below-min-rounds`）、占用没到 80%（`below-threshold`，带 `ratio`）、用量/容量未知（`no-request-header` / `no-provider-usage-yet` / `context-window-unresolved`）、测量异常（`occupancy-error` / `measure-failed`）、`enabled: false`、已交接过一次、或该会话此刻不静默（`source-open-turn` / `pending-input` / `source-moved` / `source-busy` 等）。
3. 修完配置后无需重启即可生效（设置热更新）；插件本身的新增/删除需要重启 `dsh web`。
4. 插件自检（不需要 dsh 运行，跑完自动清理临时依赖链接）：
   `powershell -ExecutionPolicy Bypass -File <插件目录>\test\run-tests.ps1`
5. 插件源码与完整说明：本包目录下的 `README.md` / `INSTALL.md`。
6. `/status` 里每条 `handoffs` 记录带 `carriedTasks` / `continued` / `continueSkipReason` / `checkpointQueued`：可直接看出这次交接带没带任务、有没有自动续跑、没续跑的原因（`task-complete` / `disabled` / `no-session-controller` / `prompt-failed`）、交接摘要有没有投递成功。
