# sync.ps1 — 把本仓库的代码同步到 dsh profile 的安装位置
#
# 为什么需要这个：
# 你的仓库在 D:\18708\Documents\dsh-novel-studio（可以 git push、不怕被清）
# 但 dsh 实际加载的是 ~/.dsh/profiles/web/node_modules/dsh-novel-studio
# 改完代码跑这个脚本，再重启 dsh web，改动就生效了。
#
# 用法：
#   .\sync.ps1

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\dsh-novel-workbench'

Write-Host "源: $src"
Write-Host "目标: $dst"

if (-not (Test-Path $dst)) {
  Write-Error "没找到安装位置。先运行：dsh plugin add github:ShanJun-pro-max/dsh-novel-workbench"
  exit 1
}

# 只同步代码，不碰 profile 自己的配置
$items = @('lib', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE')
foreach ($item in $items) {
  $from = Join-Path $src $item
  if (-not (Test-Path $from)) { continue }
  $to = Join-Path $dst $item
  if (Test-Path $from -PathType Container) {
    Copy-Item "$from\*" "$to\" -Recurse -Force
  } else {
    Copy-Item $from $to -Force
  }
  Write-Host "  同步 $item"
}

Write-Host ""
# 同步完就地体检：身份一致、每个模块能加载、客户端 bundle 能激活
Write-Host "体检安装副本…"
node "$PSScriptRoot\doctor.mjs" $dst
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "体检没过 —— 别急着重启，先看上面的 ✗" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "完成。重启 dsh web 后生效。" -ForegroundColor Green
