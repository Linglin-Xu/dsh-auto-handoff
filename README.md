# dsh-auto-handoff

DSH（DeepSeek Harness）的**会话交接**插件：默认手动，一键把当前对话压缩成交接文档，连同**未完成的任务**和**后台任务清单**带到新会话里继续；输入框底栏常驻状态胶囊，到阈值提醒，点一下就能改阈值。

> 📦 **安装 / 兼容性 / 排障**：见 **[INSTALL.md](INSTALL.md)**（随包分发，人和 DSH 里的 AI 都能按它操作）。
> 兼容 DSH `>=0.1.7-alpha.1 <0.3.0`（实测 **0.2.0-rc.2**）。

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

底栏同时有一个状态胶囊：`压缩 2 · 12 轮 · 34%`，按三个**提示阈值**变色并弹一次 toast（只提示，不切换）。

**优先级/配色**（重要程度从高到低）：**压缩次数 > 轮数 > 占用量**，对应颜色 **红 > 琥珀 > 蓝**。压缩次数最先提示，因为它意味着上下文正在被重写、模型最吃亏；轮数是次一级信号；占用百分比是最软的提醒。

| 配置项 | 含义 | 默认 |
| --- | --- | --- |
| `promptCompactions` | 压缩到第几次提示（最高优先级，红色） | 2 |
| `promptRounds` | 到多少轮提示（中优先级，琥珀色） | 10 |
| `promptPercent` | 上下文占用到百分之几提示（低优先级，蓝色；0~1） | 0.6 |

这三个值可以在胶囊旁的 ⚙ 面板里改（存到 `$DSH_HOME/auto-handoff-ui.json`，重启不丢），也可以用 `POST /api/dsh-auto-handoff/ui-config`。

想要旧的自动行为：打开 `autoHandoff`，则同一会话满足「已完成轮数 ≥ `minRounds`（默认 3）」且「上下文占用 ≥ `threshold`（默认 0.8）」时自动交接一次。占用 = `contextPressure` 投影的 `projectedTokens ?? pressureTokens`（与 GUI 状态栏同一份投影；没有该投影时退回 `tokenMeter.measure().totalTokens`）÷ 当前 provider/model 的 `contextWindow`。

同一会话只交接一次；交接产生的新会话继续受同一规则约束，所以长对话会一轮一轮自动续接。

## 交接流程

```
用户按「交接」（或 POST /queue）
      │
      ├─ 静默校验：无未结束 turn / 无压缩 / 无排队输入 → 否则排队到下一轮结束
      │
      ├─ ctx.llm.stream()：复用源会话自己的 system + tools + 消息前缀，
      │   （沿用 provider 前缀缓存）末尾追加压缩指令 → 得到摘要
      │
      ├─ 折叠任务状态（lib/handover.js，纯函数）：
      │   待办清单（最后一个 todo/write）/ 已改文件（tool/call 参数里的路径）/
      │   上一个用户请求原文 → 拼成任务交接块，附在摘要之后
      │
      ├─ 快照后台任务：ctx.jobs.list(源会话) 里仍在跑的 job（id/状态/最近输出）
      │   + 仍存活的子会话（列表形式）
      │
      ├─ ctx.sessions.create()：同 cwd / 同 agentPreset，把摘要 + 任务块 +
      │   后台任务块包装成 <auto-handoff-checkpoint>，经 Agent 收件箱排队
      │   agent.send(message, 'next-turn', false)（不唤醒）并 flush
      │
      ├─ 还有 pending / in_progress 项（或 autoContinue: always）
      │   → ctx.sessionController.prompt() 向新会话投一条「继续」，Agent 自己接着干
      │
      ├─ 后台任务桥：监听源会话 job 事件，结束时把终态 + 输出尾巴 followup 到新会话
      │
      └─ 登记 pending{源会话 → 新会话} → 浏览器半边切到新会话
```

## 交接的时序保证

交接是「把一份快照往前搬」，所以它只在源会话**静默（quiescent）**时才会发生。任何一个条件不满足就拒绝本次交接，在 `/status` 的 `decisions` 里留下原因，下一次 `turn/end` / 空闲时自动重试：

| 决策原因 | 含义 |
| --- | --- |
| `source-open-turn` | 还有没结束的 turn（工具正在跑）——**绝不会被切断** |
| `source-compacting` | 正在压缩，等它结束 |
| `pending-input` | 收件箱里还有排队 / steering 的输入：交接后它会在**旧会话**里开一轮，结果就落到旧会话了 |
| `source-busy` | agent 状态不是 idle |
| `source-moved` | 写摘要或建会话期间源会话的内容又变了——摘要已过期，本次作废重来 |

三条硬保证：

1. **不切断**：turn 没结束就绝不交接，工具调用/流式输出不会被截半。
2. **不白跑**：摘要前后各核对一次内容指纹（surface 节点数 + 替换/内容 generation，避开标题生成与投递回执这类记账事件），摘要描述的必须就是交接那一刻的状态。
3. **不串会话**：源会话**只读**——不写入、不取消、不迁移；摘要调用只是一次旁路 LLM 调用，不会在源会话日志里留下记录。

诚实的边界：交接完成后，旧会话如果又被唤醒（用户切回旧标签页、goal 自动续跑、后台成员回报），那份工作只属于旧会话，新会话看不到；`/status` 会记一条 `source-active-after-handoff` 提醒你。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| **实测版本** | DSH **0.2.0-rc.2**（web profile，宿主 + 底栏 UI 全流程跑过） |
| **声明范围** | `dsh >=0.1.7-alpha.1 <0.3.0`；Node `^22.19 || >=24` |
| 0.1.7 ~ 0.2.x（含 0.2.1-alpha） | 用到的宿主/客户端 API 全部存在（见下表），预期完整可用；**只有 0.2.0-rc.2 是实测** |
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

**升级 DSH 之后**：先 `curl /api/dsh-auto-handoff/status`，`ok:true` 说明宿主半边正常；再看输入框底栏的胶囊在不在。客户端 API 变动时它会退回悬浮条，或静默隐藏——**不会**影响输入框本身；交接仍可通过 HTTP 接口使用。

## 安装

三种方式任选其一（装完都要**重启 `dsh web`**，然后浏览器 `Ctrl+Shift+R`）：

```powershell
# 1) npm（暂未发布，先用 2 或 3）
dsh plugin --profile web add dsh-auto-handoff   # npm 上暂未发布，这条暂时会 404

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
  maxInputChars: 20000      # 回放给摘要调用的字符预算（从最新往回保留）
  maxTokens: 2048           # 摘要输出上限
  provider: ''              # 摘要调用的 provider（留空 = 跟源会话路由）
  model: ''                 # 摘要调用的 model（留空 = 跟源会话路由）
  cooldownMs: 60000         # 同一会话两次交接的最小间隔
  debug: true               # /status 是否返回逐会话 decision
  carryTasks: true          # 把待办 / 已改文件 / 上一个请求 / 后台任务搬进新会话
  autoContinue: auto        # auto | always | never：新会话是否自己接着跑
  continuePrompt: '继续…'   # 自动续跑时投递的那条消息
```

`autoContinue: auto`（默认）只在交接块里还有 `pending` / `in_progress` 项时才续跑；任务已全部完成就保持安静，不会无端消耗一次模型调用。

## HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/dsh-auto-handoff/status` | 配置、统计、handoff 记录、decisions、队列 |
| GET | `/api/dsh-auto-handoff/status?sessionId=...` | 该会话的 `turns / compactions / occupancy / jobs / prompts / queued`（UI 用它） |
| POST | `/api/dsh-auto-handoff/queue` | 用户点「交接」：立即执行，忙则 `202` 排队 |
| POST | `/api/dsh-auto-handoff/handoff` | 强制交接（源会话不静默时 `409`） |
| POST | `/api/dsh-auto-handoff/ui-config` | 写入提示阈值 / `autoHandoff`（持久化） |
| GET | `/api/dsh-auto-handoff/pending?sessionId=...` | 读取并清除「待切换」记录 |

```powershell
# 立刻交接当前会话（人也能用；源会话不静默时返回 409）
curl.exe -s -X POST http://127.0.0.1:3080/api/dsh-auto-handoff/queue `
  -H "content-type: application/json" `
  -d "{\"sessionId\":\"$env:DSH_SESSION_ID\"}"
```

## 隐私

- 生成摘要时，会把源会话最近一段消息（按 `maxInputChars` 截断，默认最多 2 万字符）**发给该会话配置的 provider/model**。这是唯一一次额外模型调用。
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

- `lib/index.js` —— 宿主半边（摘要、任务与后台任务折叠、建会话、HTTP 路由、时序校验）
- `lib/handover.js` —— 任务交接折叠（纯函数：todo / 已改文件 / 上一个请求 → 交接块）
- `lib/client.js` —— 浏览器半边（底栏胶囊 + 交接按钮 + 阈值面板 + 待切换轮询 + 自动 `openSession`）
- `cordis.patch.yml` —— 插件挂载声明
- `skill/SKILL.md` —— 随包分发的技能副本
- `test/run-tests.ps1` —— 测试入口（临时 junction + 三套测试 + 清理）
- `test/smoke.mjs` / `test/host-check.mjs` —— 静态自检 / 宿主半边集成检查
- `test/handover.test.mjs` —— 任务交接折叠的纯函数测试
- `CHANGELOG.md` —— 版本变更
- `LICENSE` —— MIT
