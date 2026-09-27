#!/usr/bin/env bash
# 象棋项目打包脚本
# 用法: ./pack.sh [client|server|all]   （默认 all）
# 产物: /workspace/chinese-chess-{client|server}_YYYYMMDD.zip
set -euo pipefail
DATE="$(date +%Y%m%d)"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

pack_client() {
  local out="chinese-chess-client_${DATE}.zip"
  rm -f "$out"
  # 排除依赖、缓存与本地构建产物（node_modules 可由 pnpm install 恢复）
  zip -qr "$out" chinese-chess-client \
    -x 'chinese-chess-client/node_modules/*' \
       'chinese-chess-client/client/node_modules/*' \
       'chinese-chess-client/.expo/*' \
       'chinese-chess-client/client/.expo/*' \
       'chinese-chess-client/client/dist/*' \
       'chinese-chess-client/client/web-build/*' \
       'chinese-chess-client/.eslintcache' \
       'chinese-chess-client/client/.eslintcache'
  echo "[OK] $out ($(du -h "$out" | cut -f1))"
}

pack_server() {
  local out="chinese-chess-server_${DATE}.zip"
  rm -f "$out"
  # ⚠️ 服务端 dist/index.js 是手工打过补丁的构建产物（见 chinese-chess-server/scripts/patch-dist.mjs）。
  #    打包前强制校验，补丁丢失（重新构建/换版覆盖）时直接阻塞出包，避免把
  #    「已废弃的禁着拦截 + 连续 3 次判负」逻辑打进部署包。
  node chinese-chess-server/scripts/patch-dist.mjs --check || {
    echo "[FAIL] 服务端补丁校验失败，已阻塞打包。请先执行：node chinese-chess-server/scripts/patch-dist.mjs" >&2
    exit 1
  }
  # 注意：服务端 dist/index.js 是当前唯一的可运行主体，必须保留
  zip -qr "$out" chinese-chess-server \
    -x 'chinese-chess-server/node_modules/*'
  echo "[OK] $out ($(du -h "$out" | cut -f1))"
}

TARGET="${1:-all}"
case "$TARGET" in
  client) pack_client ;;
  server) pack_server ;;
  all) pack_client; pack_server ;;
  *) echo "用法: $0 [client|server|all]"; exit 1 ;;
esac
