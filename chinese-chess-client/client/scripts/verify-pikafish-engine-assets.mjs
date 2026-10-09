/**
 * 校验本地引擎产物（assets/engines）存在且**未被 Metro 转译破坏**。
 *
 * 背景（为什么这道闸门是必需的）：
 *   引擎产物各约 6MB（内联 base64 的 WASM + 4MB NNUE）。若 Metro 把它们当源码
 *   处理（babel/JSX 管线逐字符处理那两段巨型字符串），会出现两种**静默**故障：
 *     1. 产物内容被改写（转义、注入 helper），运行时才崩；
 *     2. 启动慢到数十秒、内存峰值数百 MB——用户只感觉"应用打不开"。
 *   metro.config.js 已用 blockList + assetExts 把它们挡在转译管线之外，
 *   本脚本负责确认**该配置真的生效**（即产物仍以原始字节提供）。
 *
 * 校验内容：
 *   1. 两个文件存在且非空；
 *   2. 体积与生成脚本声明的规模一致（数量级校验，能抓住"被截断/被压成空壳"）；
 *   3. 含关键标记：WASM/NNUE base64、UCI 状态机、协议字段、许可证声明；
 *   4. 仍是**纯 ASCII/UTF-8 可打印**文本（若被 babel 注入非预期内容会异常）。
 *
 * 用法：node scripts/verify-pikafish-engine-assets.mjs（挂进 pnpm -w validate）
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <repo>/chinese-chess-client/client/scripts
const clientRoot = path.resolve(here, '..');
const repoRoot = path.resolve(clientRoot, '..', '..');
const engineDir = path.join(clientRoot, 'assets', 'engines');

const WORKER = path.join(engineDir, 'pikafish.worker.bin');
const HTML = path.join(engineDir, 'pikafish.html');
const WASM = path.join(engineDir, 'pikafish.wasm');
const NNUE = path.join(engineDir, 'pikafish.nnue');

const errors = [];
const warns = [];

/**
 * 单文件校验：必须存在的标记。
 *
 * ⚠️ 这里只列**宿主产物自己负责**的内容。`position fen` / `setoption name MultiPV` /
 *    `ucinewgame` 这些命令由**主线程**（pikafishUci.ts）组装后经消息传进来，
 *    产物里不应出现——校验它们会误报。
 */
const REQUIRED_MARKERS = [
  // UCI 解析状态机（内联在两份产物里，保证 Web 与 WebView 行为一致）
  'CRITICAL ERROR',
  'bestmove',
  'multipv',
  'info depth',
  'pikafish.data',
  // 承载注入点（绕开 fs 的关键）
  'getPreloadedPackage',
  'instantiateWasm',
  // 握手
  'uci',
  'isready',
  // 许可证声明（GPL-3.0 项目，产物内须保留）
  'GPL-3.0',
];

/**
 * 文本产物校验。
 *
 * @param minSize 体积下限。意义是"能抓住被截断/未重新生成"。
 *
 * ⚠️ 2026-10 性能优化后两个产物的体积语义**不同**：
 *   · pikafish.worker.bin —— **小**（~200KB）：只有 loader + UCI 协议，
 *     二进制靠 fetch 拉取（不再 base64 内联）。所以这里**不设** 4MiB 下限，
 *     改用"必须含 fetch 与 URL 字段"来保证它是新版产物；
 *     ⚠️ 但标记级判据的覆盖范围只有文件前 ~3%，loader 主体在盲区里 ——
 *     真正的强判据是文件末尾的 verifyEmbedsLoader（逐字符包含源 loader 全文），
 *     它才能抓住截断/等长破坏/旧 loader 产物。
 *   · pikafish.html —— 仍是大文件（内联 base64，供原生 WebView），保留下限校验。
 */
function checkFile(file, extraMarkers = [], minSize = 0) {
  if (!fs.existsSync(file)) {
    errors.push(`缺少引擎产物: ${path.relative(clientRoot, file)}`);
    return null;
  }
  const stat = fs.statSync(file);
  if (stat.size === 0) {
    errors.push(`引擎产物为空: ${path.relative(clientRoot, file)}`);
    return null;
  }
  if (minSize > 0 && stat.size < minSize) {
    errors.push(
      `引擎产物体积异常（${stat.size} B < ${(minSize / 1048576).toFixed(0)}MiB），` +
        `可能被截断或未重新生成: ${path.relative(clientRoot, file)}`
    );
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of [...REQUIRED_MARKERS, ...extraMarkers]) {
    if (!text.includes(marker)) {
      errors.push(
        `产物缺少关键标记 ${JSON.stringify(marker)}: ${path.relative(clientRoot, file)}`
      );
    }
  }
  // 被 babel 转译过会引入 helper / 大量非 ASCII 注释；此处只提示不失败
  if (/__commonJS|_interopRequireDefault|babelHelpers/.test(text)) {
    warns.push(
      `产物疑似被 Babel 转译过（出现 __commonJS 等 helper）: ` +
        path.relative(clientRoot, file)
    );
  }
  return { stat, text };
}

/** 二进制资源校验：存在、非空、且与仓库原件逐字节一致 */
function verifyBinaryAsset(file, label, srcPath) {
  if (!fs.existsSync(file)) {
    errors.push(`缺少引擎二进制: ${path.relative(clientRoot, file)}`);
    return null;
  }
  const stat = fs.statSync(file);
  if (stat.size === 0) {
    errors.push(`引擎二进制为空: ${path.relative(clientRoot, file)}`);
    return null;
  }
  if (!fs.existsSync(srcPath)) {
    warns.push(`未找到仓库原件（${srcPath}），跳过逐字节比对`);
    return stat;
  }
  const expected = fs.readFileSync(srcPath);
  const actual = fs.readFileSync(file);
  const eh = crypto.createHash('sha256').update(expected).digest('hex');
  const ah = crypto.createHash('sha256').update(actual).digest('hex');
  if (eh !== ah) {
    errors.push(
      `${label} 与仓库原件不一致：\n    原件 ${eh}\n    产物 ${ah}`
    );
  } else {
    console.log(`  ${label} 逐字节一致: ${ah} (${expected.length} B)`);
  }
  return stat;
}

// Worker 是小文件：要求含 fetch 与两个 URL 字段（证明是新版"拆分"产物，
// 而不是旧的"内联 base64"产物——后者既大又慢）
const worker = checkFile(
  WORKER,
  ["self.postMessage", "'use strict'", 'fetch(', 'wasmUrl', 'nnueUrl'],
  0
);
// HTML 仍在原生端内联二进制，保留体积下限
const html = checkFile(
  HTML,
  ['<html', 'ReactNativeWebView', 'window.addEventListener'],
  4 * 1024 * 1024
);

// 引擎**源**二进制（客户端自建，服务端已去 AI 化后不再引用服务端目录）
const ENGINE_SRC = path.join(clientRoot, 'engine-source', 'pikafish');
const wasmStat = verifyBinaryAsset(
  WASM,
  'pikafish.wasm',
  path.join(ENGINE_SRC, 'pikafish.wasm')
);
const nnueStat = verifyBinaryAsset(
  NNUE,
  'pikafish.nnue',
  path.join(ENGINE_SRC, 'data', 'pikafish.data')
);

// 旧的"内联 base64"Worker 应已不存在（否则说明没重新生成）
if (worker && /var WASM_B64\s*=/.test(worker.text)) {
  errors.push(
    'pikafish.worker.bin 仍是旧的"内联 base64"版本（含 WASM_B64）。' +
      '请重新执行 node client/scripts/gen-pikafish-host.mjs'
  );
}

/**
 * 深度校验：把产物里的 NNUE base64 解码回来，确认与仓库里的真身**逐字节一致**。
 *
 * 这是最强的一道校验：只要产物被转译/截断/重排，解码后的 sha256 必然不同。
 */
function verifyEmbeddedNnue(result, file) {
  if (!result) return;
  const m = /var DATA_B64 = '([A-Za-z0-9+/=]+)';/.exec(result.text);
  if (!m || !m[1]) {
    errors.push(`产物中找不到 DATA_B64（NNUE base64）: ${path.relative(clientRoot, file)}`);
    return;
  }
  const nnuePath = path.join(
    clientRoot,
    'engine-source',
    'pikafish',
    'data',
    'pikafish.data'
  );
  if (!fs.existsSync(nnuePath)) {
    warns.push(`未找到仓库内 NNUE 原件（${nnuePath}），跳过逐字节比对`);
    return;
  }
  const expected = fs.readFileSync(nnuePath);
  const actual = Buffer.from(m[1], 'base64');
  const eh = crypto.createHash('sha256').update(expected).digest('hex');
  const ah = crypto.createHash('sha256').update(actual).digest('hex');
  if (eh !== ah) {
    errors.push(
      `产物内嵌 NNUE 与仓库原件不一致（可能被转译破坏）：\n` +
        `    原件 sha256 ${eh}\n` +
        `    产物 sha256 ${ah}`
    );
  } else {
    console.log(`  NNUE 逐字节一致: ${ah} (${expected.length} B)`);
  }
}

// 只有 HTML（原生端）仍内联 base64 NNUE；Worker 改为 fetch 二进制，不再有 DATA_B64
verifyEmbeddedNnue(html, HTML);

// 旧的"内联 base64"Worker 残留检查（见上方 checkFile 调用处）
if (worker && /var DATA_B64\s*=/.test(worker.text)) {
  errors.push(
    'pikafish.worker.bin 仍内联 DATA_B64（旧版产物）。' +
      '请重新执行 node client/scripts/gen-pikafish-host.mjs'
  );
}

// ---------------------------------------------------------------------------
// 【2026-10 审计 P2】产物必须**完整内嵌** engine loader（补标记级校验的漏洞）
//
// 缺陷：worker.bin 的校验此前只有"16 个必需标记 + minSize=0"，而实测全部标记
// 都落在文件前 3.16%（最长 6667 / 全长 211137），Emscripten loader 主体
// （约 195KB）**完全不在任何标记的覆盖范围内**。于是：
//   · 截断到 5%~95% → 标记齐全 → 打印"校验通过"；
//   · 等长破坏（把 loader 整段替换成等长垃圾）→ 连体积都没变 → 照样"通过"；
//   · loader 被换成一个 40 字符的桩函数 → 照样"通过"。
// 而 worker 一旦损坏，Web 端 new Worker 起来的宿主会在实例化 WASM 时失败，
// 静默降级为"基础 AI"，用户只看到棋力变弱、没有任何报错。
//
// 现在的判据来自 gen 脚本的事实：loader 是以 `${loaderSrc}` **原文内联**的
// （gen-pikafish-host.mjs 的 loaderSrc = readFileSync(pikafish.cjs)）。
// 所以"产物必须逐字符包含源 loader 全文"是一条既强又零维护的断言：
// 任何截断、损坏、等长替换、或用旧 loader 生成的过期产物都会被抓到。
// ---------------------------------------------------------------------------
const LOADER_SRC_PATH = path.join(ENGINE_SRC, 'pikafish.cjs');
let loaderSrc = null;
if (fs.existsSync(LOADER_SRC_PATH)) {
  loaderSrc = fs.readFileSync(LOADER_SRC_PATH, 'utf8');
} else {
  warns.push(`未找到仓库内 engine loader（${LOADER_SRC_PATH}），跳过"完整内嵌"校验`);
}

/**
 * 断言产物完整内嵌了源 loader。
 *
 * @param result checkFile 的返回值（含 text/stat），缺失时为 null
 * @param label  报错用的人类可读名
 */
function verifyEmbedsLoader(result, label) {
  if (!result || !loaderSrc) return;
  // 体积自校准下限：产物 = 头部 + UCI 状态机 + loader + 尾部胶水，
  // 因此必然**大于** loader 本身（严格大于，因为 loader 之外还有内容）。
  if (result.stat.size <= loaderSrc.length) {
    errors.push(
      `${label} 体积（${result.stat.size} B）不大于内嵌的 loader（${loaderSrc.length} B），` +
        `必定被截断或未重新生成`
    );
  }
  if (!result.text.includes(loaderSrc)) {
    errors.push(
      `${label} 未完整内嵌引擎 loader（逐字符包含校验失败）：loader 主体被截断、` +
        `被改写，或用旧 loader 生成的过期产物。请重新执行 node client/scripts/gen-pikafish-host.mjs`
    );
    return;
  }
  console.log(`  ${label} 完整内嵌 loader: ${loaderSrc.length} 字符（逐字符一致）`);
}

verifyEmbedsLoader(worker, 'pikafish.worker.bin');
verifyEmbedsLoader(html, 'pikafish.html');

if (errors.length > 0) {
  console.error('verify-pikafish-engine-assets: 引擎产物校验失败：');
  for (const e of errors) console.error('  ✗ ' + e);
  console.error('\n修复方式：node client/scripts/gen-pikafish-host.mjs');
  process.exit(1);
}
for (const w of warns) console.warn('  ! ' + w);
console.log('verify-pikafish-engine-assets: 引擎产物校验通过 ✓');
if (worker) console.log(`  pikafish.worker.bin ${worker.stat.size} B（小：靠 fetch 拉二进制）`);
if (wasmStat) console.log(`  pikafish.wasm      ${wasmStat.size} B`);
if (nnueStat) console.log(`  pikafish.nnue      ${nnueStat.size} B`);
if (html) console.log(`  pikafish.html      ${html.stat.size} B（原生端内联）`);
