# dsh-auto-handoff v0.3.0 — 手动交接 + 输入框底栏状态

**默认手动**：点输入框底栏的「交接」按钮，把当前对话压缩成交接文档（含未完成任务、已改文件、后台任务清单），在新会话里继续。正在跑的那一轮会自动排队到结束，**不会被打断**。

## 亮点

- 🖱️ **手动触发**：底栏「交接」按钮 / `POST /api/dsh-auto-handoff/queue`；空闲立即执行，忙则排队到本轮结束
- 📊 **状态胶囊**：`压缩 N · N 轮 · XX%`，优先级 **压缩 > 轮 > 占用**（红 > 琥珀 > 蓝），到阈值弹一次提示（只提示，不自动切换）
- ⚙️ **阈值面板**：轮数 / 占用% / 压缩次数，保存到 `$DSH_HOME/auto-handoff-ui.json`，重启不丢
- 🧵 **后台任务继承**：交接文档快照运行中的后台 job 与存活子会话；交接后监听源会话 job 事件，结束时把终态 + 输出尾巴转发到新会话
- 🛡️ **时序保证**：只在源会话静默时交接（无未结束 turn / 无压缩 / 无排队输入），摘要前后各校验一次内容指纹，过期就整次作废重来
- 🔧 **兼容**：DSH `>=0.1.7-alpha.1 <0.3.0`（实测 `0.2.0-rc.2`）；`session.events`、`tokenMeter` 旧字段、`agent.inbox.append` 都有兜底
- 🐛 **修复**：① 交接出的新会话日志不可读、无法 resume；② 占用判定读旧 API 导致自动阈值从不触发

## 安装

```powershell
dsh plugin --profile web add dsh-auto-handoff
# 或从 GitHub
dsh plugin --profile web add github:Linglin-Xu/dsh-auto-handoff
# 或下载下方 tgz 后
dsh plugin --profile web add file:C:\path\dsh-auto-handoff-0.3.0.tgz
```

装完三步：**复制技能**（包内 `skill/` → `~/.dsh/skills/auto-handoff/`）、**重启 `dsh web`**、**浏览器 Ctrl+Shift+R**。

## 验证

```powershell
curl.exe -s http://127.0.0.1:3080/api/dsh-auto-handoff/status
```

返回 `{"ok":true}` 即宿主正常；输入框底栏出现 `压缩 0 · N 轮 · XX%` + 「交接」说明 UI 也好了。

## 兼容性

| 档位 | DSH 版本 |
| --- | --- |
| ✅ 实测 | 0.2.0-rc.2 |
| 🟢 完整预期 | 0.1.7-alpha.1 ~ 0.2.x |
| 🟡 降级可用 | 0.1.0-rc.7 ~ 0.1.6（客户端 UI 受限，交接仍可走 HTTP） |
| 🔴 不保证 | ≤ 0.1.0-rc.6 |

详细说明与排障见 [INSTALL.md](INSTALL.md)。

## 隐私

生成摘要时会把源会话最近一段消息（默认最多 2 万字符）发给你配置的模型；后台任务快照会写进交接文档并进入新会话上下文。插件无遥测，不写 `$DSH_HOME` 之外的路径。

**完整变更记录**：[CHANGELOG.md](CHANGELOG.md)
