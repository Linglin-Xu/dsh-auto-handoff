# ============================================================
# dsh-auto-handoff 测试入口
#
# 为什么需要这个脚本（而不是直接 node test/xxx.mjs）：
#   插件在运行时通过 DSH 的 profile 模块回退（~/.dsh/profiles/node_modules）
#   解析 @deepseek-ai/*，而插件目录本身没有 node_modules。纯 Node 直接跑测试
#   会在 import '@deepseek-ai/cordis' 处报 ERR_MODULE_NOT_FOUND。
#
#   本脚本临时在插件目录下建立指向 DSH 安装位置的 junction，跑完两套测试后删除，
#   因此仓库里不留下任何指向外部路径的链接。
#
# 用法：powershell -ExecutionPolicy Bypass -File test\run-tests.ps1
# ============================================================

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path $PSScriptRoot -Parent
$linkRoot   = Join-Path $pluginRoot 'node_modules'
$linkScope  = Join-Path $linkRoot '@deepseek-ai'

# DSH 安装位置：优先用 $env:DSH_INSTALL，否则用默认 checkout
$install = if ($env:DSH_INSTALL) { $env:DSH_INSTALL } else { 'E:\dev\deepseek-harness' }
$profileModules = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules'

$targets = [ordered]@{
    'cordis'      = Join-Path $profileModules '@deepseek-ai\cordis'
    'schemastery' = Join-Path $install 'vendor\schemastery'
    'dsh-llm'     = Join-Path $install 'packages\llm\llm'
}

$created = $false
try {
    # 纯函数测试不需要 @deepseek-ai/*，先跑：即使后面建不了 junction 也能验证任务交接折叠。
    Write-Host ''
    Write-Host '=== 0/3 任务交接折叠（纯函数，无需依赖）===' -ForegroundColor Cyan
    node (Join-Path $PSScriptRoot 'handover.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw "handover.test.mjs 失败（退出码 $LASTEXITCODE）" }

    New-Item -ItemType Directory -Path $linkScope -Force | Out-Null
    foreach ($name in $targets.Keys) {
        $target = $targets[$name]
        if (-not (Test-Path $target)) { throw "找不到依赖 $name 的目标：$target" }
        $dest = Join-Path $linkScope $name
        if (-not (Test-Path $dest)) {
            New-Item -ItemType Junction -Path $dest -Target $target | Out-Null
            $created = $true
        }
    }

    Write-Host ''
    Write-Host '=== 1/3 静态自检（导入解析 / 设置 schema / 客户端 bundle）===' -ForegroundColor Cyan
    node (Join-Path $PSScriptRoot 'smoke.mjs')
    if ($LASTEXITCODE -ne 0) { throw "smoke.mjs 失败（退出码 $LASTEXITCODE）" }

    Write-Host ''
    Write-Host '=== 2/3 宿主半边集成检查（真实 Cordis + 假 DSH 服务）===' -ForegroundColor Cyan
    node (Join-Path $PSScriptRoot 'host-check.mjs')
    if ($LASTEXITCODE -ne 0) { throw "host-check.mjs 失败（退出码 $LASTEXITCODE）" }

    Write-Host ''
    Write-Host '全部测试通过。' -ForegroundColor Green
} finally {
    if ($created -and (Test-Path $linkRoot)) {
        Remove-Item $linkRoot -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host '已清理临时 junction。' -ForegroundColor DarkGray
    }
}
