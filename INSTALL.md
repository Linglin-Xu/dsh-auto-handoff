# 安装与兼容性指南 · dsh-auto-handoff

> 这份文件随 npm 包一起分发，**人和 DSH 里的 AI 都可以按它操作**。
> 目标读者只有两类：① 想装这个插件的用户；② 被用户要求"帮我装一下"的 DSH Agent。

## 一、这是什么

DSH（DeepSeek Harness）的会话交接插件：**默认手动**，点输入框底栏的「交接」按钮，把当前对话压缩成交接文档（含未完成任务、已改文件、后台任务清单），在新会话里继续；底栏常驻 `轮数 / 占用 / 压缩次数` 状态胶囊，到阈值提醒，⚙ 里可改提示阈值。

## 二、兼容性结论（先看这个）

| 档位 | DSH 版本 | 状态 |
| --- | --- | --- |
| ✅ 实测 | **0.2.0-rc.2** | 宿主 + 底栏 UI 全流程跑过 |
| 🟢 完整预期 | **0.1.7-alpha.1 ~ 0.2.x**（含 0.2.1-alpha.*） | 用到的 API 全存在，`engines` 已声明；除 rc.2 外未实测 |
| 🟡 降级可用 | 0.1.0-rc.7 ~ 0.1.6 | 宿主半边正常；客户端缺 `[data-conversation-session]`，底栏胶囊显示「未就绪」，交接用 `POST /queue` 手动传 sessionId |
| 🔴 不保证 | ≤ 0.1.0-rc.6 | 缺 `ctx.jobs` / `contextPressure` / composer dock：后台任务不继承、占用未知、UI 退化 |

运行时要求：Node `^22.19 || >=24`。判断版本：`dsh --version`。

## 三、安装（任选一种）

装完都要：**重启 `dsh web`** → 浏览器 **Ctrl+Shift+R 硬刷新**。

### 方式 1：npm（推荐给用户）

```powershell
dsh plugin --profile web add dsh-auto-handoff
```

### 方式 2：GitHub

```powershell
dsh plugin --profile web add github:Linglin-Xu/dsh-auto-handoff
```

### 方式 3：本地 tgz（离线分发）

拿到 `dsh-auto-handoff-0.3.0.tgz` 后：

```powershell
dsh plugin --profile web add file:C:\path\to\dsh-auto-handoff-0.3.0.tgz
```

### 方式 4：本地目录（开发用，改代码即时生效）

```powershell
dsh plugin --profile web add link:E:\path\to\dsh-plugin-auto-handoff
```

> `desktop` profile 由 Electron 独占，CLI 的 `plugin add` 会拒绝；桌面版用户在 **插件 → 添加插件** 里填包名即可。

## 四、装完必做：安装技能（推荐）

npm 包里的技能**不会自动安装**，模型因此不知道何时提醒你交接。把包里的技能复制过去：

```powershell
# 找到包位置（npm 安装时通常在 profile 的 node_modules 下）
Copy-Item -Recurse "<包目录>\skill" "$env:USERPROFILE\.dsh\skills\auto-handoff"
```

```bash
# macOS / Linux
cp -r <包目录>/skill ~/.dsh/skills/auto-handoff
```

## 五、验证（30 秒）

```powershell
curl.exe -s http://127.0.0.1:3080/api/dsh-auto-handoff/status
```

- 返回 JSON 且 `"ok": true` → 宿主半边正常
- 页面上输入框底栏出现 `N 轮 · XX% · 压缩 N` + 「交接」 → 客户端正常
- 404 → 宿主没加载：检查 profile 的 `dependencies` 与 `dsh.profile.bundles` 是否都有 `dsh-auto-handoff`，确认 `dsh web` 真的重启过
- 接口 ok 但底栏没有胶囊 → 正常降级（见兼容表），交接仍可用：`POST /api/dsh-auto-handoff/queue {"sessionId":"..."}`

## 六、给 DSH Agent 的操作清单（可直接照做）

1. 读 DSH 版本（`dsh --version`），对照第二节表格：低于 `0.1.0-rc.7` 直接告知用户"不兼容，不要装"。
2. 选择安装方式：有 npm 源用方式 1，离线/内网用方式 3（tgz），要改代码用方式 4。
3. 安装命令失败时：把完整报错贴给用户，不要反复重试同一命令。
4. 安装成功后：
   - 复制技能（第四节）；
   - 提示用户重启 `dsh web` 并硬刷新页面（这一步 Agent 自己做不了）。
5. 重启后自检：`curl /api/dsh-auto-handoff/status` 必须 `ok:true`；再让用户确认输入框底栏胶囊存在。
6. 交接由用户点「交接」触发；**不要**在没有用户明确要求时调用 `POST /handoff` 自动交接。
7. 卸载：`dsh plugin --profile web remove dsh-auto-handoff`，并删除 `~/.dsh/skills/auto-handoff` 与 `~/.dsh/auto-handoff-ui.json`。

## 七、常见问题

| 现象 | 处理 |
| --- | --- |
| 底栏没有胶囊，但 `/status` 正常 | DSH 客户端结构变化或旧版本 → 降级；用 HTTP 接口交接 |
| 点「交接」没反应/提示会话未就绪 | 旧版 DSH 缺 `[data-conversation-session]`；升级 DSH |
| 提示"已经 N 轮（阈值 2 轮）" | 你之前把 `promptRounds` 存成了 2；点 ⚙ 改大 |
| 交接返回 `409 not-quiescent` | 源会话正在跑/有排队输入；等这一轮结束或稍后重试 |
| 交接返回 `502` | 摘要模型调用失败（路由/额度/超时），看返回值里的 message |
| 交接后新会话打不开/日志损坏 | 旧版本 bug；本版本已修（checkpoint 走 agent 收件箱，不再写坏 surface） |

## 八、升级 / 卸载

```powershell
# 升级
dsh plugin --profile web add dsh-auto-handoff
# 卸载
dsh plugin --profile web remove dsh-auto-handoff
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\auto-handoff"
Remove-Item -Force "$env:USERPROFILE\.dsh\auto-handoff-ui.json"
```

升级 DSH 之后先跑第五节的验证；配置与 UI 阈值都存在本机（`$DSH_HOME/auto-handoff-ui.json`），升级不丢。

## 九、隐私

生成摘要时会把源会话最近一段消息（默认最多 2 万字符，`maxInputChars`）发给该会话配置的 provider/model；后台任务快照（命令/输出尾巴）会写进交接文档并进入新会话上下文。插件不发遥测，不写 `$DSH_HOME` 之外的路径。

## 十、English quick reference

- **Requires** DSH `>=0.1.7-alpha.1 <0.3.0` (tested on `0.2.0-rc.2`), Node `^22.19 || >=24`.
- **Install**: `dsh plugin --profile web add dsh-auto-handoff`, then copy `skill/` into `~/.dsh/skills/auto-handoff`, restart `dsh web`, hard-refresh the browser.
- **Use**: click "交接" in the composer footer (manual by default), or `POST /api/dsh-auto-handoff/queue {"sessionId"}`.
- **Verify**: `curl http://127.0.0.1:3080/api/dsh-auto-handoff/status` → `{"ok":true}`.
- **Privacy**: the recent conversation (capped by `maxInputChars`) is sent once to the configured model to build the handoff summary.
