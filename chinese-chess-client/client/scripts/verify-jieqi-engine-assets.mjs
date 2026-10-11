/**
 * 揭棋引擎产物校验（挂进 pnpm -w validate）
 *
 * 检查 assets/engines/ 下的揭棋产物是否与 engine-source/jieqi/ 源一致，
 * 防止「改了引擎源却忘了重新生成产物」这类静默漂移。
 *
 * 与 verify-pikafish-engine-assets.mjs 的分工：
 *   那个管象棋（pikafish.worker.bin / pikafish.wasm / pikafish.nnue）
 *   这个管揭棋（jieqi.worker.bin / jieqi.wasm）
 *
 * 用法：node client/scripts/verify-jieqi-engine-assets.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');

const SRC_DIR = path.join(clientRoot, 'engine-source', 'jieqi');
const ASSET_DIR = path.join(clientRoot, 'assets', 'engines');

const SRC_WASM = path.join(SRC_DIR, 'jieqi.wasm');
const SRC_GLUE = path.join(SRC_DIR, 'jieqi.js');
const SRC_CORE = path.join(SRC_DIR, 'worker-core.js');

const OUT_WORKER = path.join(ASSET_DIR, 'jieqi.worker.bin');
const OUT_WASM = path.join(ASSET_DIR, 'jieqi.wasm');

const errors = [];
const warns = [];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 源文件是否存在 */
for (const [p, label] of [
  [SRC_WASM, '引擎源二进制 engine-source/jieqi/jieqi.wasm'],
  [SRC_GLUE, '引擎源 glue engine-source/jieqi/jieqi.js'],
  [SRC_CORE, 'worker 核心 engine-source/jieqi/worker-core.js'],
]) {
  if (!fs.existsSync(p)) {
    errors.push(`缺少${label}：${path.relative(clientRoot, p)}`);
  }
}

if (errors.length === 0) {
  const srcWasm = fs.readFileSync(SRC_WASM);

  // 1. wasm 源与产物必须**逐字节一致**（产物是直接 copy 的）
  if (!fs.existsSync(OUT_WASM)) {
    errors.push(
      `缺少产物 assets/engines/jieqi.wasm。请执行：node client/scripts/gen-jieqi-host.mjs`
    );
  } else {
    const outWasm = fs.readFileSync(OUT_WASM);
    if (sha256(srcWasm) !== sha256(outWasm)) {
      errors.push(
        `assets/engines/jieqi.wasm 与 engine-source/jieqi/jieqi.wasm 不一致（可能过期）。` +
          `请重新执行：node client/scripts/gen-jieqi-host.mjs`
      );
    }
  }

  // 2. worker 产物必须存在，且内嵌**当前** glue 与 worker-core
  if (!fs.existsSync(OUT_WORKER)) {
    errors.push(
      `缺少产物 assets/engines/jieqi.worker.bin。请执行：node client/scripts/gen-jieqi-host.mjs`
    );
  } else {
    const worker = fs.readFileSync(OUT_WORKER, 'utf8');
    const glue = fs.readFileSync(SRC_GLUE, 'utf8');
    const core = fs.readFileSync(SRC_CORE, 'utf8');

    // worker-core 必须逐字出现（它是我们的代码，不应被改写）
    if (!worker.includes(core.trim())) {
      errors.push(
        `assets/engines/jieqi.worker.bin 内嵌的 worker-core 与源不一致。` +
          `请重新执行：node client/scripts/gen-jieqi-host.mjs`
      );
    }

    // glue 的工厂名必须仍是 PikaJieqi（worker-core 依赖这个标识符）
    if (!glue.includes('var PikaJieqi=')) {
      errors.push(
        `engine-source/jieqi/jieqi.js 未导出预期的工厂名 PikaJieqi（glue 可能被换过）。`
      );
    }

    // 3. worker 里**不应**再内联 wasm 的 base64：
    //    实测 blob:/data: 路径在 Worker 里都不可靠，wasm 必须走独立同源资源。
    //    若发现 WASM_B64，说明产物是用旧版脚本生成的。
    if (/var WASM_B64\s*=/.test(worker)) {
      errors.push(
        `assets/engines/jieqi.worker.bin 仍是「内联 wasm base64」的旧版产物。` +
          `wasm 必须作为独立同源资源提供（见 engine-source/jieqi/README.md）。` +
          `请重新执行：node client/scripts/gen-jieqi-host.mjs`
      );
    }

    // 4. 关键契约标记
    for (const marker of ['wasmUrl', 'locateFile', 'stdin']) {
      if (!worker.includes(marker)) {
        errors.push(
          `assets/engines/jieqi.worker.bin 缺少关键契约标记 "${marker}"（产物可能被截断或改写）`
        );
      }
    }

    // 5. 许可证声明（GPLv3 项目，产物内须保留）
    if (!/GPLv3|GPL-3\.0/i.test(worker)) {
      warns.push(
        `assets/engines/jieqi.worker.bin 未包含 GPLv3 许可证声明（GPL 合规要求保留）`
      );
    }

    // 体积下限：worker 是 glue（~62KB）+ core（~4KB）
    if (worker.length < 40000) {
      errors.push(
        `assets/engines/jieqi.worker.bin 体积异常（${worker.length} B），疑似生成不完整`
      );
    }
  }

  // 6. wasm magic 校验（防止把 HTML/文本当成 wasm 存进来）
  if (fs.existsSync(SRC_WASM)) {
    const head = fs.readFileSync(SRC_WASM).subarray(0, 4);
    const ok = head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
    if (!ok) {
      errors.push(
        `engine-source/jieqi/jieqi.wasm 的 magic 不是 00 61 73 6d（不是合法 wasm）`
      );
    }
  }
}

if (warns.length) {
  console.warn('verify-jieqi-engine-assets: 警告');
  warns.forEach((w) => console.warn('  ! ' + w));
}

if (errors.length) {
  console.error('verify-jieqi-engine-assets: 校验失败');
  errors.forEach((e) => console.error('  x ' + e));
  console.error('\n修复方式：node client/scripts/gen-jieqi-host.mjs');
  process.exit(1);
}

const w = fs.statSync(OUT_WORKER).size;
const wasm = fs.statSync(OUT_WASM).size;
console.log('verify-jieqi-engine-assets: 校验通过 ✓');
console.log(`  jieqi.worker.bin ${w} B`);
console.log(`  jieqi.wasm       ${wasm} B`);
