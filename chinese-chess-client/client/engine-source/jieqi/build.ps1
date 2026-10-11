#!/usr/bin/env pwsh
# ============================================================================
# 揭棋引擎（jieqi_old）→ WASM 构建脚本
#
#   前置：1) 克隆源码   git clone -b jieqi_old --depth 1 \
#                          https://github.com/official-pikafish/Pikafish _tmp/pf
#           2) 应用单线程适配补丁   node apply-wasm-patches.cjs _tmp/pf/src
#           3) 安装 emsdk 并执行 .\emenv.ps1
#
#   用法： .\build.ps1
#   产物： jieqi.js / jieqi.wasm（release，classical 评估，无需权重）
# ============================================================================
$ErrorActionPreference = 'Continue'   # emcc 会把 INFO/WARNING 写 stderr，PowerShell 会误判为错误；只信 $LASTEXITCODE
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$repoRoot = Resolve-Path (Join-Path $here '..\..\..\..')   # -> D:\Code\ChineseChess
$src      = Join-Path $repoRoot '_tmp\pf\src'
$buildDir = Join-Path $here '..\build'

if (-not (Test-Path (Join-Path $src 'uci.cpp'))) {
  throw "找不到源码：$src`n请先 git clone -b jieqi_old --depth 1 https://github.com/official-pikafish/Pikafish _tmp/pf 并执行 node apply-wasm-patches.cjs _tmp/pf/src"
}

. (Join-Path $here 'emenv.ps1')
$emxx = Join-Path $env:EMSDK 'upstream\emscripten\em++.py'

# 完整 SRCS（同上游 Makefile；含 nnue 与 zip 模块，缺它们链接会失败）
$cpps = @(
  'benchmark.cpp','bitboard.cpp','evaluate.cpp','main.cpp','material.cpp',
  'misc.cpp','movegen.cpp','movepick.cpp','position.cpp','psqt.cpp',
  'search.cpp','thread.cpp','timeman.cpp','tt.cpp','uci.cpp','ucioption.cpp','tune.cpp',
  'nnue/evaluate_nnue.cpp','nnue/features/half_ka_v2_hm.cpp','compression/zip.cpp'
)

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
$objs = @()
foreach ($c in $cpps) {
  $name  = ($c -replace '[\\/]','_') -replace '\.cpp$','.o'
  $o     = Join-Path $buildDir $name
  Write-Host "  CC $c"
  python $emxx (Join-Path $src $c) -c -o $o `
      -std=c++17 -O2 -DNDEBUG -DUSE_NNUEEVAL=0 -DNO_PREFETCH -DIS_64BIT -fno-exceptions 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "编译失败: $c" }
  $objs += $o
}

Write-Host "链接 $($objs.Count) 个目标文件…"
python $emxx $objs -o (Join-Path $buildDir 'jieqi.js') `
  -O2 -s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB -s STACK_SIZE=3MB `
  -s EXPORTED_FUNCTIONS="['_main']" `
  -s ENVIRONMENT=node,web,worker -s MODULARIZE=1 -s EXPORT_NAME=PikaJieqi `
  -s EXIT_RUNTIME=0 `
  -s INCOMING_MODULE_JS_API="['stdin','print','printErr','locateFile','noInitialRun','wasmBinary']"
if ($LASTEXITCODE -ne 0) { throw "链接失败" }

Copy-Item (Join-Path $buildDir 'jieqi.js')  (Join-Path $here 'jieqi.js')  -Force
Copy-Item (Join-Path $buildDir 'jieqi.wasm') (Join-Path $here 'jieqi.wasm') -Force

Write-Host ""
Write-Host "完成："
Write-Host ("  jieqi.wasm  {0} B" -f (Get-Item (Join-Path $here 'jieqi.wasm')).Length)
Write-Host "  下一步：node client/scripts/gen-jieqi-host.mjs  然后 node verify.cjs"
