# push.ps1 — 提交改动并推送到 GitHub
#
# 用法：
#   .\push.ps1                      # 用时间做提交信息
#   .\push.ps1 修复别称识别崩溃       # 自定义提交信息

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Message
)

$ErrorActionPreference = 'Stop'

$msg = if ($Message -and $Message.Count -gt 0) { $Message -join ' ' } else { 'update: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }

# 第一次推送前需要先设置 remote
$hasRemote = (git remote 2>$null) -contains 'origin'
if (-not $hasRemote) {
  Write-Host "还没有设置 remote，先执行：" -ForegroundColor Yellow
  Write-Host "  git remote add origin https://github.com/ShanJun-pro-max/dsh-novel-studio.git"
  Write-Host "  git push -u origin main"
  exit 1
}

# 语法先过一遍，别把坏代码推上去
Write-Host "检查语法…"
foreach ($f in @('lib/index.js', 'lib/client.js', 'lib/server/api.js', 'lib/server/context.js', 'lib/server/distill.js', 'lib/server/summary.js', 'lib/server/pack-assemble.js')) {
  node --check $f
  if ($LASTEXITCODE -ne 0) {
    Write-Error "语法错误：$f —— 已中止推送"
    exit 1
  }
}
Write-Host "语法通过" -ForegroundColor Green

git add -A
$status = git status --porcelain
if (-not $status) {
  Write-Host "没有改动要提交。"
  exit 0
}

git commit -m $msg
git push

Write-Host ""
Write-Host "已推送：$msg" -ForegroundColor Green
Write-Host "如果要让本地 dsh 用上新代码，再跑一次 .\sync.ps1"
