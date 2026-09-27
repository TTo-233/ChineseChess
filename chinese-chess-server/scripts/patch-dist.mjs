#!/usr/bin/env node
/**
 * patch-dist.mjs —— 对 dist/index.js 施加（或校验）运行时补丁
 *
 * ============================ ⚠️ 必读 ============================
 * 本目录是**自包含部署产物**：没有 src/、没有 tsconfig.json、没有 sourcemap。
 * dist/index.js 只能手工修改，而手工修改会在下一次「重新打包/换版本」时被覆盖，
 * 导致改动丢失 —— 所以每一条改动都必须在本脚本里留一份可重放的补丁。
 *
 * 本脚本当前承载两条补丁（都幂等、都进 --check 闸门）：
 *
 *   补丁一「长将长捉不拦截」：删掉服务端对禁着的二次拦截与「连续 3 次判负」。
 *     丢失症状：客户端能走的着法被服务端以 400「禁着，请变招」拒绝。
 *   补丁二「畸形 FEN 行宽校验」：在进入 Pikafish WASM 之前拦下行宽 ≠ 9 的 FEN。
 *     丢失症状：畸形 FEN 让 WASM 越界写内存（memory access out of bounds），
 *     4 个 worker 一起崩，/api/v1/ai/move 返回 500、/api/v1/ai/stats 的 ready 掉到 3。
 *
 * 本文件因此是这两条规则的**唯一权威载体**：
 *   1. 补丁是**幂等**的：已打过则 no-op，不会重复注入。
 *   2. 补丁是**可校验**的：`node scripts/patch-dist.mjs --check`
 *      会被 scripts/start.mjs 在每次启动前自动执行；任一补丁丢失则拒绝启动。
 *   3. 每次改动 dist/index.js 之后，必须重新跑一次
 *      `node scripts/patch-dist.mjs` 把补丁打回去。
 *
 * 用法：
 *   node scripts/patch-dist.mjs                     # 打补丁（已打则 no-op）
 *   node scripts/patch-dist.mjs --check             # 只校验，不修改（缺失则 exit 1）
 *   node scripts/patch-dist.mjs --restore-marker     # 仅补回丢失的补丁标记（逻辑本就正确时用）
 * ===================================================================
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist', 'index.js');

/** 已打补丁的标记注释（必须与下方 PATCH_NOTE 逐字一致，用于幂等识别） */
const PATCH_NOTE = '长将长捉超限不再拦截落子、不再按违规次数判负（方案 10 娱乐向改造）';

/** 要被删除的运行时逻辑：服务端对禁着的二次拦截 + 违规计数判负 */
const ANCHOR = 'if (ruleEngine.isMoveBanned(state, pieceId, toCol, toRow)) {';

/** 补丁替代内容：只留说明，不含任何拦截逻辑（其后紧跟的原有「服务端权威裁决」注释保持不变） */
const REPLACEMENT = [
  '    // 长将长捉超限不再拦截落子、不再按违规次数判负（方案 10 娱乐向改造）：',
  '    // banMoves 仅用于客户端棋盘标红提示；双方僵持不下由自然限招/互长将互长捉判和收场。',
  '    // ⚠️ 本段由 scripts/patch-dist.mjs 注入，勿手改；dist 换版后需重跑该脚本（见该文件头注释）。',
].join('\n');

// ============================ 补丁二：畸形 FEN 拦截 ============================
/**
 * 背景：棋盘行宽不为 9 的畸形 FEN（例如某行写成 `10`）会让 Pikafish WASM 解析器
 * 越界写线性内存，4 个 worker 一起崩成 `memory access out of bounds`，
 * 表现为「引擎实例异常，请重试」+ /ai/stats 的 ready 4→3，且要靠自动重建才能恢复。
 * 因此在 FEN 解析入口（进 WASM 之前）就把它挡下来，返回 400。
 */
const FEN_PATCH_NOTE = '畸形 FEN 行宽校验（在进入 Pikafish WASM 之前拦截，避免越界写内存打崩 worker 池）';

/** 注入点：aiRouter 的 fen 空值校验之后，作为第二道 400 防线 */
const FEN_ANCHOR = 'if (!fen) {';

/** 辅助函数插入点：UCI_RE 定义紧前方（与 UCI_RE 同属 AI 路由的模块级常量区） */
const FEN_HELPER_ANCHOR = 'var UCI_RE = /^[a-i][0-9][a-i][0-9]$/;';

/** 注入到模块级的行宽校验函数（IIFE 风格，保持与 esbuild 产物一致的写法） */
const FEN_HELPER = [
  `// ${FEN_PATCH_NOTE}：行宽异常会让 Pikafish WASM 越界写内存并打崩整个 worker 池。`,
  '// ⚠️ 本段由 scripts/patch-dist.mjs 注入，勿手改；dist 换版后需重跑该脚本。',
  'var FEN_ROWS = 10, FEN_COLS = 9;',
  'var isFenBoardShapeValid = function (fenStr) {',
  '  var parts = String(fenStr).trim().split(/\\s+/);',
  '  var rows = parts[0] ? parts[0].split("/") : [];',
  '  if (rows.length !== FEN_ROWS) return false;',
  '  for (var r = 0; r < rows.length; r++) {',
  '    var width = 0;',
  '    for (var i = 0; i < rows[r].length; i++) {',
  '      var ch = rows[r][i];',
  '      if (ch >= "0" && ch <= "9") {',
  '        if (ch === "0") return false;',
  '        width += Number(ch);',
  '      } else if (/[a-z]/i.test(ch)) {',
  '        width += 1;',
  '      } else {',
  '        return false;',
  '      }',
  '      if (width > FEN_COLS) return false;',
  '    }',
  '    if (width !== FEN_COLS) return false;',
  '  }',
  '  return true;',
  '};',
].join('\n');

/** 注入到 /move 路由内的 400 拦截块（首行注释逐字包含 FEN_PATCH_NOTE，作为幂等标记） */
const FEN_GUARD = [
  '  if (!isFenBoardShapeValid(fen)) {',
  `    // ${FEN_PATCH_NOTE}`,
  '    // ⚠️ 本段由 scripts/patch-dist.mjs 注入，勿手改；dist 换版后需重跑该脚本。',
  '    res.status(400).json({ success: false, error: "invalid_fen", message: "fen \\u677F\\u9762\\u884C\\u5BBD\\u975E\\u6CD5" });',
  '    return;',
  '  }',
].join('\n');

/**
 * 从 `start` 处的 `if (...) {` 起，按花括号配平找出整块 if 语句的结束位置。
 * @returns {number} 结束花括号之后的下标
 */
function findBlockEnd(src, start) {
  const open = src.indexOf('{', start);
  if (open < 0) throw new Error('未找到 if 语句的左花括号');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    // 字符串里出现花括号会破坏配平；跳过字符串字面量
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
    }
  }
  throw new Error('花括号未配平，dist/index.js 结构可能已变化');
}

/**
 * 在 actMove 的落子调用点（`const result = ruleEngine.makeMove(...)`）之前插入补丁标记。
 * 正常打补丁与 --restore-marker 两条路径共用此函数，保证产物逐字符一致。
 * REPLACEMENT 自带每行缩进，因此这里只补行首换行、不再重复加 indent。
 */
function insertMarker(src) {
  return src.replace(
    /(?<=\n)( +)(const result = ruleEngine\.makeMove\(state, pieceId, toCol, toRow\);)/,
    (m, indent, line) => `${REPLACEMENT}\n${indent}${line}`,
  );
}

function analyze(src) {
  return {
    patched: src.includes(PATCH_NOTE),
    hasAnchor: src.includes(ANCHOR),
    hasRecordBanViolation: src.includes('ruleEngine.recordBanViolation'),
  };
}

/** 补丁二（畸形 FEN 拦截）的状态分析 */
function analyzeFen(src) {
  return {
    fenPatched: src.includes(FEN_PATCH_NOTE),
    hasFenHelper: src.includes('var isFenBoardShapeValid = function'),
    hasFenGuard: src.includes('if (!isFenBoardShapeValid(fen)) {'),
  };
}

/**
 * 注入补丁二：模块级 `isFenBoardShapeValid` 辅助函数 + /move 路由内的 400 拦截块。
 * 幂等：已注入（FEN_PATCH_NOTE 存在）则原样返回。
 * @returns {string} 注入后的源码
 */
function insertFenGuard(src) {
  if (src.includes(FEN_PATCH_NOTE)) return src;
  if (!src.includes(FEN_HELPER_ANCHOR)) {
    throw new Error('找不到 FEN 补丁的辅助函数插入点（UCI_RE 定义）；dist 可能已换版');
  }
  if (!src.includes(FEN_ANCHOR)) {
    throw new Error('找不到 FEN 补丁的 400 拦截插入点（if (!fen) {）；dist 可能已换版');
  }
  // 辅助函数必须先进来（路由体在文件中靠后，var 声明会提升，但保持源码可读性仍先注入模块级）。
  let out = src.replace(FEN_HELPER_ANCHOR, `${FEN_HELPER}\n${FEN_HELPER_ANCHOR}`);
  // 拦截块插在 `if (!fen) { … }` 整块之后：借 findBlockEnd 吃掉该块，顺带把守卫放在其后。
  const start = out.indexOf(FEN_ANCHOR);
  const end = findBlockEnd(out, start);
  const cutEnd = out[end] === '\n' ? end + 1 : end;
  out = out.slice(0, cutEnd) + FEN_GUARD + '\n' + out.slice(cutEnd);
  return out;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const restoreMarker = process.argv.includes('--restore-marker');
  if (!fs.existsSync(DIST)) {
    fail(`找不到 ${DIST}——部署包不完整，无法打补丁`);
  }
  const src = fs.readFileSync(DIST, 'utf8');

  // ------------------------------------------------------------------
  // 补丁二（畸形 FEN 拦截）：纯增量 + 幂等，与补丁一的处理互不依赖，
  // 所以先跑。--check 时同样参与闸门：缺任一条补丁都拒绝启动。
  // ------------------------------------------------------------------
  let working = src;
  let fenChanged = false;
  if (!analyzeFen(working).fenPatched) {
    if (checkOnly) {
      fail(
        '⚠️ dist/index.js 缺少「畸形 FEN 行宽校验」补丁！\n' +
        '  行宽异常的 FEN 会让 Pikafish WASM 越界写内存、打崩整个 worker 池，\n' +
        '  症状：/api/v1/ai/move 返回 500「皮卡鱼引擎实例异常」，且 /api/v1/ai/stats 的 ready 掉到 3。\n' +
        '  修复：node scripts/patch-dist.mjs',
      );
    }
    try {
      working = insertFenGuard(working);
    } catch (e) {
      fail(`注入「畸形 FEN 行宽校验」补丁失败：${e.message}`);
    }
    const afterFen = analyzeFen(working);
    if (!afterFen.fenPatched || !afterFen.hasFenHelper || !afterFen.hasFenGuard) {
      fail('注入后的产物状态不符合预期，已放弃写入（dist/index.js 未被修改）');
    }
    fenChanged = true;
  }

  // 写盘 + 读回校验的统一出口：两条补丁的标记都必须齐备。
  const commit = (next, message) => {
    fs.writeFileSync(DIST, next, 'utf8');
    const reread = fs.readFileSync(DIST, 'utf8');
    if (!reread.includes(PATCH_NOTE) || !reread.includes(FEN_PATCH_NOTE)) {
      fail('写入后读回校验失败，dist/index.js 可能处于未知状态，请检查');
    }
    console.log(message);
    return true;
  };

  const before = analyze(working);

  // --- 情形 0：拦截块已删、但补丁标记丢失 → 只把标记注回去 ---
  // 出现这种状态通常是手工删过注释，或 diff/裁剪工具顺手移除了未被识别的注释行；
  // 产物本身逻辑是对的（已无拦截），所以只补标记、不动逻辑。
  if (restoreMarker) {
    if (before.patched) {
      const msg = fenChanged ? 'patch-dist: 补丁标记已存在；已注入 FEN 行宽校验补丁' : 'patch-dist: 补丁标记已存在，无需处理（no-op）';
      return fenChanged ? commit(working, msg) : (console.log(msg), true);
    }
    if (before.hasAnchor || before.hasRecordBanViolation) {
      fail('--restore-marker 只适用于「拦截块已删、标记丢失」的状态；当前产物里还有禁着拦截逻辑，请直接执行 node scripts/patch-dist.mjs');
    }
    const markerSrc = insertMarker(working);
    if (markerSrc === working) {
      fail('找不到 ruleEngine.makeMove(...) 的落子调用点，无法定位标记插入位置；请人工确认 actMove 并在 scripts/patch-dist.mjs 中调整插入锚点');
    }
    const after = analyze(markerSrc);
    if (!after.patched || after.hasAnchor || after.hasRecordBanViolation) {
      fail('补标记后的产物状态不符合预期，已放弃写入（dist/index.js 未被修改）');
    }
    return commit(
      markerSrc,
      fenChanged
        ? 'patch-dist: 已补回补丁标记（拦截块本就缺失，未改动逻辑）+ FEN 行宽校验补丁'
        : 'patch-dist: 已补回补丁标记（拦截块本就缺失，未改动逻辑）',
    );
  }

  // --- 情形 1：已打过补丁 ---
  if (before.patched) {
    if (before.hasAnchor || before.hasRecordBanViolation) {
      fail(
        'dist/index.js 同时存在补丁标记和被拦截的禁着逻辑，说明文件被手工改乱。\n' +
        '  请从版本库恢复 dist/index.js 后重跑：node scripts/patch-dist.mjs',
      );
    }
    return fenChanged
      ? commit(working, 'patch-dist: 禁着拦截补丁已存在；已注入 FEN 行宽校验补丁')
      : (console.log('patch-dist: 补丁已存在，无需处理（no-op）'), true);
  }

  // --- 情形 2：只有 --check ---
  if (checkOnly) {
    fail(
      '⚠️ dist/index.js 缺少「长将长捉不拦截」补丁！\n' +
      '  服务端会重新启用已废弃的禁着拦截与「连续 3 次判负」逻辑，\n' +
      '  症状：客户端能走的着法被服务端以 400「禁着，请变招」拒绝。\n' +
      '  修复：node scripts/patch-dist.mjs',
    );
  }

  // --- 情形 3：需要打补丁 ---
  if (!before.hasAnchor) {
    fail(
      'dist/index.js 里找不到预期的禁着拦截锚点：\n' +
      `  ${ANCHOR}\n` +
      '  两种可能，请分别处理：\n' +
      '  (a) dist/index.js 很可能已经换版（结构变化）——请人工确认 actMove 中是否还有\n' +
      '      isMoveBanned/recordBanViolation 拦截，并相应更新本脚本的 ANCHOR 后重跑。\n' +
      '  (b) 拦截块已被删除但补丁标记也丢失（例如手工删注释、diff 工具裁剪未使用行）——\n' +
      '      此时直接补回标记即可：node scripts/patch-dist.mjs --restore-marker',
    );
  }

  const start = working.indexOf(ANCHOR);
  // 往前吃掉紧邻的注释行（换行后的缩进 + // 到行尾）
  let lineStart = working.lastIndexOf('\n', start) + 1;
  let blockStart = start;
  for (;;) {
    const prevLineStart = working.lastIndexOf('\n', lineStart - 2) + 1;
    const prevLine = working.slice(prevLineStart, lineStart - 1);
    if (prevLineStart === 0 || !/^\s*(\/\/|$)/.test(prevLine)) break;
    blockStart = prevLineStart;
    lineStart = prevLineStart;
  }
  const end = findBlockEnd(working, start);
  // 连带吃掉紧随其后的换行
  const cutEnd = working[end] === '\n' ? end + 1 : end;

  // 先把整块删掉，再在 makeMove 落子调用之前插入标记。
  // 插入点与 --restore-marker 路径完全一致（都锚在 makeMove 那行），
  // 因此无论走哪条路径，产物都逐字符相同——测试第 13 项锁死这一点。
  const withoutBlock = working.slice(0, blockStart) + working.slice(cutEnd);
  const patched = insertMarker(withoutBlock);

  // --- 静态校验：产物里不得再有任何禁着拦截残留 ---
  const after = analyze(patched);
  if (after.hasAnchor || after.hasRecordBanViolation) {
    fail('补丁后仍检测到 isMoveBanned/recordBanViolation 残留，已放弃写入（dist/index.js 未被修改）');
  }

  return commit(
    patched,
    `patch-dist: 已删除禁着拦截块 ${cutEnd - blockStart} B` +
      (fenChanged ? '，并注入 FEN 行宽校验补丁' : '（no-op）') +
      `（dist/index.js ${Buffer.byteLength(src)} B -> ${Buffer.byteLength(patched)} B）`,
  );
}

function fail(msg) {
  console.error(`\n❌ patch-dist: ${msg}\n`);
  process.exit(1);
}

// 作为脚本被直接执行时跑 main()；被 start.mjs `import` 时只导出校验函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  main,
  analyze,
  analyzeFen,
  findBlockEnd,
  insertMarker,
  insertFenGuard,
  DIST,
  PATCH_NOTE,
  ANCHOR,
  FEN_PATCH_NOTE,
  FEN_ANCHOR,
  FEN_HELPER_ANCHOR,
};
