/**
 * 服务端启动器（跨平台）。
 *
 * 为什么需要它：
 * 原来的 `start` 脚本是 `NODE_ENV=production PORT=${PORT:-5000} node dist/index.js`，
 * 这是 POSIX shell 的语法。在 Windows 上 cmd 不认 `VAR=value cmd` 这种前置赋值，
 * 会直接报 `'NODE_ENV' is not recognized as an internal or external command`。
 * 同一个脚本还有第二个问题：`${PORT:-5000}` 会把未设置时的端口定成 5000，
 * 而 dist/index.js:28892 的真实默认是 `var port = process.env.PORT || 9091;`，
 * DEPLOY.md 与 start.bat 也都写的是 9091 —— 于是 `pnpm start` 和文档说的端口不一致。
 *
 * 这里用 Node 设置环境变量再加载 dist，两个问题一起解决：
 * - NODE_ENV 默认 production（只影响 express 出错时是否打印堆栈）；
 * - PORT 不设置时保持 dist 自己的默认 9091。
 */

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 启动前强制校验：dist/index.js 是不是还是打过「长将长捉不拦截」补丁的版本。
// 补丁丢失通常意味着 dist 被重新打包/换版覆盖，此时旧的服务端禁着拦截与
// 「连续 3 次判负」会一起复活，症状是客户端能走的着法被服务端以 400 拒绝。
// 与其带着不一致的规则上线，不如直接拒绝启动并提示修复命令。
// 详见 scripts/patch-dist.mjs 的文件头注释。
const check = spawnSync(
  process.execPath,
  [path.join(HERE, 'patch-dist.mjs'), '--check'],
  { stdio: 'inherit' },
);
if (check.status !== 0) {
  console.error('❌ 服务端启动中止：dist/index.js 未打「长将长捉不拦截」补丁。\n');
  process.exit(1);
}

process.env.NODE_ENV ||= 'production';

await import('../dist/index.js');
