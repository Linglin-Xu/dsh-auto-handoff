# dsh-auto-handoff

DSH（DeepSeek Harness）的**会话交接**插件：默认手动，一键把当前对话压缩成交接文档，连同**未完成的任务**和**后台任务清单**带到新会话里继续；输入框底栏常驻状态胶囊，到阈值提醒，点一下就能改阈值。

> 📦 **安装 / 兼容性 / 排障**：见 **[INSTALL.md](INSTALL.md)**（随包分发，人和 DSH 里的 AI 都能按它操作）。
> 兼容 DSH `>=0.1.7-alpha.1 <0.3.0`（实测 **0.2.1-rc.3**，另一份在 **0.2.0-rc.2** 上跑过全流程）。

Manual-first session handoff for DeepSeek Harness: one button condenses the conversation into a handoff document (unfinished tasks + background jobs included) and continues in a fresh session. Threshold prompts live in the composer footer. MIT.

## 为什么是「插件 + 技能」

技能（Skill）本质是一段给模型看的 Markdown 指令：它只在**模型回合内**被执行，无法监听「一轮结束」、无法读取 token 占用、无法自己创建会话。

而「交接」必须发生在宿主侧（Host），所以本交付由两部分组成：

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| **技能** `auto-handoff` | `~/.dsh/skills/auto-handoff/SKILL.md` | 让模型知道规则、提供手动触发/查看状态的 HTTP 用法、排障路径 |
| **插件宿主半边** | `lib/index.js` | 摘要、任务与后台任务折叠、建会话、投递、HTTP 路由、时序校验 |
| **插件浏览器半边** | `lib/client.js` | 输入框底栏状态胶囊 + 「交接」按钮 + 阈值设置面板；交接完成后自动切到新会话 |

## 触发方式：默认手动

**默认手动模式**（`autoHandoff: false`）：交接由输入框底栏的「交接」按钮或 `POST /api/dsh-auto-handoff/queue` 触发。按钮在 agent 正跑着一轮时会**排队到本轮结束**再执行，不会切断任何工具调用。

底栏同时有一个状态胶囊：一圈**环形进度**表示上下文占用比例，右侧是 `12 轮 · 34%`。到阈值时数字与进度环一起变色，胶囊里再追加 `压缩 2` / `已排队` / `goal` 这类**只在有意义时才出现**的标签，并弹一次 toast（只提示，不切换）。配色跟随宿主 light/dark 主题（`--dsw-alias-*` 令牌），空闲会话保持安静。

**优先级/配色**（重要程度从高到低）：**压缩次数 > 轮数 > 占用量**，对应三档颜色 **红 / 琥珀 / 蓝**（蓝即主题的品牌色）。压缩次数最先提示，因为它意味着上下文正在被重写、模型最吃亏；轮数是次一级信号；占用百分比是最软的提醒。

| 配置项 | 含义 | 默认 |
| --- | --- | --- |
| `promptCompactions` | 压缩到第几次提示（最高优先级，红色） | 2 |
| `promptRounds` | 到多少轮提示（中优先级，琥珀色） | 10 |
| `promptPercent` | 上下文占用到百分之几提示（低优先级，蓝色；0~1） | 0.6 |

交接完成后右上角会弹一条提示：**本次摘要消耗的输入 / 输出 token**（含缓存读取），并标出这份文档是「模型摘要」「本地摘录」还是「被截断」；同一份数据也记在 `/status` 的 `handoffs[].usage` / `summarySource` / `degraded` / `truncated` 里，方便你核对每次交接的真实成本。

这三个值可以在胶囊旁的 ⚙ 面板里改（存到 `$DSH_HOME/auto-handoff-ui.json`，重启不丢），也可以用 `POST /api/dsh-auto-handoff/ui-config`。

想要旧的自动行为：打开 `autoHandoff`，则同一会话满足「已完成轮数 ≥ `minRounds`（默认 3）」且「上下文占用 ≥ `threshold`（默认 0.8）」时自动交接一次。占用 = `contextPressure` 投影的 `projectedTokens ?? pressureTokens`（与 GUI 状态栏同一份投影；没有该投影时退回 `tokenMeter.measure().totalTokens`）÷ 当前 provider/model 的 `contextWindow`。

同一会话只交接一次；交接产生的新会话继续受同一规则约束，所以长对话会一轮一轮自动续接。

**goal 守卫**（`guardGoal: true`，默认开）：会话正在跑自动 goal 时**不交接**——goal 驱动会在每次 `turn/end` 之后继续唤醒**旧会话**，交接就等于把同一件事劈成两半。自动模式直接跳过（`/status` 里记 `goal-active`），手动按钮会得到 `409`，确实要交接时带 `{"force": true}`。

## 交接流程

```
用户按「交接」（或 POST /queue）
      │
      ├─ 静默校验：无未结束 turn / 无压缩 / 无排队输入 / goal 未在跑
      │   → 忙则排队到下一轮结束（不会切断工具调用）
      │
      ├─ ctx.llm.stream()：复用源会话自己的 system + tools + 消息前缀，
      │   （沿用 provider 前缀缓存）末尾追加压缩指令 → 得到摘要
      │   summaryMode: llm 严格 / auto 失败降级为本摘录 / digest 不调用模型
      │
      ├─ 折叠任务状态（lib/handover.js，纯函数）：
      │   待办清单（最后一个 todo/write）/ 已改文件（tool/call 参数里的路径）/
      │   上一个用户请求原文 → 拼成任务交接块，附在摘要之后
      │
      ├─ 快照后台任务：ctx.jobs.list(源会话) 里仍在跑的 job（id/状态/最近输出）
      │   + 仍存活的子会话（列表形式）
      │
      ├─ sessionController.create()：同 cwd / 同 workspace / 同 agentPreset，
      │   得到真会话（有 agent、有持久化、侧边栏可见）
      │
      ├─ 投递 <auto-handoff-checkpoint> 文档：
      │   要续跑 → 文档本身就是新会话的第一条 prompt（一条消息，不是两条）
      │   不续跑 → 进 Agent 收件箱排队（持久化，composer 里显示为队列行）
      │
      ├─ 后台任务桥：监听源会话 job 事件，结束时把终态 + 输出尾巴 followup 到新会话
      │
      └─ 登记 pending{源会话 → 新会话} → 浏览器半边切到新会话
```

### 三种投递结果

| `delivery` | 何时 | 结果 |
| --- | --- | --- |
| `prompt` | 需要续跑（`autoContinue` 判定） | 文档作为新会话**第一条用户消息**，同时开跑 turn 1 |
| `inbox` | 不需要续跑 | 文档排在收件箱里（持久化），用户进来就能看到，不会无端花一次模型调用 |
| `none` | 没有存活的 agent | 记录在 `/status`，不会假装成功 |

旧版本是「先投递文档、再投一条『继续』」，两条消息、两次唤醒；现在续跑路径合成一条，文档本身就是开场白。

## 交接的时序保证

交接是「把一份快照往前搬」，所以它只在源会话**静默（quiescent）**时才会发生。任何一个条件不满足就拒绝本次交接，在 `/status` 的 `decisions` 里留下原因，下一次 `turn/end` / 空闲时自动重试：

| 决策原因 | 含义 |
| --- | --- |
| `source-open-turn` | 还有没结束的 turn（工具正在跑）——**绝不会被切断** |
| `source-compacting` | 正在压缩，等它结束 |
| `pending-input` | 收件箱里还有排队 / steering 的输入：交接后它会在**旧会话**里开一轮，结果就落到旧会话了 |
| `source-busy` | agent 状态不是 idle |
| `source-moved` | 写摘要或建会话期间源会话的内容又变了——摘要已过期，本次作废重来 |
| `goal-active` | 会话正在跑自动 goal：交接会把工作劈成两半（可用 `force` 覆盖） |

三条硬保证：

1. **不切断**：turn 没结束就绝不交接，工具调用/流式输出不会被截半。
2. **不白跑**：摘要前后各核对一次内容指纹（surface 节点数 + 替换/内容 generation，避开标题生成与投递回执这类记账事件），摘要描述的必须就是交接那一刻的状态；建会话之后还会再核对一次，过期就一个字节都不投递。
3. **不串会话**：源会话**只读**——不写入、不取消、不迁移；摘要调用只是一次旁路 LLM 调用，不会在源会话日志里留下记录。

诚实的边界：交接完成后，旧会话如果又被唤醒（用户切回旧标签页、goal 自动续跑、后台成员回报），那份工作只属于旧会话，新会话看不到；`/status` 会记一条 `source-active-after-handoff` 提醒你。

## 摘要策略

| `summaryMode` | 行为 |
| --- | --- |
| `auto`（默认） | 先调模型；失败就降级成**确定性本地摘录**（最近若干条消息按时间顺序引用），交接照样完成，记录 `summarySource: "digest"` + `degraded: <原因>` |
| `llm` | 只认模型摘要；provider 报错就让交接失败（HTTP `502`，错误原文在 `error.message`），适合「宁可不交接也要保证质量」的场景 |
| `digest` | 完全不调用模型，纯本地摘录，零额外花费 |

被输出上限截断的摘要不再算失败：保留已生成的部分并标 `truncated: true`，文档里附一句说明。整段对话没有任何可回放内容（全被压缩过、或只有工具输出）时，只交接任务状态块，不会因为「没有消息可摘」而报错。

## 性能

- 浏览器半边**只有一个轮询**：`/status?sessionId=` 的响应里已经带 `navigation`，不再每 2 秒发两个请求；`/status` **不消费**这条记录，即使丢帧或刷新也能补上切换。
- 状态计数按 `snapshotEvents()` 的**增量**折叠（`lib/metrics.js`），不是每 2 秒把整条日志重扫一遍。
- 占用优先读 `contextPressure` 投影；退回 `tokenMeter.measure()` 时结果缓存 5 秒；`resolveModelInfo` 按 provider/model 缓存 10 分钟。
- 组件阈值文件只在启动时读一次（旧版每次读配置都 `readFileSync`），保存时才写。
- 悬浮条只在位置真的变了才写样式，避免每 2 秒强制一次重排。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| **实测版本** | DSH **0.2.1-rc.3** / **0.2.0-rc.2**（web profile，宿主 + 底栏 UI 全流程跑过） |
| **声明范围** | `dsh >=0.1.7-alpha.1 <0.3.0`；Node `^22.19 || >=24` |
| 0.1.7 ~ 0.2.x | 用到的宿主/客户端 API 全部存在（见下表），预期完整可用 |
| 0.1.0-rc.7 ~ 0.1.6 | 宿主半边可用（`snapshotEvents` 用 `session.events` 兜底）；但客户端缺 `[data-conversation-session]`，底栏胶囊会显示「未就绪」，交接只能走 `POST /queue` 手动传 sessionId |
| ≤ 0.1.0-rc.6 | 不保证：缺 `ctx.jobs` / `contextPressure` 投影 / composer dock 槽位，后台任务不会继承、占用走旧字段或未知，UI 退化 |

API 版本边界（按 git 历史核实）：

| 依赖 | 首次可用版本 |
| --- | --- |
| `ctx.jobs`、`contextPressure` 投影、`conversation.composer.dock` 槽位 | 0.1.0-rc.7 |
| `session.snapshotEvents()` | 0.1.2-alpha.4（更早用 `session.events` 兜底） |
| 会话格式 V4、`[data-conversation-session]` | 0.1.7-alpha.1 |
| `agent.send()` | 新版（缺失时退回 `agent.inbox.append`） |
| `tokenMeter.measure().totalTokens` | 新版（旧字段 `projectedTokens/pressureTokens/contextWindow` 与 `contextPressure` 投影都兼容） |
| `sessionProjections.stateOf(session, 'goal')` | 新版（缺失时 goal 守卫自动失效，不会误拦） |

**升级 DSH 之后**：先 `curl /api/dsh-auto-handoff/status`，`ok:true` 说明宿主半边正常；再看输入框底栏的胶囊在不在。客户端 API 变动时它会退回悬浮条，或静默隐藏——**不会**影响输入框本身；交接仍可通过 HTTP 接口使用。

## 安装

三种方式任选其一（装完都要**重启 `dsh web`**，然后浏览器 `Ctrl+Shift+R`）：

```powershell
# 1) npm
dsh plugin --profile web add dsh-auto-handoff

# 2) GitHub
dsh plugin --profile web add github:Linglin-Xu/dsh-auto-handoff

# 3) 本地 link（开发用，改代码即时生效）
node <dsh 安装目录>\apps\cli\lib\bin.js plugin --profile web add link:<插件绝对路径>
```

> 本仓库另带 `install-dsh-auto-handoff.ps1`（本机路径写死），额外把技能复制到 `~/.dsh/skills/auto-handoff/` 并合并配置。

**技能（推荐）**：npm 包里的技能不会自动安装。装完把 `node_modules/dsh-auto-handoff/skill/SKILL.md` 复制到 `~/.dsh/skills/auto-handoff/SKILL.md`，模型才知道何时提醒你交接、以及 `/status`、`/handoff` 的用法。

## 配置

命名空间 `dsh-auto-handoff`。新版 DSH 已移除 `~/.dsh/settings.yaml`（首次启动导入后改名 `settings.yaml.imported`），所以配置落在 `~/.dsh/profiles/web/cordis.patch.yml`（等价于 GUI 设置页，改完热更新）：

```yaml
dsh-auto-handoff:
  enabled: true             # 插件总开关
  autoHandoff: false        # true = 恢复自动交接（默认手动）
  threshold: 0.8            # 自动交接的占用阈值（0~1，仅 autoHandoff 时生效）
  minRounds: 3              # 自动交接的最少完成轮数
  promptRounds: 10          # 提示：轮数
  promptPercent: 0.6        # 提示：占用比例
  promptCompactions: 2      # 提示：压缩次数
  uiEnabled: true           # 是否显示输入框底栏的状态胶囊与按钮
  summaryMode: auto         # auto | llm | digest（见「摘要策略」）
  maxInputChars: 20000      # 回放给摘要调用的字符预算（从最新往回保留）
  maxTokens: 4096           # 摘要输出上限
  provider: ''              # 摘要调用的 provider（留空 = 跟源会话路由）
  model: ''                 # 摘要调用的 model（留空 = 跟源会话路由）
  debug: true               # /status 是否返回逐会话 decision
  carryTasks: true          # 把待办 / 已改文件 / 上一个请求 / 后台任务搬进新会话
  autoContinue: auto        # auto | always | never：新会话是否自己接着跑
  continuePrompt: '继续…'   # 自动续跑时投递的那条消息
  guardGoal: true           # 有活跃 goal 时拒绝交接（见「goal 守卫」）
```

`autoContinue: auto`（默认）只在交接块里还有 `pending` / `in_progress` 项时才续跑；任务已全部完成就保持安静，不会无端消耗一次模型调用。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/dsh-auto-handoff/status` | 配置、统计、handoff 记录、decisions、队列 |
| GET | `/api/dsh-auto-handoff/status?sessionId=...` | 该会话的 `turns / compactions / occupancy / jobs / prompts / queued / goal`（UI 用它），并附带**不消费**的 `navigation` |
| POST | `/api/dsh-auto-handoff/queue` | 用户点「交接」：立即执行，忙则 `202` 排队 |
| POST | `/api/dsh-auto-handoff/handoff` | 强制交接（源会话不静默时 `409`；`{"force":true}` 绕过 goal 守卫） |
| POST | `/api/dsh-auto-handoff/ui-config` | 写入提示阈值 / `autoHandoff`（持久化） |
| GET | `/api/dsh-auto-handoff/pending?sessionId=...` | 读取并清除「待切换」记录（客户端在切换成功后调用） |

```powershell
# 立刻交接当前会话（人也能用；源会话不静默时返回 409）
curl.exe -s -X POST http://127.0.0.1:3080/api/dsh-auto-handoff/queue `
  -H "content-type: application/json" `
  -d "{\"sessionId\":\"$env:DSH_SESSION_ID\"}"
```

## 测试

```powershell
npm test        # = powershell -ExecutionPolicy Bypass -File test\run-tests.ps1
```

五套：任务交接折叠 / 会话计数器 / 摘要回放+交接文档（纯函数），静态自检（真实 settings schema + 客户端 bundle），宿主半边集成检查（真实 Cordis + 假 DSH 服务，覆盖自动/手动/排队/降级/严格/goal 守卫/pending 语义）。

`@deepseek-ai/*` 通过 `test/resolve-install.mjs` 的 Node 解析钩子定位，**不再**在插件目录里创建 junction（不需要管理员权限）。找不到时设置 `DSH_INSTALL` 指向已安装的 `@deepseek-ai/dsh` 目录。

## 隐私

- 生成摘要时，会把源会话最近一段消息（按 `maxInputChars` 截断，默认最多 2 万字符）**发给该会话配置的 provider/model**。这是唯一一次额外模型调用（`summaryMode: digest` 时没有）。
- 后台任务快照（id / 状态 / 最近输出）会写进交接文档，也就是作为新会话首条消息进入新会话上下文——请按需使用。
- 插件不发遥测；除 `$DSH_HOME` 下的会话日志、`auto-handoff-ui.json` 与交接记录外不写任何文件。

## 卸载

```powershell
# 1. 停掉 dsh web
# 2. 移除插件层
dsh plugin --profile web remove dsh-auto-handoff
# 3. 删除技能与 UI 配置
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\auto-handoff"
Remove-Item -Force "$env:USERPROFILE\.dsh\auto-handoff-ui.json"
```

## 已知边界

- **单标签自动切换**：浏览器半边按当前标签页的会话轮询，多标签同开时先轮询到的那个标签会切过去。
- **摘要消耗一次模型调用**：走源会话的 provider/model（或配置覆盖），输出上限 `maxTokens`。
- **纯阈值，不理解内容**：提示/触发与「这一轮做了什么」无关。
- **自动续跑的花费**：`autoContinue` 生效时会立刻跑一轮（一次模型调用）。
- **占用依赖 usage**：全新空会话没有 provider usage，占用显示「未知」；聊过一轮之后才准。
- **后台任务归属**：`ctx.jobs` 按会话围栏，没有转移所有权 API——新会话读不到旧 job 的完整输出，插件只转发终态与输出尾巴。
- **客户端 UI 依赖 DSH 的 DOM/槽位**：`conversation.composer.dock`、`[data-composer-card]`、`[data-conversation-session]`。这些在升级 DSH 后可能变；变了的后果是 UI 退回悬浮条或静默隐藏，不影响交接本身（HTTP 接口仍可用）。

## 主要文件

- `lib/index.js` —— 宿主半边（引擎、投递、HTTP 路由、时序校验）
- `lib/config.js` —— 设置 schema、边界夹取、UI 阈值文件（内存缓存）
- `lib/metrics.js` —— 轮数/压缩计数的增量折叠 + 阈值判定（纯函数）
- `lib/replay.js` —— 回放消息构建、图片占位、工具配对净化、超长截断（纯函数）
- `lib/checkpoint.js` —— 交接文档组装 + 本地摘录（纯函数）
- `lib/handover.js` —— 任务交接折叠（纯函数：todo / 已改文件 / 上一个请求）
- `lib/summary.js` —— 摘要调用（`ctx.llm.stream` + `BlockAssembler`）
- `lib/client.js` —— 浏览器半边（底栏胶囊 + 交接按钮 + 阈值面板 + 单轮询导航）
- `cordis.patch.yml` —— 插件挂载声明
- `skill/SKILL.md` —— 随包分发的技能副本
- `test/run-tests.ps1` —— 测试入口（五套测试）
- `test/smoke.mjs` / `test/host-check.mjs` —— 静态自检 / 宿主半边集成检查
- `test/{handover,metrics,checkpoint}.test.mjs` —— 纯函数测试
- `test/resolve-install.mjs` —— `@deepseek-ai/*` 解析钩子（替代 junction）
- `CHANGELOG.md` —— 版本变更
- `LICENSE` —— MIT
