/**
 * 服务端启动器（跨平台）。
 *
 * 为什么需要它：
 * 原来的 `start` 脚本是 `NODE_ENV=production PORT=${PORT:-5000} node dist/index.js`，
 * 这是 POSIX shell 的语法。在 Windows 上 cmd 不认 `VAR=value cmd` 这种前置赋值，
 * 会直接报 `'NODE_ENV' is not recognized as an internal or external command`。
 * 同一个脚本还有第二个问题：`${PORT:-5000}` 会把未设置时的端口定成 5000，
 * 而 dist/index.js 的真实默认是 `var port = process.env.PORT || 9091;`，
 * DEPLOY.md 与 start.bat 也都写的是 9091 —— 于是 `pnpm start` 和文档说的端口不一致。
 *
 * 这里用 Node 设置环境变量再加载 dist，两个问题一起解决：
 * - NODE_ENV 默认 production（只影响 express 出错时是否打印堆栈）；
 * - PORT 不设置时保持 dist 自己的默认 9091。
 */

import process from 'node:process';

// 历史提醒：这里曾经在启动前 spawn `patch-dist.mjs --check`，因为 dist/index.js 是**没有源码**的
// 手工构建产物，补丁丢失会导致「长将长捉拦截」「连续 3 次判负」等旧行为复活。
// 现在源码已还原到 src/（6 条加固都在源码里），dist 由 `node build.js` 从 src/ 生成，
// 因此启动期不再需要任何补丁校验 —— 一致性由 `node build.js --check` 在开发/打包期守住。

process.env.NODE_ENV ||= 'production';

await import('../dist/index.js');
