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
  Write-Host "  git remote add origin https://github.com/ShanJun-pro-max/dsh-novel-workbench.git"
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

# 一致性体检：包名 / 插件名 / loader id / 组合层 id / 打包清单必须对得上。
# 上次改名漏了 client.js 的 loader id，宿主就报「1 entry did not activate → import failed」，
# 整个 web 起不来，而 node --check 看不出来。
Write-Host "一致性体检…"
node check.mjs
if ($LASTEXITCODE -ne 0) {
  Write-Error "一致性体检没过 —— 已中止推送（详见上面的 ✗ 行）"
  exit 1
}

git add -A
$status = git status --porcelain
if (-not $status) {
  Write-Host "没有改动要提交。"
  exit 0
}

git commit -m $msg
if ($LASTEXITCODE -ne 0) {
  Write-Error "提交失败，已中止推送"
  exit 1
}

git push
if ($LASTEXITCODE -ne 0) {
  # 国内直连 github.com 常常不通，但系统代理可能开着而 git 不知道。
  # 这里自动找本地代理端口重试一次，不改 git 配置。
  Write-Host ""
  Write-Host "直连推送失败，尝试通过本地代理重试…" -ForegroundColor Yellow
  $retried = $false
  foreach ($port in @(7890, 7891, 1080, 10809, 8080)) {
    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $listening) { continue }
    Write-Host "  发现本地代理 $port，试用…"
    git -c "http.proxy=http://127.0.0.1:$port" -c "https.proxy=http://127.0.0.1:$port" push
    if ($LASTEXITCODE -eq 0) {
      $retried = $true
      Write-Host ""
      Write-Host "通过代理 $port 推送成功。想以后都走代理，执行：" -ForegroundColor Green
      Write-Host "  git config http.proxy http://127.0.0.1:$port"
      Write-Host "  git config https.proxy http://127.0.0.1:$port"
      break
    }
  }
  if (-not $retried) {
    Write-Error "推送失败：没找到可用代理，或代理也不通。检查网络、代理软件是否在跑，或 GitHub 登录状态。"
    exit 1
  }
}

Write-Host ""
Write-Host "已推送：$msg" -ForegroundColor Green
Write-Host "如果要让本地 dsh 用上新代码，再跑一次 .\sync.ps1"
