# sync.ps1 — 把「仓库里的改动」变成「dsh 真正加载的那份东西」
#
# 历史教训（这段别删）：
# 早先这个脚本是把仓库的 lib/ 直接 Copy-Item 进
#   ~/.dsh/profiles/web/node_modules/dsh-novel-workbench
# 看着立刻生效，可那个目录是 pnpm 装的：node_modules/.modules.yaml 里记着
# 它的版本号（如 dsh-novel-workbench@3.0.4）。手抄进去的新文件一旦版本号变了，
# 安装目录和 pnpm 的账本就对不上——宿主启动时加载这个条目失败，浏览器只显
# 一句「1 entry did not activate → import failed」，整个 web 起不来。
# 这个坑踩了两次（v3.0.2、v3.0.4）。
#
# 所以规则只有一条：**安装目录里的东西只能由 pnpm 写，人不许手抄。**
# 本地改动要生效，走「发版 → 让 pnpm 拉最新」这条路。
#
# 用法：
#   .\sync.ps1            体检 + 拉最新 + 体检安装副本 + 接口冒烟（不发版）
#   .\sync.ps1 -Publish   体检 + 发 npm + 拉最新 + 体检安装副本 + 接口冒烟

param(
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\web'
$installed = Join-Path $profile 'node_modules\dsh-novel-workbench'

# 1) 身份一致性（包名 / 插件名 / loader id / 组合层 id / 打包清单）
Write-Host "=== 1/5 身份一致性 ===" -ForegroundColor Cyan
node "$root\check.mjs"
if ($LASTEXITCODE -ne 0) {
  Write-Host "身份对不上，先修好再走下一步。" -ForegroundColor Red
  exit 1
}

# 2) 可选：发到 npm
if ($Publish) {
  Write-Host "`n=== 2/5 发布到 npm ===" -ForegroundColor Cyan
  Push-Location $root
  npm publish --access public
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Write-Host "npm 发布失败（看上面报错；常见是 token 过期或要求 2FA）。" -ForegroundColor Red
    exit 1
  }
  Pop-Location
  Write-Host "npm 已上传，registry 生效通常要等 1—2 分钟。" -ForegroundColor Yellow
}

# 3) 让 pnpm 拉最新 —— 唯一正确的安装方式
Write-Host "`n=== 3/5 让 pnpm 更新安装副本 ===" -ForegroundColor Cyan
Push-Location $profile
cmd /c "dsh plugin --profile web update dsh-novel-workbench"
$updateCode = $LASTEXITCODE
Pop-Location
if ($updateCode -ne 0) {
  Write-Host "更新失败。切记：不要手抄文件进 node_modules —— 上次启动崩溃就是那么来的。" -ForegroundColor Red
  exit 1
}

# 4) 体检安装副本（身份、模块加载、客户端 bundle 激活）
Write-Host "`n=== 4/5 体检安装副本 ===" -ForegroundColor Cyan
if (-not (Test-Path $installed)) {
  Write-Host "安装目录不存在：$installed" -ForegroundColor Red
  exit 1
}
node "$root\doctor.mjs" $installed
if ($LASTEXITCODE -ne 0) {
  Write-Host "`n体检没过 —— 别急着重启，先看上面的 ✗" -ForegroundColor Red
  exit 1
}

# 5) 接口冒烟（只读，不动稿子）
Write-Host "`n=== 5/5 接口冒烟 ===" -ForegroundColor Cyan
Push-Location $profile
node "$root\smoke.mjs"
$smokeCode = $LASTEXITCODE
Pop-Location
if ($smokeCode -ne 0) {
  Write-Host "`n冒烟有失败项，先别重启。" -ForegroundColor Red
  exit 1
}

Write-Host "`n全部通过。重启 dsh web 即生效。" -ForegroundColor Green
