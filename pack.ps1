# 象棋项目打包脚本（Windows / PowerShell 版，与 pack.sh 等价）
# 用法: powershell -File pack.ps1 [client|server|all]   （默认 all）
#       pwsh -File pack.ps1 [client|server|all]
# 产物: 仓库根目录 chinese-chess-{client|server}_YYYYMMDD.zip
# 排除: node_modules、缓存（.expo/.eslintcache/coverage/.cache/.turbo/.parcel-cache）、
#       构建产物（dist/web-build/build）、日志、编辑器目录、OS 杂项
# 清理: 每次打包会先删除「该端」的历史 zip（只删同前缀，client 与 server 互不影响），
#       仓库根目录始终只保留每个端当天的这一个包，避免旧包被误当成最新包分发。
param([ValidateSet('client', 'server', 'all')][string]$Target = 'all')

$ErrorActionPreference = 'Stop'
$Date = Get-Date -Format yyyyMMdd
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location $Root

# 与 pack.sh 保持一致的「不入包」清单。tar 是 Windows 自带的 bsdtar，
# `--exclude` 用 glob 匹配完整路径片段，所以每条都要写到能命中路径的那一段。
#
# ⚠️ 不要往这里随手加东西：入包内容 = 用户拿到手就能跑的东西。
#    库里被跟踪的文件都在用（含 patches/、verify-*.mjs 自检脚本、部署说明、.bat 启动器），
#    误排会让部署包缺件；这里只排「本机产生的、与运行无关的」垃圾。
#    服务端 dist/index.js 与 ai/ 是唯一可运行主体与引擎，绝不能排。
$ExcludeCommon = @(
  '--exclude', '.DS_Store',
  '--exclude', 'Thumbs.db',
  '--exclude', 'ehthumbs.db',
  '--exclude', '__pycache__',
  '--exclude', '*.pyc',
  '--exclude', '*.log',
  '--exclude', '*.log.*',
  '--exclude', 'logs',
  '--exclude', '*.tsbuildinfo',
  '--exclude', '.eslintcache',
  '--exclude', 'coverage',
  '--exclude', '.cache',
  '--exclude', '.turbo',
  '--exclude', '.parcel-cache',
  '--exclude', '.vscode',
  '--exclude', '.idea',
  '--exclude', '*.iml',
  '--exclude', '.git'
)

# 删除指定端的历史打包文件（保留当天那个，由后续打包重新生成）
# -Filter 'chinese-chess-client_*.zip' 只匹配 client 前缀，不会误删 server 的包
function Remove-OldZip {
  param([Parameter(Mandatory)][string]$Prefix)
  $old = Get-ChildItem -Path $Root -Filter "$Prefix`_*.zip" -File -ErrorAction SilentlyContinue
  if (-not $old) { return }
  foreach ($f in $old) {
    Remove-Item $f.FullName -Force
    Write-Output "[CLEAN] 已删除历史包 $($f.Name)"
  }
}

# 出包后自检：确认缓存/构建垃圾没被打进去。发现即失败（不静默出包），
# 因为「zip 里混了本机缓存」正是本脚本要根治的问题。
function Assert-NoJunk {
  param([Parameter(Mandatory)][string]$Zip)
  $junkPattern = '(^|/)(node_modules|\.expo|\.expo-shared|coverage|\.cache|\.turbo|\.parcel-cache|\.vscode|\.idea|\.git)(/|$)'
  $junk = & tar -tf $Zip | Where-Object {
    $_ -match $junkPattern -or $_ -match '\.(log|tsbuildinfo|eslintcache|DS_Store)$'
  }
  if ($junk) {
    throw "「$Zip」里混入了缓存/构建产物：`n  $($junk -join "`n  ")`n请补 --exclude 规则后重打。"
  }
}

function New-ClientZip {
  $out = "chinese-chess-client_$Date.zip"
  if (Test-Path $out) { Remove-Item $out }
  Remove-OldZip 'chinese-chess-client'
  $tarArgs = @('-a', '-c', '-f', $out) + $ExcludeCommon + @(
    '--exclude', 'chinese-chess-client/node_modules',
    '--exclude', 'chinese-chess-client/client/node_modules',
    '--exclude', 'chinese-chess-client/client/.expo',
    '--exclude', 'chinese-chess-client/client/dist',
    '--exclude', 'chinese-chess-client/client/web-build',
    '--exclude', 'chinese-chess-client/client/build',
    'chinese-chess-client'
  )
  & tar @tarArgs
  if ($LASTEXITCODE -ne 0) { throw "client 打包失败 (tar exit $LASTEXITCODE)" }
  Assert-NoJunk $out
  $size = '{0:N1} MB' -f ((Get-Item $out).Length / 1MB)
  Write-Output "[OK] $out ($size)"
}

function New-ServerZip {
  $out = "chinese-chess-server_$Date.zip"
  if (Test-Path $out) { Remove-Item $out }
  Remove-OldZip 'chinese-chess-server'
  # 服务端 dist/index.js 现在由 chinese-chess-server/src/ 经 `node build.js` 生成（esbuild）。
  #    打包前强制校验「已提交的 dist/index.js 与重新构建的结果一致」，这样：
  #      - dist 被手工改过 / 被旧产物覆盖过 → 直接阻塞出包；
  #      - 6 条加固（长将长捉不拦截、畸形 FEN 行宽、初始局面上传收紧、被拒动作回推权威状态、
  #        房间名最小空缺优先）都在 src/ 里，不可能像以前那样「补丁丢了却照样出包」。
  Push-Location chinese-chess-server
  & node build.js --check
  $checkExit = $LASTEXITCODE
  Pop-Location
  if ($checkExit -ne 0) {
    throw "服务端 dist 与 src/ 不一致，已阻塞打包。请在 chinese-chess-server 下执行：node build.js"
  }
  # 注意：服务端 dist/index.js 是唯一可运行主体，ai\ 为引擎与开局库，必须保留
  $tarArgs = @('-a', '-c', '-f', $out) + $ExcludeCommon + @(
    '--exclude', 'chinese-chess-server/node_modules',
    'chinese-chess-server'
  )
  & tar @tarArgs
  if ($LASTEXITCODE -ne 0) { throw "server 打包失败 (tar exit $LASTEXITCODE)" }
  Assert-NoJunk $out
  $size = '{0:N1} MB' -f ((Get-Item $out).Length / 1MB)
  Write-Output "[OK] $out ($size)"
}

switch ($Target) {
  'client' { New-ClientZip }
  'server' { New-ServerZip }
  'all' { New-ClientZip; New-ServerZip }
}
