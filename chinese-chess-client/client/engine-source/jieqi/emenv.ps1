# ============================================================================
# emsdk environment loader (ASCII-only on purpose: PowerShell 5.1 mis-parses
# full-width quotes inside .ps1 on this machine).
#
# Why not `emsdk activate`? The official installer fails on this box with
#   [WinError 5] Access denied  (while unzipping emscripten/test/test_other.py)
# Workaround (see engine-source/jieqi/README.md):
#   1. git clone emsdk
#   2. unpack downloads/*wasm-binaries.zip with .NET ZipFile into <emsdk>/upstream
#   3. move upstream/install/* up one level into upstream/
# Then emcc/em++ are usable and env vars below drive them.
#
# Usage:  . .\emenv.ps1
# ============================================================================

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..\..\..')
$emsdk = Join-Path $repoRoot '_tmp\emsdk'

$emccPy = Join-Path $emsdk 'upstream\emscripten\emcc.py'
if (-not (Test-Path $emccPy)) {
  $msg = @(
    'emsdk not ready: ' + $emccPy + ' not found.',
    '',
    'Prepare emsdk as described in engine-source/jieqi/README.md:',
    '  1. git clone https://github.com/emscripten-core/emsdk _tmp/emsdk',
    '  2. cd _tmp/emsdk ; python emsdk.py install latest',
    '     (if it fails with WinError 5, unpack downloads/*wasm-binaries.zip',
    '      with .NET ZipFile into upstream\, then move upstream\install\* up)',
    '  3. re-run this script'
  ) -join [Environment]::NewLine
  throw $msg
}

$env:EMSDK = $emsdk
$env:EM_CONFIG = Join-Path $emsdk '.emscripten'
$env:EMSDK_PYTHON = Join-Path $emsdk 'python\3.13.3_64bit\python.exe'

$parts = @(
  (Join-Path $emsdk 'upstream\emscripten'),
  (Join-Path $emsdk 'upstream\bin'),
  (Join-Path $emsdk 'node\24.19.0_64bit\bin')
)
$env:PATH = (($parts -join ';') + ';' + $env:PATH)

Write-Host ('emsdk env loaded: ' + $emsdk)
