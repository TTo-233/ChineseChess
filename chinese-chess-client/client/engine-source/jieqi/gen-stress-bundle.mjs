/**
 * 生成压力测试用的「规则层 + 编解码层」CJS 打包产物。
 *
 * 存在的唯一理由：WASM glue 只有在**干净进程**里才会接受注入的 `stdin` 回调。
 * 只要主进程里注册了 TS 运行时（tsx），glue 就改读真实 process.stdin，
 * 于是脚本 argv 被当成 UCI 命令喂进引擎（实测报 Unknown command）。
 * 故把 utils/chess/ 下的纯 TS 预先打成 CJS，主进程直接 require 结果。
 *
 * 打包参数（与仓库其它 esbuild 产物保持一致的最小集，勿随意改动）：
 *   bundle / format=cjs / platform=node / target=node18 / 无 banner
 *
 * 用法（在 client/ 下）：node engine-source/jieqi/gen-stress-bundle.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..', '..');

const esbuild = require('esbuild');

const outFile = path.join(here, 'stress-entry.bundle.cjs');

await esbuild.build({
  entryPoints: [path.join(here, 'stress-entry.ts')],
  outfile: outFile,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // 不加 banner：产物只是给本目录的压力测试脚本用，不进部署包
  logLevel: 'warning',
});

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`gen-stress-bundle: 已生成 stress-entry.bundle.cjs (${kb} KB)`);