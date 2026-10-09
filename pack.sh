#!/usr/bin/env bash
# 象棋项目打包脚本
# 用法: ./pack.sh [client|server|all]   （默认 all）
# 产物: 仓库根目录 chinese-chess-{client|server}_YYYYMMDD.zip
# 清理: 每次打包会先删除「该端」的历史 zip（只删同前缀，client 与 server 互不影响），
#       仓库根目录始终只保留每个端当天的这一个包，避免旧包被误当成最新包分发。
set -euo pipefail
DATE="$(date +%Y%m%d)"
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 删除指定端的历史打包文件（保留当天那个，由后续打包重新生成）
# 模式 'chinese-chess-client_*.zip' 只匹配 client 前缀，不会误删 server 的包
remove_old_zip() {
  local prefix="$1"
  # 未命中时 bash 会原样回传 glob 模式，故用 -e 判存在性
  local f
  for f in ${prefix}_*.zip; do
    [ -e "$f" ] || continue
    rm -f "$f"
    echo "[CLEAN] 已删除历史包 $f"
  done
}

# 与 pack.ps1 的 Assert-NoJunk 等价：出包后扫描 zip 条目，混进垃圾/环境配置直接失败。
# 以前只有 pack.ps1 有这道自检，pack.sh 只检查 zip 退出码，于是 macOS/Linux/WSL 上出包
# 会静默带上 .DS_Store、*.log、.env 等（根 AGENTS.md「出包后自检」对 pack.sh 并不成立）。
JUNK_RE='(^|/)(node_modules|\.expo|\.expo-shared|coverage|\.cache|\.turbo|\.parcel-cache|\.vscode|\.idea|\.git)(/|$)'
assert_no_junk() {
  local zip="$1"
  # unzip -Z1 在未安装 unzip 时不可用；此时降级为静默跳过而不是让出包失败。
  if ! command -v unzip >/dev/null 2>&1; then
    echo "[WARN] 未找到 unzip，跳过出包自检（$zip）"
    return 0
  fi
  local junk
  junk="$(unzip -Z1 "$zip" | grep -E "$JUNK_RE|\.(log|tsbuildinfo|eslintcache|DS_Store)$|(^|/)\.env($|\.)|\.env$|(^|/)\.verify-old(/|$)" || true)"
  if [ -n "$junk" ]; then
    echo "[FAIL] 「$zip」里混入了缓存/构建产物/环境配置：" >&2
    printf '  %s\n' $junk >&2
    echo "请补 -x 排除规则后重打。" >&2
    exit 1
  fi
}

pack_client() {
  local out="chinese-chess-client_${DATE}.zip"
  rm -f "$out"
  remove_old_zip 'chinese-chess-client'
  # 排除依赖、缓存与本地构建产物（node_modules 可由 pnpm install 恢复）
  # .env / .env.* / *.env：工作机上的环境配置绝不能随交付包分发（pack.ps1 同步）
  zip -qr "$out" chinese-chess-client \
    -x 'chinese-chess-client/node_modules/*' \
       'chinese-chess-client/client/node_modules/*' \
       'chinese-chess-client/.expo/*' \
       'chinese-chess-client/client/.expo/*' \
       'chinese-chess-client/client/dist/*' \
       'chinese-chess-client/client/web-build/*' \
       'chinese-chess-client/client/build/*' \
       'chinese-chess-client/client/assets/boards/_source/*' \
       # 皮卡鱼引擎**源**二进制只用于重新生成 assets/engines/* 与逐字节溯源校验；
       # 产物已随包分发，运行不需要源目录，故不重复携带这 4.8MB。
       'chinese-chess-client/client/engine-source/*' \
       'chinese-chess-client/.eslintcache' \
       'chinese-chess-client/client/.eslintcache' \
       'chinese-chess-client/**/.env' \
       'chinese-chess-client/**/.env.*' \
       'chinese-chess-client/**/*.env'
  assert_no_junk "$out"
  echo "[OK] $out ($(du -h "$out" | cut -f1))"
}

# 服务端 dist/index.js 现在由 chinese-chess-server/src/ 经 `node build.js` 生成（esbuild）。
#    打包前强制校验「已提交的 dist 与重新构建的结果一致」：dist 被手工改过或被旧产物
#    覆盖过就直接阻塞出包；6 条加固都在 src/ 里，不会再出现「补丁丢了却照样出包」。
#    （2026-10 去 AI 化：原 ai\ 引擎与开局库已随服务端 AI 一并移除。）
# 【I-11】此校验必须在任何 rm 之前执行：以前它排在 remove_old_zip 之后，校验失败时
#    「上一版可用包已删、新包未出」——该端零包且无法回滚。
assert_server_dist_fresh() {
  ( cd chinese-chess-server && node build.js --check ) || {
    echo "[FAIL] 服务端 dist 与 src/ 不一致，已阻塞打包。请在 chinese-chess-server 下执行：node build.js" >&2
    exit 1
  }
}

pack_server() {
  local out="chinese-chess-server_${DATE}.zip"
  rm -f "$out"
  remove_old_zip 'chinese-chess-server'
  # 注意：服务端 dist/index.js 是当前唯一的可运行主体，必须保留；
  #       .verify-old/ 是差分闸门留下的旧 dist 产物，不能混进部署包。
  zip -qr "$out" chinese-chess-server \
    -x 'chinese-chess-server/node_modules/*' \
       'chinese-chess-server/.verify-old/*' \
       'chinese-chess-server/**/.env' \
       'chinese-chess-server/**/.env.*' \
       'chinese-chess-server/**/*.env'
  assert_no_junk "$out"
  echo "[OK] $out ($(du -h "$out" | cut -f1))"
}

TARGET="${1:-all}"
# 【I-11】'all' 模式下先校验服务端，再做任何删除 —— 校验不过就整轮中止，磁盘上仍是上一版可用包。
case "$TARGET" in
  server|all) assert_server_dist_fresh ;;
esac
case "$TARGET" in
  client) pack_client ;;
  server) pack_server ;;
  all) pack_client; pack_server ;;
  *) echo "用法: $0 [client|server|all]"; exit 1 ;;
esac