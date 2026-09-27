/**
 * dev:all —— 同时启动服务端与 Expo 客户端（跨平台，无需额外依赖）。
 *
 * 为什么需要它：
 * - 仓库根的 `pnpm dev` 走 `.cozeproj/scripts/dev_run.sh`，该脚本指向
 *   `$ROOT_DIR/server`（即 chinese-chess-client/server/），这个目录并不存在，
 *   而 `.cozeproj/` 标记为「禁止修改」，所以只能在 workspace 外提供一个可用入口。
 * - 服务端不在本 pnpm workspace 内（pnpm-workspace.yaml 只声明了 client），
 *   因此这里直接用 child_process 拉起两个子进程，不走 pnpm filter。
 *
 * 端口：服务端读 PORT（默认 9091，见 chinese-chess-server/dist/index.js:28892
 * `var port = process.env.PORT || 9091;`），客户端由 metro.config.js:104-105
 * 用 SERVER_PORT 决定把 /api/v1/* 代理到哪个后端。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const SERVER_DIR = path.resolve(ROOT, '..', 'chinese-chess-server');
const CLIENT_DIR = path.resolve(ROOT, 'client');
const DEFAULT_SERVER_PORT = '9091';

const isWindows = process.platform === 'win32';
const serverPort = process.env.PORT || DEFAULT_SERVER_PORT;

/** pnpm 在 Windows 上是 .cmd 包装，直接 spawn 会被报 EINVAL，必须经 shell 解析。 */
function pnpmBin() {
  return isWindows ? 'pnpm.cmd' : 'pnpm';
}

/** 找不到依赖时给出可执行的修复命令，而不是抛一个 npm 报错的栈。 */
function ensureExists(dir, hint) {
  if (existsSync(dir)) return;
  console.error(`[dev:all] 找不到目录：${dir}\n[dev:all] ${hint}`);
  process.exit(1);
}

ensureExists(SERVER_DIR, '服务端应位于仓库根下的 chinese-chess-server/（自包含部署包）。');
ensureExists(path.join(CLIENT_DIR, 'node_modules'), '请先在 chinese-chess-client/ 执行 pnpm install。');

const children = [];

function launch(name, cwd, command, args, env) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    // 只在 Windows 上经 cmd 解析 .cmd 包装，且不传额外 shell 参数，避免 DEP0190 警告
    shell: isWindows,
    env: { ...process.env, ...env },
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[dev:all] ${name} 已退出（code=${code} signal=${signal}），正在停止另一个进程。`);
    shutdown(code ?? 1);
  });
  child.on('error', (err) => {
    console.error(`[dev:all] ${name} 启动失败：${err.message}`);
    shutdown(1);
  });
  children.push({ name, child });
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

console.log(`[dev:all] 服务端：${SERVER_DIR}（端口 ${serverPort}）`);
console.log(`[dev:all] 客户端：${CLIENT_DIR}（Expo web，/api/v1 代理到 ${serverPort}）\n`);

launch('server', SERVER_DIR, pnpmBin(), ['run', 'start'], { PORT: serverPort });
launch('client', CLIENT_DIR, pnpmBin(), ['exec', 'expo', 'start', '--web', '--clear', '--port', process.env.EXPO_PORT || '5000'], {
  SERVER_PORT: serverPort,
  EXPO_NO_DEPENDENCY_VALIDATION: '1',
});
