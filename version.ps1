# version.ps1 — 一次改完两处版本号
#
# 为什么需要：版本号写在两个地方
#   package.json          "version": "2.5.0"
#   lib/client.js         'v2.5'          ← 界面左下角显示的
# 漏改一个，用户就会以为没更新。
#
# 用法：
#   .\version.ps1 2.6.0

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$NewVersion
)

$ErrorActionPreference = 'Stop'

# 校验格式：必须 x.y.z
if ($NewVersion -notmatch '^\d+\.\d+\.\d+$') {
  Write-Error "版本号格式要是 x.y.z，比如 2.6.0（收到：$NewVersion）"
  exit 1
}

$root = $PSScriptRoot
$pkgPath = Join-Path $root 'package.json'
$clientPath = Join-Path $root 'lib\client.js'

# 界面与 package.json 保持一致，都用完整版本号

# ── 1) package.json ──
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8
$pkgMatch = [regex]::Match($pkg, '"version"\s*:\s*"([^"]+)"')
if (-not $pkgMatch.Success) { Write-Error "package.json 里找不到 version"; exit 1 }
$oldPkgVersion = $pkgMatch.Groups[1].Value
$pkg = $pkg -replace '"version"\s*:\s*"[^"]+"', ('"version": "' + $NewVersion + '"')
[System.IO.File]::WriteAllText($pkgPath, $pkg, (New-Object System.Text.UTF8Encoding $false))

# ── 2) lib/client.js 里的版本显示 ──
$client = Get-Content $clientPath -Raw -Encoding UTF8
$clientMatch = [regex]::Match($client, "'v(\d+\.\d+(?:\.\d+)?)'")
if (-not $clientMatch.Success) { Write-Error "lib/client.js 里找不到版本号显示"; exit 1 }
$oldClientVersion = $clientMatch.Groups[1].Value
$client = $client -replace "'v\d+\.\d+\.\d+'", ("'v" + $NewVersion + "'")
[System.IO.File]::WriteAllText($clientPath, $client, (New-Object System.Text.UTF8Encoding $false))

# ── 校验 ──
node --check $clientPath
if ($LASTEXITCODE -ne 0) { Write-Error "改完 client.js 语法有问题，请检查"; exit 1 }

Write-Host "package.json : $oldPkgVersion → $NewVersion"
Write-Host "lib/client.js: v$oldClientVersion → v$NewVersion"
Write-Host ""
Write-Host "改好了。下一步：" -ForegroundColor Green
Write-Host "  .\push.ps1 发布 v$NewVersion"
Write-Host "  .\sync.ps1"
