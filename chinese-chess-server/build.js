#!/usr/bin/env node
/**
 * 服务端构建脚本：由 src/ 打包出 dist/index.js。
 *
 * 构建参数是逆向取证锁定的（见仓库根 SERVER-SOURCE-REBUILD-PLAN.md），请勿随意改动：
 *   bundle: true / platform: 'node' / format: 'esm' / target: 'node20' / minify: false
 *   charset 默认 ascii（字符串里的 CJK 转义为 \uXXXX，注释里的 CJK 保持原文）
 *   legalComments 默认 eof（尾部输出 /*! Bundled license information: 区块）
 *   banner 见下方 BANNER —— 必需，否则产物在 ESM 下没有 require，依赖里对 node 内建模块的
 *     require 会抛 "Dynamic require of ... is not supported"，服务端起不来
 *   模块注释路径的渲染基准是 absWorkingDir（而非 outfile 所在目录）：原始构建是在工作区根下的
 *     server/ 子目录里跑的，所以 dist 里写的是 ../node_modules/...；本仓库把服务端独立成
 *     chinese-chess-server/ 之后，同样的基准只会渲染成 node_modules/...。这属于纯注释与
 *     __commonJS 对象键的差异（该键只作标签，不影响行为），因此 00-PRELUDE 是 INFO 区：
 *     只要求依赖图（模块序列）一致，允许版本漂移。
 *
 * 用法：
 *   node build.js                 写入 dist/index.js
 *   node build.js --check         只在内存里构建，与已提交的 dist/index.js 逐区域比对（不写盘）
 *   node build.js --check --only src/routes/lanGame.ts   只比对某个区域
 *   node build.js --dump <dir>    把两侧区域文件落盘，便于 `git diff --no-index` 细看（不写盘）
 *   node build.js --check --porting   与**历史手工基准** dist 比对时放宽判据（见 normalizePorting）：
 *     只在"移植期"使用；dist 一旦由 src/ 重建完成，就该回到不带 --porting 的严格模式
 *   node build.js --check --porting --baseline ../.dsh-work/dist-baseline-20261002.js
 *     与任意历史产物比对（默认比 dist/index.js）。这是"新 dist 与 2026-10-02 出厂的旧产物
 *     行为等价"这条结论的可复现证据：旧产物 md5 = 2646eac282e2ddc8d3d76b37a36c61b3
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const CHECK = hasFlag('--check');
const OUT = flagValue('--outfile') || 'dist/index.js';
const DUMP = flagValue('--dump');
const ONLY = flagValue('--only');
const PORTING = hasFlag('--porting');
// 只有"显式构建"才写盘：--check 与 --dump 一律只在内存里构建，绝不碰 dist/index.js
const EMIT = !CHECK && !DUMP;

// 原始构建的 banner：与 dist/index.js 第 1–6 行逐字节一致（逆向取证结果）。
const BANNER_LINES = [
  "import { createRequire as __cr } from 'node:module';",
  "import { fileURLToPath as __f2p } from 'node:url';",
  "import { dirname as __dn } from 'node:path';",
  'const require = __cr(import.meta.url);',
  'const __filename = __f2p(import.meta.url);',
  'const __dirname = __dn(__filename);',
];
const BANNER = BANNER_LINES.join('\n');

const BANNER_RE = /^\/\*! Bundled license information:/;
const MARKER_RE = /^\/\/ (src\/.+)$/;

/** 把 bundle 文本切成若干区域：0A-BANNER / 00-PRELUDE / <src/...> / ZZ-BANNER */
function splitRegions(text) {
  const lines = text.split('\n');
  const regions = [];
  let from = 0;
  if (lines[0] === BANNER_LINES[0]) {
    regions.push({ name: '0A-BANNER', text: lines.slice(0, BANNER_LINES.length).join('\n') });
    from = BANNER_LINES.length;
  }
  const marks = [];
  let bannerAt = -1;
  for (let i = from; i < lines.length; i++) {
    if (bannerAt < 0 && BANNER_RE.test(lines[i])) bannerAt = i;
    if (bannerAt < 0 && MARKER_RE.test(lines[i])) marks.push(i);
  }
  const end = bannerAt >= 0 ? bannerAt : lines.length;
  if (marks.length) {
    regions.push({ name: '00-PRELUDE', text: lines.slice(from, marks[0]).join('\n') });
    const seen = new Map();
    for (let k = 0; k < marks.length; k++) {
      const a = marks[k];
      const b = k + 1 < marks.length ? marks[k + 1] : end;
      const raw = lines[a].match(MARKER_RE)[1];
      const n = (seen.get(raw) || 0) + 1;
      seen.set(raw, n);
      regions.push({ name: n > 1 ? `${raw}#${n}` : raw, text: lines.slice(a, b).join('\n') });
    }
  } else {
    regions.push({ name: '00-PRELUDE', text: lines.slice(from, end).join('\n') });
  }
  if (bannerAt >= 0) regions.push({ name: 'ZZ-BANNER', text: lines.slice(bannerAt).join('\n') });
  return regions;
}

/** 比对前做 Unicode 归一化：把 \uXXXX 解码成字符，抹平"注释被转义/未转义"的历史差异 */
function normalize(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * --porting：与**历史手工基准** dist/index.js 比对时使用的放宽归一化。
 *
 * 事实依据（可复验）：
 *   1) .dsh-work/comment-probe.mjs —— 用本仓库锁定的 esbuild 0.27.2 直接构建最小样例，
 *      在 minify:false 且 bundle:false 的情况下，esbuild 仍然会
 *        (a) 丢弃语句块内的独立注释行（toplevel 之外的 // 注释不保留）
 *        (b) 把 undefined 打印成 void 0
 *        (c) 删除对象字面量的尾逗号
 *      battleWs 代理用 0.17.19 / 0.18.20 / 0.25.12 / 0.27.2 / 0.28.2 五个版本做了同样的矩阵实验，
 *      结论一致（legalComments / target / treeShaking / keepNames / sourcesContent 变体均如此）。
 *   2) dist/index.js 的这些区域保留了注释、undefined 与尾逗号，因此**不可能**是任何 esbuild
 *      版本的产物 —— 它是人工改写过的构建产物（DEPLOY.md 第 31–60 行自述"dist\index.js 是
 *      手工改动过的构建产物"）；已核实 scripts/patch-dist.mjs 中并不含 hidden-tab /
 *      returnToRoom / settleAbandonedPlayingRoom 这些代码，说明这部分是直接手改进 dist 的。
 *   3) .dsh-work/lazy-probe.mjs —— 三类"打印器形状"差异同样由 esbuild 施加，源码改不了：
 *      bundle 模式下多声明符声明必然被拆成多条 var；匿名函数表达式一律打印 `function(`；
 *      字符串一律双引号（仅当字符串自身含 " 时才用单引号）。手写进 dist 的代码用的是人写
 *      风格（`const A = 10, B = 9;`、`function (x)`、`'x'`），因此也逐字符对不上。
 *
 * 于是这些差异在数学上无法通过严格比对。--porting 把「整行注释、void 0≡undefined、尾逗号、
 * \uXXXX、多声明符展开成单声明、function( 空格、引号风格、裸 require≡ESM import」都视为等价：非注释代码仍要求**逐字符一致**，
 * 所以它依然是个强判据 —— 被归一化的每一项都是语义惰性的（注释无语义、void 0 与 undefined
 * 同值、尾逗号是语法糖、声明拆并同绑定、空白与引号不改变词法记号）。
 * 注意：这只是移植期的过渡判据；dist 由 src/ 重建之后，--check 会自然回到 IDENTICAL。
 */
/**
 * 把一行多声明符声明（`const A = 10, B = 9;`）展开成多行、每行一个声明。
 * 只切**顶层**逗号：括号/方括号/花括号深度 > 0，或处于字符串/模板串内时跳过
 * ——否则会把 `__toESM(require_express2(), 1)` 这类参数表切坏。不匹配的行原样返回。
 */
function splitDeclLine(line) {
  const m = /^(\s*)(var|let|const) (\S.*);\s*$/.exec(line);
  if (!m) return line;
  const indent = m[1];
  const kind = m[2];
  const body = m[3];
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  if (parts.length === 1) return line;
  return parts.map((p) => `${indent}${kind} ${p.trim()};`).join('\n');
}

function normalizePorting(text) {
  const kept = [];
  let inBlock = 0;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (inBlock > 0) {
      if (t.includes('*/')) inBlock--;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock++;
      continue;
    }
    if (t.startsWith('//')) continue;
    kept.push(raw);
  }
  const splitDecls = (t) => t.split('\n').map(splitDeclLine).join('\n');
  // 空白行无语义；手写进 dist 的代码里有多余空行，esbuild 产物则没有 → 两侧一律剔除。
  const out = kept
    .filter((l) => l.trim() !== '')
    .join('\n')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\bvoid 0\b/g, 'undefined')
    // esbuild 会把 3000 打印成 3e3（数字字面量最短化），手写进 dist 的代码写的是 3000：
    // 把指数写法展开成十进制，两侧收敛到人写形式（`\b` 保证不会误伤 0x1e5 与标识符）。
    .replace(/\b(\d+(?:\.\d+)?)e(\d+)\b/gi, (_, mant, exp) => String(Number(`${mant}e${exp}`)))
    .replace(/,(?=\s*[)\]}]|$)/g, '');
  // 手写进 dist 的整段代码用的是人写风格，esbuild 的打印器不会产出这些形式（见文件头 3)）：
  // 多声明符被 bundle 拆行（`const A = 10, B = 9;` → 两条 var）→ 这里统一**反向展开**：
  // 两侧的 `var a = X, b = Y;` 一律切成每行一个声明，收敛到"被拆开"的产物形式；
  // 匿名函数表达式的 function ( → function( ；单引号 → 双引号。
  let merged = splitDecls(out);
  // 手写进 dist 的代码会把"函数体只有一条 return"压成一行（`function(p) { return X; }`），
  // esbuild 打印器会拆成三行 —— 统一压回单行，两侧收敛（语句序列完全不变）。
  merged = merged.replace(/\{\n\s*(return [^\n;]*;)\n\s*\}/g, '{ $1 }');
  // dist 里 `var ruleEngine = require("../ruleEngine.cjs");` 也是手写的：ESM 格式下 esbuild
  // 不可能打印出裸 require（源码写 require 会被改写成 __require，探针 V1/V4/V5/V7 全部证明），
  // 只有 format:'cjs' 会保留（V8）。源码侧改用 `import ruleEngine from '../ruleEngine.cjs';`
  // 更干净且运行期等价（node 对 .cjs 的 default 导入就是 module.exports），故两者视为等价。
  // 该规则必须在**声明展开与引号归一之后**执行（展开后它才独立成行）。
  merged = merged
    .replace(/\bfunction \(/g, 'function(')
    .replace(/'/g, '"');
  return merged.replace(/^var ([A-Za-z_$][\w$]*) = require\("([^"]+)"\);$/gm, 'import $1 from "$2";');
}

/** 从 node_modules 的模块注释里取出包名与版本（dist 的路径前缀是 ../，本仓库构建则没有） */
function pkgOfComment(line) {
  const m = line.match(/^\/\/ (?:\.\.\/)*node_modules\/(.+)$/);
  if (!m) return null;
  const rest = m[1];
  const p = rest.match(/^\.pnpm\/(@[^/+]+\+)?([^/@+]+)@([^/]+)\/node_modules\//);
  if (p) return { name: (p[1] ? p[1].slice(0, -1) + '/' : '') + p[2], version: p[3] };
  const q = rest.match(/^([^/]+)\//);
  return q ? { name: q[1], version: null } : null;
}

/** 依赖图摘要：模块序列（包名顺序）必须一致，只有版本漂移才允许通过 */
function preludeInfo(distText, builtText) {
  const collect = (t) => t.split('\n').map(pkgOfComment).filter(Boolean);
  const d = collect(distText);
  const b = collect(builtText);
  const dNames = d.map((x) => x.name);
  const bNames = b.map((x) => x.name);
  if (dNames.join('\n') !== bNames.join('\n')) {
    return { ok: false, msg: `依赖图已漂移：dist ${d.length} 个模块 / built ${b.length} 个模块（包名序列不一致）` };
  }
  const dMap = new Map(d.map((x) => [x.name, x.version]));
  const drifts = [];
  for (const [n, v] of new Map(b.map((x) => [x.name, x.version]))) {
    const dv = dMap.get(n);
    if (dv && v && dv !== v) drifts.push(`${n}@${dv}→${v}`);
  }
  return {
    ok: true,
    msg:
      `依赖图一致（${dNames.length} 个模块 / ${new Set(dNames).size} 个包）；` +
      `版本漂移 ${drifts.length} 个：${drifts.join(', ') || '无'}`,
  };
}

function diffSummary(a, b, maxHunks = 4, maxPerHunk = 6) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  // LCS 表：区域最多几千行，O(n·m) 足够快，且能给出"哪里不同"的真实 hunk，而不是
  // 一处插入就把后面所有行都算成差异（那会让移植期完全没法定位）。
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] =
        A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  let changed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      cur = null;
      i += 1;
      j += 1;
      continue;
    }
    if (!cur) {
      cur = { aNo: i + 1, bNo: j + 1, a: [], b: [] };
      hunks.push(cur);
    }
    const takeA = i < n && (j >= m || dp[(i + 1) * w + j] >= dp[i * w + j + 1]);
    if (takeA) {
      cur.a.push(A[i]);
      i += 1;
    } else {
      cur.b.push(B[j]);
      j += 1;
    }
    changed += 1;
  }
  const out = [
    `  差异：共 ${changed} 行（${hunks.length} 处 hunk${hunks.length > maxHunks ? `，只显示前 ${maxHunks} 处` : ''}）`,
  ];
  for (const [k, h] of hunks.slice(0, maxHunks).entries()) {
    out.push(`  ▸ hunk ${k + 1} @ dist:${h.aNo} / built:${h.bNo}`);
    const side = (label, arr, no) => {
      const cut = arr.slice(0, maxPerHunk);
      for (const [d, line] of cut.entries()) out.push(`    ${label} ${no + d}: ${line}`);
      if (arr.length > cut.length) out.push(`    ${label} ...（该 hunk 该侧另有 ${arr.length - cut.length} 行）`);
    };
    side('- dist ', h.a, h.aNo);
    side('+ built', h.b, h.bNo);
  }
  return out.join('\n');
}

const buildOptions = {
  absWorkingDir: here,
  entryPoints: ['src/index.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  banner: { js: BANNER },
  // 与客户端共享的规则引擎：产物文件由 scripts/verify-rule-engine-parity.mjs 一并校验
  external: ['../ruleEngine.cjs'],
  logLevel: 'warning',
  write: EMIT,
};

const result = await build(EMIT ? buildOptions : { ...buildOptions, write: false });
if (EMIT) {
  const size = fs.statSync(path.join(here, OUT)).size;
  console.log(`✅ 已生成 ${OUT}（${size} 字节）`);
  process.exit(0);
}

const builtText = result.outputFiles[0].text;
const distPath = path.resolve(here, flagValue('--baseline') || 'dist/index.js');
if (!fs.existsSync(distPath)) {
  console.error(`❌ 找不到 ${distPath}，无法比对。`);
  process.exit(1);
}
const distBytes = fs.readFileSync(distPath);
const distText = distBytes.toString('utf8');

if (DUMP) {
  const dir = path.resolve(here, DUMP);
  fs.mkdirSync(dir, { recursive: true });
  const dump = (prefix, list) =>
    list.forEach((r, i) => {
      const safe = r.name.replace(/[\\/]/g, '_');
      fs.writeFileSync(path.join(dir, `${prefix}-${String(i).padStart(2, '0')}-${safe}.js`), r.text);
    });
  dump('dist', splitRegions(distText));
  dump('built', splitRegions(builtText));
  console.log(`已落盘区域文件到 ${dir}`);
  process.exit(0);
}

const baselineLabel = path.relative(here, distPath).replace(/\\/g, '/');
console.log(
  `基准：${baselineLabel}  ${distBytes.length} 字节  md5 ${crypto.createHash('md5').update(distBytes).digest('hex')}`
);
console.log(`重建：${Buffer.byteLength(builtText)} 字节，共 ${builtText.split('\n').length} 行\n`);

const builtRegions = new Map(splitRegions(builtText).map((r) => [r.name, r.text]));
const distRegions = new Map(splitRegions(distText).map((r) => [r.name, r.text]));

// 依赖图（node_modules 第三方模块的版本与行数）会随 lockfile 变动而漂移，不阻塞；
// 一方模块（src/**）与 banner 必须严格一致。
const INFO = new Set(['00-PRELUDE', 'ZZ-BANNER']);
const names = [];
for (const n of distRegions.keys()) names.push(n);
for (const n of builtRegions.keys()) if (!distRegions.has(n)) names.push(n);

let failed = 0;
const rows = [];
for (const name of names) {
  if (ONLY && name !== ONLY) continue;
  const d = distRegions.get(name);
  const b = builtRegions.get(name);
  if (d === undefined || b === undefined) {
    const who = d === undefined ? 'dist 中没有该区域' : '构建结果中没有该区域';
    rows.push([name, `${d ? d.split('\n').length : 0}/${b ? b.split('\n').length : 0} 行`, 'MISSING', `  ${who}`]);
    if (!INFO.has(name)) failed++;
    continue;
  }
  const dl = d.split('\n').length;
  const bl = b.split('\n').length;
  if (name === '00-PRELUDE') {
    const info = preludeInfo(distText, builtText);
    const same = d === b;
    const verdict = same ? 'IDENTICAL' : info.ok ? 'INFO-DIFFER' : 'DIFFER';
    rows.push([name, `${dl}/${bl} 行`, verdict, `  ${info.msg}`]);
    if (!same && !info.ok) failed++;
    continue;
  }
  const norm = PORTING ? normalizePorting : normalize;
  if (d === b) {
    rows.push([name, `${dl}/${bl} 行`, 'IDENTICAL', '']);
  } else if (norm(d) === norm(b)) {
    rows.push([name, `${dl}/${bl} 行`, PORTING ? 'EQUAL(历史基准)' : 'EQUAL(忽略转义)', '']);
  } else {
    rows.push([name, `${dl}/${bl} 行`, 'DIFFER', diffSummary(norm(d), norm(b))]);
    if (!INFO.has(name)) failed++;
  }
}

const width = Math.max(...rows.map((r) => r[0].length), 8);
console.log('区域'.padEnd(width) + '  行数(dist/built)  结论');
for (const [name, lines, verdict, detail] of rows) {
  console.log(`${name.padEnd(width)}  ${lines.padEnd(16)}  ${verdict}`);
  if (detail) console.log(detail);
}

if (failed === 0) {
  const mode = PORTING
    ? '（--porting：整行注释 / void 0≡undefined / 尾逗号 / 多声明符展开 / function( 空格 / 引号风格 / 裸 require≡ESM import 视为等价）'
    : '';
  if (ONLY) {
    console.log(`\n✅ 区域 ${ONLY} 与基准产物一致${mode}（仅比对了该区域，其他区域未检查）。`);
  } else {
    const infoRows = rows.filter((r) => INFO.has(r[0]) && r[2] !== 'IDENTICAL').map((r) => r[0]);
    console.log(
      `\n✅ 一方代码与 banner 与 dist/index.js 完全一致${mode}（共 ${rows.length} 个区域，另含等价区域）。`
    );
    if (infoRows.length) {
      console.log(`   依赖区 ${infoRows.join('、')} 为 INFO：只校验依赖图一致，允许包版本漂移。`);
    }
  }
  process.exit(0);
}
console.log(`\n❌ ${failed} 个区域与基准产物不一致 —— dist 与 src/ 已漂移。`);
if (!PORTING) {
  console.log(
    '   若差异只是「整行注释 / void 0 / 尾逗号 / 多声明符 / function( 空格 / 引号 / 裸 require」，那是历史手工基准的已知限制，可加 --porting 复核。'
  );
}
process.exit(1);
