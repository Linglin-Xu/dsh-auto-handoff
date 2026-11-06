<#
发布 dsh-auto-handoff 到 GitHub：推送 main + tag，并按需创建 GitHub Release。

用法：
  # 1) 只推送（凭据由 Git Credential Manager 弹窗/系统凭据提供）
  .\publish-github.ps1

  # 2) 推送并用 PAT 自动创建 Release（附 npm tgz）
  $env:GH_TOKEN = 'github_pat_...'          # 不要写进命令行历史
  .\publish-github.ps1 -Release -Asset .\_dist\dsh-auto-handoff-0.4.0.tgz

  # 3) 只创建 Release（代码已推过）
  .\publish-github.ps1 -Release -SkipPush -Asset .\_dist\dsh-auto-handoff-0.4.0.tgz

说明：
  * 版本号与 tag 从 package.json 读取（v<version>），tag 不存在会自动创建。
  * PAT 只用于这一次 https 推送的 URL 与 Release API，不写进 .git/config；
    会话内用完即可 $env:GH_TOKEN = $null。
  * 需要的 PAT 权限：repo（私有仓库）或 public_repo；创建 Release 还需要 contents:write。
#>
[CmdletBinding()]
param(
  [string]$Repo = 'https://github.com/Linglin-Xu/dsh-auto-handoff.git',
  [string]$Token = $env:GH_TOKEN,
  [switch]$Release,
  [switch]$SkipPush,
  [string]$Asset,
  [string]$UserName = 'Linglin-Xu',
  [string]$Email = 'jadenwang111@outlook.com'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ---- 版本与 tag -------------------------------------------------------------
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
Write-Host "→ 版本 $version / tag $tag" -ForegroundColor Cyan

git config user.name $UserName
git config user.email $Email

$remotes = @(git remote)
if ($remotes -notcontains 'origin') { git remote add origin $Repo }
else { git remote set-url origin $Repo }

$dirty = git status --porcelain
if ($dirty) {
  Write-Host '工作区不干净，先提交：' -ForegroundColor Yellow
  git status --short | Out-Host
  git add -A
  git commit -m "release: $tag" | Out-Host
}
if (@(git tag --list $tag).Count -eq 0) {
  git tag -a $tag -m "dsh-auto-handoff $version"
  Write-Host "→ 已创建 tag $tag" -ForegroundColor Cyan
}

# ---- 推送 -------------------------------------------------------------------
if (-not $SkipPush) {
  if ($Token) {
    # 一次性 URL 推送：凭据不落盘（不要用 git remote set-url 带 token）
    $authUrl = $Repo -replace '^https://', "https://x-access-token:$Token@"
    Write-Host "→ 推送 main / $tag ..." -ForegroundColor Cyan
    git push $authUrl "HEAD:refs/heads/main"
    if ($LASTEXITCODE -ne 0) { throw "推送 main 失败（退出码 $LASTEXITCODE）" }
    git push $authUrl "refs/tags/$tag"
    if ($LASTEXITCODE -ne 0) { throw "推送 tag 失败（退出码 $LASTEXITCODE）" }
  }
  else {
    Write-Host '→ 未提供 GH_TOKEN，走系统凭据推送（可能弹窗）...' -ForegroundColor Cyan
    git push -u origin main
    if ($LASTEXITCODE -ne 0) { throw "推送 main 失败（退出码 $LASTEXITCODE）" }
    git push origin $tag
    if ($LASTEXITCODE -ne 0) { throw "推送 tag 失败（退出码 $LASTEXITCODE）" }
  }
  Write-Host '✅ 代码与 tag 已推送。' -ForegroundColor Green
}

# ---- Release ----------------------------------------------------------------
if ($Release) {
  if (-not $Token) { throw '创建 Release 需要 -Token 或 $env:GH_TOKEN（PAT）' }
  $slug = if ($Repo -match 'github\.com[:/]+([^/]+/[^/.]+?)(\.git)?/?$') { $Matches[1] } else { throw "无法从 $Repo 解析 owner/repo" }
  $body = if (Test-Path RELEASE_NOTES.md) { Get-Content RELEASE_NOTES.md -Raw } else { "dsh-auto-handoff $version" }
  $headers = @{ Authorization = "Bearer $Token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }

  $existing = $null
  try {
    $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$slug/releases/tags/$tag" -Headers $headers -Method Get
  }
  catch { $existing = $null }

  if ($existing) {
    Write-Host "→ Release $tag 已存在（$($existing.html_url)），只补资产。"
    $release = $existing
  }
  else {
    $payload = @{
      tag_name         = $tag
      name             = "dsh-auto-handoff $version — 手动会话交接"
      body             = $body
      draft            = $false
      prerelease       = $false
      generate_release_notes = $false
    } | ConvertTo-Json -Depth 4
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$slug/releases" -Headers $headers -Method Post -Body $payload -ContentType 'application/json'
    Write-Host "✅ Release 已创建：$($release.html_url)" -ForegroundColor Green
  }

  if ($Asset) {
    if (-not (Test-Path $Asset)) { throw "找不到资产：$Asset（先运行 npm pack）" }
    $item = Get-Item $Asset
    $uploadUrl = ($release.upload_url -replace '\{\?name,label\}$', '') + "?name=$([uri]::EscapeDataString($item.Name))"
    $raw = [System.IO.File]::ReadAllBytes($item.FullName)
    $uploadHeaders = @{ Authorization = "Bearer $Token"; Accept = 'application/vnd.github+json'; 'Content-Type' = 'application/octet-stream' }
    Invoke-RestMethod -Uri $uploadUrl -Headers $uploadHeaders -Method Post -Body $raw | Out-Null
    Write-Host "✅ 已上传资产：$($item.Name)" -ForegroundColor Green
  }
  else {
    Write-Host '提示：加 -Asset <tgz> 可把 npm 包附到 Release 上（npm pack 生成）。'
  }
}
