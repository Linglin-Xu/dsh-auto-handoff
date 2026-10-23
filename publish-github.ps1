<#
发布 dsh-auto-handoff 到 GitHub

用法（三步）：
  1) 先在 GitHub 网页创建一个【空仓库】：https://github.com/new
     名字填 dsh-auto-handoff，**不要**勾选 README / .gitignore / license
  2) 在本目录运行：
       .\publish-github.ps1 -Repo https://github.com/<你的账号>/dsh-auto-handoff.git
     首次推送会弹出 GitHub 登录窗口（Git Credential Manager），登录你自己的账号即可；
     之后同样仓库的推送可能不再询问。
  3) 推送成功后，按脚本最后打印的提示，在 Releases 页面上传 npm pack 生成的 tgz。

说明：本仓库的提交身份已设为 Linglin-Xu <jadenwang111@outlook.com>（仅本仓库生效，不影响全局）；
     如果你的 GitHub 账号与这个邮箱不一致，请把下面 -Email 参数改成你自己的公开邮箱或
     GitHub noreply 地址，避免真实姓名/私人邮箱进入提交历史。
#>
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Tag = "v0.3.0",
  [string]$UserName = "Linglin-Xu",
  [string]$Email = "jadenwang111@outlook.com"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 1) 提交身份（仅本仓库）
git config user.name $UserName
git config user.email $Email

# 2) 绑定远程仓库
$remotes = @(git remote)
if ($remotes -notcontains "origin") {
  git remote add origin $Repo
} else {
  git remote set-url origin $Repo
}

# 3) 确保提交与 tag 存在
$status = git status --porcelain
if ($status) {
  git add -A
  git commit -m "release: $Tag" | Out-Host
}
$hasTag = @(git tag --list $Tag).Count -gt 0
if (-not $hasTag) { git tag -a $Tag -m "dsh-auto-handoff $($Tag.TrimStart('v'))" }

# 4) 推送（这一步会触发凭据弹窗）
Write-Host "`n→ 推送 main..." -ForegroundColor Cyan
git push -u origin main
Write-Host "→ 推送 tag $Tag..." -ForegroundColor Cyan
git push origin $Tag

# 5) 打印后续步骤
Write-Host "`n✅ 代码与 tag 已推送。" -ForegroundColor Green
Write-Host "下一步（在网页上完成）："
Write-Host "  1) 打开 $Repo/releases/new ，选择 tag $Tag"
Write-Host "  2) 标题：dsh-auto-handoff $($Tag.TrimStart('v')) — 手动交接 + 输入框底栏状态"
Write-Host "  3) 正文：粘贴本仓库 RELEASE_NOTES.md 的内容"
Write-Host "  4) 附件：上传 npm pack 生成的 dsh-auto-handoff-0.3.0.tgz（在本目录执行 npm pack）"
Write-Host ""
Write-Host "如果第 4 步的 tgz 还没有，可先运行： npm pack"
