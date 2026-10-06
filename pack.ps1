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
  '--exclude', '.git',
  # 【I-12】环境配置绝不入包：本仓库大量读 process.env.EXPO_PUBLIC_* / SERVER_PORT，
  # 客户端 .gitignore 里也把 .env 列为忽略项，说明工作机上很可能存在这类文件。
  '--exclude', '.env',
  '--exclude', '.env.*',
  '--exclude', '*.env',
  # 【I-24】差分闸门 verify-server-diff.cjs 会在 chinese-chess-server/.verify-old/ 下留一份
  # 1.4MB 的旧 dist 产物（--keep / 被强杀 / 中途 throw 都会留下），它不是可运行主体，
  # 混进部署包极易被误用。
  '--exclude', '.verify-old'
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
    # 【I-12】.env / .env.local / *.env —— 排除项漏了时由这里兜底，宁可误报也不放过
    # 【I-24】.verify-old —— 差分闸门留下的旧 dist 产物
    $_ -match $junkPattern `
      -or $_ -match '\.(log|tsbuildinfo|eslintcache|DS_Store)$' `
      -or $_ -match '(^|/)\.env($|\.)' `
      -or $_ -match '\.env$' `
      -or $_ -match '(^|/)\.verify-old(/|$)'
  }
  if ($junk) {
    throw "「$Zip」里混入了缓存/构建产物/环境配置：`n  $($junk -join "`n  ")`n请补 --exclude 规则后重打。"
  }
}

# 【I-11】校验 dist 与 src/ 必须在删旧包之前。
# 以前 New-ServerZip 先 `Remove-Item $out` + `Remove-OldZip` 再跑 `node build.js --check`，
# 于是校验失败时「上一版可用包已被删掉、新包又没生成」——该端直接零包，且无法回滚。
# 这里把校验提成独立步骤，由调用方在任何删除动作之前执行。
function Assert-ServerDistFresh {
  Push-Location chinese-chess-server
  & node build.js --check
  $checkExit = $LASTEXITCODE
  Pop-Location
  if ($checkExit -ne 0) {
    throw "服务端 dist 与 src/ 不一致，已阻塞打包。请在 chinese-chess-server 下执行：node build.js"
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
    # 棋盘设计源图（assets/boards/_source/，约 5.8MB）只用于用
    # `python scripts/board_assets.py build --all` 重新生成索引色 PNG，
    # 不是运行所需，不随部署包分发。
    '--exclude', 'chinese-chess-client/client/assets/boards/_source',
    'chinese-chess-client'
  )
  & tar @tarArgs
  if ($LASTEXITCODE -ne 0) { throw "client 打包失败 (tar exit $LASTEXITCODE)" }
  Assert-NoJunk $out
  $size = '{0:N1} MB' -f ((Get-Item $out).Length / 1MB)
  Write-Output "[OK] $out ($size)"
}

function New-ServerZip {
  # 服务端 dist/index.js 现在由 chinese-chess-server/src/ 经 `node build.js` 生成（esbuild）。
  #    打包前强制校验「已提交的 dist/index.js 与重新构建的结果一致」，这样：
  #      - dist 被手工改过 / 被旧产物覆盖过 → 直接阻塞出包；
  #      - 6 条加固（长将长捉不拦截、畸形 FEN 行宽、初始局面上传收紧、被拒动作回推权威状态、
  #        房间名最小空缺优先）都在 src/ 里，不可能像以前那样「补丁丢了却照样出包」。
  #    校验放在删旧包之前（switch 里调用 Assert-ServerDistFresh），失败时上一版可用包仍在。
  # 注意：服务端 dist/index.js 是唯一可运行主体，ai\ 为引擎与开局库，必须保留
  $out = "chinese-chess-server_$Date.zip"
  if (Test-Path $out) { Remove-Item $out }
  Remove-OldZip 'chinese-chess-server'
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

# 【I-11】'all' 模式下服务端校验必须早于 New-ServerZip 的任何删除动作。
# 以前校验写在 New-ServerZip 内部、且排在 Remove-OldZip 之后：`pack.ps1 all` 先打完 client 包，
# 随后服务端校验失败时 root 里上一版 server 包已被删掉 → 该端零包且无法回滚。
# 现在把校验提前到 switch 的最前面：任一端校验不过就整轮中止，此时磁盘上仍是上一版可用包。
$needServerCheck = ($Target -eq 'server' -or $Target -eq 'all')
if ($needServerCheck) { Assert-ServerDistFresh }

switch ($Target) {
  'client' { New-ClientZip }
  'server' { New-ServerZip }
  'all' { New-ClientZip; New-ServerZip }
}
