/**
 * 揭棋引擎产物校验（挂进 pnpm -w validate）
 *
 * 检查 assets/engines/ 下的揭棋产物是否与 engine-source/jieqi/ 源一致，
 * 防止「改了引擎源却忘了重新生成产物」这类静默漂移。
 *
 * 与 verify-pikafish-engine-assets.mjs 的分工：
 *   那个管象棋（pikafish_worker.bin / pikafish_wasm.wasm / pikafish_nnue.nnue / pikafish.page）
 *   这个管揭棋（jieqi_worker.bin / jieqi_wasm.wasm / jieqi.page）
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

/**
 * ⚠️ 源与产物的文件名**故意不同**：engine-source/ 下的源文件不进包，
 *    可以沿用引擎工程惯例的 `jieqi.wasm`；而 assets/engines/ 下的产物会被
 *    Metro 打进 Android res/raw/，AAPT 以「去掉最后一个扩展名的路径」作资源名，
 *    同名不同扩展名会压成 Duplicate resources 让构建失败，故产物加了前缀。
 *    详见 client/scripts/verify-asset-resource-names.mjs。
 */
const SRC_WASM = path.join(SRC_DIR, 'jieqi.wasm');
const SRC_GLUE = path.join(SRC_DIR, 'jieqi.js');
const SRC_CORE = path.join(SRC_DIR, 'worker-core.js');

const OUT_WORKER = path.join(ASSET_DIR, 'jieqi_worker.bin');
const OUT_WASM = path.join(ASSET_DIR, 'jieqi_wasm.wasm');
const OUT_HTML = path.join(ASSET_DIR, 'jieqi.page');

const errors = [];
const warns = [];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 源文件是否存在 */
for (const [p, label] of [
  [SRC_WASM, '引擎源二进制 engine-source/jieqi/jieqi_wasm.wasm'],
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
      `缺少产物 assets/engines/jieqi_wasm.wasm。请执行：node client/scripts/gen-jieqi-host.mjs`
    );
  } else {
    const outWasm = fs.readFileSync(OUT_WASM);
    if (sha256(srcWasm) !== sha256(outWasm)) {
      errors.push(
        `assets/engines/jieqi_wasm.wasm 与 engine-source/jieqi/jieqi.wasm 不一致（可能过期）。` +
          `请重新执行：node client/scripts/gen-jieqi-host.mjs`
      );
    }
  }

  // 2. worker 产物必须存在，且内嵌**当前** glue 与 worker-core
  if (!fs.existsSync(OUT_WORKER)) {
    errors.push(
      `缺少产物 assets/engines/jieqi_worker.bin。请执行：node client/scripts/gen-jieqi-host.mjs`
    );
  } else {
    const worker = fs.readFileSync(OUT_WORKER, 'utf8');
    const glue = fs.readFileSync(SRC_GLUE, 'utf8');
    const core = fs.readFileSync(SRC_CORE, 'utf8');

    // worker-core 必须逐字出现（它是我们的代码，不应被改写）
    if (!worker.includes(core.trim())) {
      errors.push(
        `assets/engines/jieqi_worker.bin 内嵌的 worker-core 与源不一致。` +
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
        `assets/engines/jieqi_worker.bin 仍是「内联 wasm base64」的旧版产物。` +
          `wasm 必须作为独立同源资源提供（见 engine-source/jieqi/README.md）。` +
          `请重新执行：node client/scripts/gen-jieqi-host.mjs`
      );
    }

    // 4. 关键契约标记
    for (const marker of ['wasmUrl', 'locateFile', 'stdin']) {
      if (!worker.includes(marker)) {
        errors.push(
          `assets/engines/jieqi_worker.bin 缺少关键契约标记 "${marker}"（产物可能被截断或改写）`
        );
      }
    }

    // 5. 许可证声明（GPLv3 项目，产物内须保留）
    if (!/GPLv3|GPL-3\.0/i.test(worker)) {
      warns.push(
        `assets/engines/jieqi_worker.bin 未包含 GPLv3 许可证声明（GPL 合规要求保留）`
      );
    }

    // 体积下限：worker 是 glue（~62KB）+ core（~4KB）
    if (worker.length < 40000) {
      errors.push(
        `assets/engines/jieqi_worker.bin 体积异常（${worker.length} B），疑似生成不完整`
      );
    }
  }

  // 6. wasm magic 校验（防止把 HTML/文本当成 wasm 存进来）
  if (fs.existsSync(SRC_WASM)) {
    const head = fs.readFileSync(SRC_WASM).subarray(0, 4);
    const ok = head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
    if (!ok) {
      errors.push(
        `engine-source/jieqi/jieqi_wasm.wasm 的 magic 不是 00 61 73 6d（不是合法 wasm）`
      );
    }
  }

  // ==========================================================================
  // 7. jieqi.page —— 原生 WebView 的自包含离线页（Hermes 跑不了 wasm，必须有）
  //
  // 与 worker.bin 的关键差异：**内联 wasm base64**。原生 WebView 以 inline HTML
  // 承载时没有可用同源 origin，fetch 兄弟资源会被跨源/CORS 挡住，内联是唯一稳妥选择。
  // ==========================================================================
  let htmlStat = null;
  if (!fs.existsSync(OUT_HTML)) {
    errors.push(
      `缺少产物 assets/engines/jieqi.page（原生端引擎页）。请执行：node client/scripts/gen-jieqi-host.mjs`
    );
  } else {
    htmlStat = fs.statSync(OUT_HTML);
    const html = fs.readFileSync(OUT_HTML, 'utf8');
    const glue = fs.readFileSync(SRC_GLUE, 'utf8');
    const wasm = fs.readFileSync(SRC_WASM);

    // 7.1 体积下限：html = glue(~62KB) + wasm base64(~525KB) + 页面胶水。
    //     取 400KB —— 低于此说明 wasm base64 没被内联。
    if (htmlStat.size < 400 * 1024) {
      errors.push(
        `assets/engines/jieqi.page 体积异常（${htmlStat.size} B），疑似未内联 wasm base64`
      );
    }

    // 7.2 HTML 骨架与原生 WebView 注入点
    for (const marker of [
      '<!DOCTYPE html>',
      '<html',
      '</html>',
      'ReactNativeWebView',
      'window.addEventListener(\'message\'',
      'window.ReactNativeWebView.postMessage(JSON.stringify(msg))',
    ]) {
      if (!html.includes(marker)) {
        errors.push(
          `assets/engines/jieqi.page 缺少关键标记 ${JSON.stringify(marker)}（产物可能被截断或改写）`
        );
      }
    }

    // 7.3 协议关键字齐全（与 worker 版语义一致，页面侧换成一次性会话形态）。
    //     ⚠️ 标记刻意用**带引号的字面量 + 字段赋值**这类宿主侧才会出现的形态：
    //        glue 全文内嵌在产物里，裸词（如 banner）会被 glue 自身命中而恒真。
    for (const marker of [
      "{ type: 'host-loaded' }",
      "msg.type === 'session'",
      "msg.type === 'dispose'",
      "{ type: 'done'",
      "{ type: 'error'",
      'msg.commands || []',
      'banner: out.banner',
      'lines: out.lines',
    ]) {
      if (!html.includes(marker)) {
        errors.push(`assets/engines/jieqi.page 缺少协议关键字 ${JSON.stringify(marker)}`);
      }
    }

    // 7.4 引擎注入点：这版 glue **没有** instantiateWasm 钩子（wasmBinary 是闭包局部
    //     变量，从不由 Module 读取），字节只能靠 locateFile 哨兵 + 接管 window.fetch
    //     送进去。少任一条，原生端都会静默跑不出棋（无报错、只是没有 bestmove）。
    for (const marker of [
      'var PikaJieqi=',          // glue 工厂标识符（宿主侧按此取工厂）
      'locateFile',             // wasm 路径注入点
      'jieqi_r.wasm',           // glue 请求的文件名（哨兵必须匹配它）
      'window.fetch = function',// fetch 接管：把内联字节喂给 glue
      'WebAssembly.instantiateStreaming', // glue 的首选编译路径（需优雅降级）
    ]) {
      if (!html.includes(marker)) {
        errors.push(
          `assets/engines/jieqi.page 缺少注入点标记 ${JSON.stringify(marker)}` +
            `（jieqi glue 无 instantiateWasm 钩子，内联字节依赖 locateFile + fetch 接管）`
        );
      }
    }

    // 7.4b ⚠️ 不能设 noInitialRun：glue 的 run() 靠 callMain() 驱动 UCI::loop()，
    //      设了之后 UCI loop 会看到 EOF 直接退出、一条命令都不执行。
    if (/noInitialRun\s*:\s*true/.test(html)) {
      errors.push(
        `assets/engines/jieqi.page 显式设置了 noInitialRun —— glue 将不会调用 ` +
          `callMain()，UCI::loop() 读 stdin 立刻见 EOF，引擎一条命令都不执行。`
      );
    }

    // 7.4c stdin 必须能表达 EOF（返回 null），否则 UCI::loop() 永不退出、整个会话挂死。
    if (!/stdinPos\s*>=\s*stdinText\.length\s*\)\s*return null/.test(html)) {
      errors.push(
        `assets/engines/jieqi.page 的 stdin 未返回 null 表示 EOF —— ` +
          `UCI::loop() 会永久阻塞，会话永远收不到 done。`
      );
    }

    // 7.5 glue 必须**完整内联**（逐字符包含源 glue 全文）。
    //     这是最强的一道判据：任何截断/等长替换/用旧 glue 生成的过期产物都会被抓住。
    if (!html.includes(glue)) {
      errors.push(
        `assets/engines/jieqi.page 未完整内嵌 jieqi.js glue（逐字符包含校验失败）。` +
          `请重新执行：node client/scripts/gen-jieqi-host.mjs`
      );
    } else {
      console.log(`  jieqi.page 完整内嵌 glue: ${glue.length} 字符（逐字符一致）`);
    }

    // 7.6 内嵌的 wasm base64 必须与仓库原件**逐字节一致**（解码回来比 sha256）。
    //     与 pikafish 的 verifyEmbeddedNnue 同一思路：转译/截断/重排必然改变 sha256。
    const m = /var WASM_B64 = '([A-Za-z0-9+/=]+)'/.exec(html);
    if (!m || !m[1]) {
      errors.push(
        `assets/engines/jieqi.page 找不到 WASM_B64（内联 wasm base64）。` +
          `请重新执行：node client/scripts/gen-jieqi-host.mjs`
      );
    } else {
      const embedded = Buffer.from(m[1], 'base64');
      const eh = sha256(wasm);
      const ah = sha256(embedded);
      if (eh !== ah) {
        errors.push(
          `assets/engines/jieqi.page 内嵌 wasm 与仓库原件不一致（可能被转译破坏）：\n` +
            `    原件 sha256 ${eh}\n    产物 sha256 ${ah}`
        );
      } else {
        console.log(`  jieqi.page 内嵌 wasm 逐字节一致: ${ah} (${wasm.length} B)`);
      }
    }

    // 7.7 许可证声明（GPLv3 项目，产物内须保留）
    if (!/GPLv3|GPL-3\.0/i.test(html)) {
      warns.push(`assets/engines/jieqi.page 未包含 GPLv3 许可证声明（GPL 合规要求保留）`);
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
const h = fs.statSync(OUT_HTML).size;
console.log('verify-jieqi-engine-assets: 校验通过 ✓');
console.log(`  jieqi_worker.bin ${w} B`);
console.log(`  jieqi_wasm.wasm       ${wasm} B`);
console.log(`  jieqi.page       ${h} B (${(h / 1048576).toFixed(2)} MiB, 原生 WebView 内联)`);
