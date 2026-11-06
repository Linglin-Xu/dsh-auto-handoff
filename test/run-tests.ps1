# ============================================================
# dsh-auto-handoff 测试入口
#
# 为什么需要这个脚本（而不是直接 node test/xxx.mjs）：
#   插件在部署时通过 DSH profile 的 node_modules 解析 @deepseek-ai/*，
#   而插件目录本身没有 node_modules。纯 Node 直接跑会在
#   import '@deepseek-ai/cordis' 处报 ERR_MODULE_NOT_FOUND。
#
#   v0.4.0 起不再在插件目录里临时创建 junction（那需要管理员权限 / 不受限的
#   文件系统沙箱），改由 test/resolve-install.mjs 注册 Node 解析钩子，把
#   @deepseek-ai/* 回退到真实安装目录。本脚本只负责找到那个目录并依次跑测试。
#
# 依赖解析顺序（见 resolve-install.mjs）：
#   1. $env:DSH_INSTALL（指向已安装的 @deepseek-ai/dsh 包目录）
#   2. ~/.dsh/profiles/{web,default}/node_modules
#   3. %APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File test\run-tests.ps1
#   $env:DSH_INSTALL='C:\path\to\node_modules\@deepseek-ai\dsh'; npm test
# ============================================================

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path $PSScriptRoot -Parent

function Test-Peers([string] $dir) {
    if ([string]::IsNullOrWhiteSpace($dir)) { return $false }
    return (Test-Path (Join-Path $dir '@deepseek-ai\cordis')) -and
           (Test-Path (Join-Path $dir '@deepseek-ai\schemastery')) -and
           (Test-Path (Join-Path $dir '@deepseek-ai\dsh-llm'))
}

function Find-ModulesDir {
    $candidates = @()
    if ($env:DSH_INSTALL) {
        $candidates += (Join-Path $env:DSH_INSTALL 'node_modules')
        $candidates += $env:DSH_INSTALL
    }
    $homeProfile = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    foreach ($profile in @('web', 'default')) {
        $candidates += (Join-Path $homeProfile "profiles\$profile\node_modules")
    }
    if ($env:APPDATA) {
        $candidates += (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules')
    }
    foreach ($dir in $candidates) {
        if (Test-Peers $dir) { return $dir }
    }
    return $null
}

$modulesDir = Find-ModulesDir
if (-not $modulesDir) {
    Write-Host '找不到 @deepseek-ai/{cordis,schemastery,dsh-llm}。' -ForegroundColor Yellow
    Write-Host '请设置 $env:DSH_INSTALL 指向已安装的 @deepseek-ai/dsh 目录，例如：' -ForegroundColor Yellow
    Write-Host '  $env:DSH_INSTALL = "C:\Users\<you>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh"' -ForegroundColor Yellow
    exit 1
}
Write-Host "依赖解析目录：$modulesDir" -ForegroundColor DarkGray

$suites = @(
    @{ Name = '1/5 任务交接折叠（纯函数）';            File = 'handover.test.mjs' },
    @{ Name = '2/5 会话计数器（纯函数）';              File = 'metrics.test.mjs' },
    @{ Name = '3/5 摘要回放 + 交接文档（纯函数）';     File = 'checkpoint.test.mjs' },
    @{ Name = '4/5 静态自检（导入 / schema / 客户端 bundle）'; File = 'smoke.mjs' },
    @{ Name = '5/5 宿主半边集成检查（真实 Cordis + 假 DSH 服务）'; File = 'host-check.mjs' }
)

foreach ($suite in $suites) {
    Write-Host ''
    Write-Host "=== $($suite.Name) ===" -ForegroundColor Cyan
    node (Join-Path $PSScriptRoot $suite.File)
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host "失败：$($suite.File)（退出码 $LASTEXITCODE）" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host ''
Write-Host "全部测试通过。（插件目录：$pluginRoot）" -ForegroundColor Green
