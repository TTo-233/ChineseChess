# 象棋项目打包脚本（Windows / PowerShell 版，与 pack.sh 等价）
# 用法: pwsh -File pack.ps1 [client|server|all]   （默认 all）
# 产物: 仓库根目录 chinese-chess-{client|server}_YYYYMMDD.zip
# 排除: node_modules、.expo 缓存、dist/web-build 构建产物、.eslintcache 等无关文件
param([ValidateSet('client', 'server', 'all')][string]$Target = 'all')

$ErrorActionPreference = 'Stop'
$Date = Get-Date -Format yyyyMMdd
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $Root

function New-ClientZip {
  $out = "chinese-chess-client_$Date.zip"
  if (Test-Path $out) { Remove-Item $out }
  tar -a -c -f $out `
    --exclude 'chinese-chess-client/node_modules' `
    --exclude 'chinese-chess-client/client/node_modules' `
    --exclude 'chinese-chess-client/.expo' `
    --exclude 'chinese-chess-client/client/.expo' `
    --exclude 'chinese-chess-client/client/dist' `
    --exclude 'chinese-chess-client/client/web-build' `
    --exclude 'chinese-chess-client/.eslintcache' `
    --exclude 'chinese-chess-client/client/.eslintcache' `
    chinese-chess-client
  if ($LASTEXITCODE -ne 0) { throw "client 打包失败 (tar exit $LASTEXITCODE)" }
  $size = '{0:N1} MB' -f ((Get-Item $out).Length / 1MB)
  Write-Output "[OK] $out ($size)"
}

function New-ServerZip {
  $out = "chinese-chess-server_$Date.zip"
  if (Test-Path $out) { Remove-Item $out }
  # ⚠️ 服务端 dist/index.js 是手工打过补丁的构建产物（见 chinese-chess-server/scripts/patch-dist.mjs）。
  #    打包前强制校验，补丁丢失（重新构建/换版覆盖）时直接阻塞出包，避免把
  #    「已废弃的禁着拦截 + 连续 3 次判负」逻辑打进部署包。
  & node chinese-chess-server/scripts/patch-dist.mjs --check
  if ($LASTEXITCODE -ne 0) {
    throw "服务端补丁校验失败，已阻塞打包。请先执行：node chinese-chess-server/scripts/patch-dist.mjs"
  }
  # 注意：服务端 dist/index.js 是唯一可运行主体，ai\ 为引擎与开局库，必须保留
  tar -a -c -f $out `
    --exclude 'chinese-chess-server/node_modules' `
    chinese-chess-server
  if ($LASTEXITCODE -ne 0) { throw "server 打包失败 (tar exit $LASTEXITCODE)" }
  $size = '{0:N1} MB' -f ((Get-Item $out).Length / 1MB)
  Write-Output "[OK] $out ($size)"
}

switch ($Target) {
  'client' { New-ClientZip }
  'server' { New-ServerZip }
  'all' { New-ClientZip; New-ServerZip }
}
