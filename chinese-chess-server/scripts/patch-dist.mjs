#!/usr/bin/env node
/**
 * patch-dist.mjs —— 对 dist/index.js 施加（或校验）运行时补丁
 *
 * ============================ ⚠️ 必读 ============================
 * 本目录是**自包含部署产物**：没有 src/、没有 tsconfig.json、没有 sourcemap。
 * dist/index.js 只能手工修改，而手工修改会在下一次「重新打包/换版本」时被覆盖，
 * 导致改动丢失 —— 所以每一条改动都必须在本脚本里留一份可重放的补丁。
 *
 * 本脚本当前承载五条补丁（都幂等、都进 --check 闸门）：
 *
 *   补丁一「长将长捉不拦截」：删掉服务端对禁着的二次拦截与「连续 3 次判负」。
 *     丢失症状：客户端能走的着法被服务端以 400「禁着，请变招」拒绝。
 *   补丁二「畸形 FEN 行宽校验」：在进入 Pikafish WASM 之前拦下行宽 ≠ 9 的 FEN。
 *     丢失症状：畸形 FEN 让 WASM 越界写内存（memory access out of bounds），
 *     4 个 worker 一起崩，/api/v1/ai/move 返回 500、/api/v1/ai/stats 的 ready 掉到 3。
 *   补丁三/四「初始局面上传校验」：收紧旧协议的完整局面上传分支
 *     （POST /rooms/:roomId/gameState 不带 move）。
 *     丢失症状：**任何人只要知道 6 位房间号，就能匿名改写对局棋盘、甚至伪造胜负**
 *     （详见下方补丁三头部的完整分析）。
 *   补丁五「被拒绝的动作回推权威状态」：respondAction 在 4xx 时也广播一次房间状态。
 *     丢失症状：被拒绝的动作（不是你的回合 / 非法走法 / 送将 / 请求已被处理）
 *     客户端完全无感知，落子的乐观更新与"等待对方同意"会永久留在界面上。
 *     与规则引擎侧的送将过滤是配套的 —— 服务端一旦开始拒着法，就必须让客户端知道。
 *
 * 本文件因此是这几条规则的**唯一权威载体**：
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

// ==================== 补丁三/四：初始局面上传校验（越权改写对局棋盘） ====================
/**
 * 背景（已核查的漏洞）：actMove 的「旧协议」分支——即 `POST /rooms/:roomId/gameState`
 * 的 body 带 gameState 而不带 move 时——**没有任何门控**：不校验阶段、不校验座位、
 * 甚至不读 playerId（只需房间号），直接 `room.gameState = gameState;` 并把随请求带来的
 * `gameOver`/`winner` 写进房间终局状态。
 *
 * 该分支的唯一合法用途是「上传初始局面」：开局时由选边方用 `applyHandicap(createInitialState())`
 * 的结果建立棋盘，此后所有着法都走 actMove 新协议分支（服务端规则引擎权威裁决）。
 * 但旧分支在任何阶段都可达，于是：
 *   - 任何人只需知道 6 位房间号，就能 POST 一个完整局面改写正在进行中的棋盘，并立即广播给
 *     双方与所有观战者（房间号是 Math.floor(1e5 + Math.random()*9e5)，≤90 万，可枚举）；
 *   - 附加 `{"gameOver":true,"winner":"red"}` 即可凭空终局、伪造胜负；`winner:"draw"` 伪造和棋；
 *   - 该写入还会顺手清掉 pendingUndo/pendingDraw，掐断正在进行的悔棋/求和协商；
 *   - 服务端之后会**以这个被污染的棋盘继续裁决**（下一手用 ruleEngine 校验该棋盘）；
 *   - actStart 不重置 room.gameState，因此 waiting 阶段种下的伪造局面会存活进新对局。
 * （另一条 WS `move` 通道同样能进这个分支，但 WS 侧有座位与观战者校验，HTTP 侧完全没有。）
 *
 * 客户端确认：唯一调用方是 lanBattle 的 uploadInitialGame，body 为 `{playerId, gameState}`，
 * 其中 gameState 是 `applyHandicap(createInitialState(), 房间让子)`——**moveHistory 必为空数组**，
 * 且请求确实带 playerId，因此下面的收紧不会误伤这条唯一合法路径。
 */
const UPLOAD_PATCH_NOTE = '初始局面上传收紧：仅房内玩家、且仅在本局尚未产生任何着法时可上传（防匿名改写棋盘/伪造胜负）';

/**
 * 注入点：旧协议分支里「真正开始产生副作用」的第一行，即时钟扣减条件的判断。
 * ⚠️ 不要锚 `room.gameState = gameState;`：那会把校验放在时钟扣减**之后**，
 * 被拒绝的请求仍会先改写 room.clocks。必须锚在副作用块之前。
 * ⚠️ 也不要用多行锚点（例如把上方注释一起写进来）：实测该分支的注释与代码之间
 * 夹着一行只含空白的行，多行锚点永远匹配不上（首次实现踩过这个坑）。
 */
const UPLOAD_ANCHOR = '  if (room.clocks && nextMoveCount > prevMoveCount && room.lastMoveTime) {';

/**
 * 注入的保护块 + 原锚点行。校验必须在**任何副作用之前**（含时钟扣减），
 * 且被拒绝时直接 return（不得穿透到下方的 lastMoveTime/pendingUndo/pendingDraw
 * 清理与 gameOver 终局副作用）。
 * 幂等标记是首行完整注释，因此 diff/裁剪工具只会整除整段。
 */
const UPLOAD_GUARD = [
  `  // ${UPLOAD_PATCH_NOTE}。`,
  '  // 理由：该分支是「旧协议完整局面上传」，唯一合法用途是建立初始局面；',
  '  // 若不加这道校验，任何人仅凭房间号就能越过规则引擎直接改写对局棋盘并伪造胜负。',
  '  // 约束「本局尚无着法」而非「阶段为 waiting」：waiting 阶段 room.gameState 本就为 null，',
  '  // 而在线对局在选边公示结束前就可能已把 phase 置为 playing，此时客户端上传的正是第一个局面，',
  '  // 若改判 phase 会把唯一合法上传路径一起拒掉、导致对局永远没有棋盘。',
  '  // ⚠️ 本段由 scripts/patch-dist.mjs 注入，勿手改；dist 换版后需重跑该脚本。',
  '  var uploader = room.players && room.players.find(function (p) { return p.id === body.playerId; });',
  '  if (!uploader) {',
  '    return { status: 403, body: { success: false, error: "forbidden", message: "\\u4EC5\\u623F\\u95F4\\u5185\\u73A9\\u5BB6\\u53EF\\u4E0A\\u4F20\\u521D\\u59CB\\u5C40\\u9762" } };',
  '  }',
  '  if (prevMoveCount !== 0 || nextMoveCount !== 0) {',
  '    return { status: 403, body: { success: false, error: "forbidden", message: "\\u672C\\u5C40\\u5DF2\\u4EA7\\u751F\\u7740\\u6CD5\\uFF0C\\u4E0D\\u63A5\\u53D7\\u5B8C\\u6574\\u5C40\\u9762\\u4E0A\\u4F20" } };',
  '  }',
  UPLOAD_ANCHOR,
].join('\n');

/** 补丁四：删掉旧协议分支里由请求体驱动的终局副作用（初始局面永不可能是终局） */
const GAME_OVER_ANCHOR = 'if (gameOver && winner) {';

/**
 * 从块首往前吃掉紧邻的注释行与空行，让删除范围包含说明该块的注释。
 * @returns {number} 块首（含前置注释）的起始下标
 */
function findLeadingCommentStart(src, blockStart) {
  let lineStart = src.lastIndexOf('\n', blockStart - 1) + 1;
  let start = lineStart;
  for (;;) {
    if (lineStart === 0) break;
    const prevLineStart = src.lastIndexOf('\n', lineStart - 2) + 1;
    const prevLine = src.slice(prevLineStart, lineStart - 1);
    if (!/^\s*(\/\/|$)/.test(prevLine)) break;
    start = prevLineStart;
    lineStart = prevLineStart;
  }
  return start;
}

/** 删除旧协议分支里的 `if (gameOver && winner) { ... }` 整块；幂等（已删则原样返回） */
function removeGameOverBlock(src) {
  const at = src.indexOf(GAME_OVER_ANCHOR);
  if (at < 0) return src;
  const blockStart = findLeadingCommentStart(src, src.lastIndexOf('\n', at) + 1);
  const end = findBlockEnd(src, at);
  const cutEnd = src[end] === '\n' ? end + 1 : end;
  return src.slice(0, blockStart) + src.slice(cutEnd);
}

/**
 * 注入补丁三/四：先删掉请求体驱动的终局副作用，再把上传校验插到落盘赋值之前。
 * 幂等：uploadPatched 为真则原样返回。
 * @returns {string} 注入后的源码
 */
function insertUploadGuard(src) {
  if (analyzeUpload(src).uploadPatched) return src;
  let out = removeGameOverBlock(src);
  if (!out.includes(UPLOAD_ANCHOR)) {
    throw new Error('找不到初始局面上传的落盘赋值锚点；dist 可能已换版');
  }
  out = out.replace(UPLOAD_ANCHOR, UPLOAD_GUARD);
  return out;
}

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

/** 补丁三/四（初始局面上传校验）的状态分析 */
function analyzeUpload(src) {
  const hasUploadGuard = src.includes(UPLOAD_PATCH_NOTE);
  const hasUploadAnchor = src.includes(UPLOAD_ANCHOR);
  const hasGameOverBlock = src.includes(GAME_OVER_ANCHOR);
  return {
    hasUploadGuard,
    hasUploadAnchor,
    hasGameOverBlock,
    uploadPatched: hasUploadGuard && hasUploadAnchor && !hasGameOverBlock,
  };
}

/**
 * 补丁三/四的稳定不变量：**补丁标记的存在必须与「防伪保护确实生效」完全同真同假**。
 * 用它做写盘闸门（而不是单独查几个标记），可以同时挡住两类事故：
 *   - 标记丢了但拦截逻辑还在 → 已生效的保护会在下次基于上游新版 dist 重新打补丁时
 *     被静默跳过（replace 不命中，不报错），保护悄悄消失；
 *   - 标记在但拦截逻辑丢了 → --check 会误报「已打补丁」，实际大门敞开。
 */
function uploadInvariantHolds(src, expectedPatched) {
  const s = analyzeUpload(src);
  return s.uploadPatched === expectedPatched;
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

// ============================================================================
// 补丁五：被拒绝的动作要把权威状态推回客户端
// ============================================================================

const SYNC_REJECT_PATCH_NOTE =
  '被拒绝的动作回推权威状态（客户端只按 <400 收 state，被拒动作会导致画面永久停在乐观更新后的样子）';

/** respondAction 的函数声明行，用它定位插入点（全文件唯一） */
const RESPOND_FN_ANCHOR = 'function respondAction(res, roomId, result) {';
/** 幂等标记：注入块自带 */
const SYNC_REJECT_MARKER = 'var syncRejectionCount = 0;';
/**
 * respondAction 里的老写法。
 * ⚠️ **必须包含前导换行**：替换时吃掉的区间是
 * `function respondAction(...) {` + 紧随其后的 `\n  if (result.status < 400) {`，
 * 若漏掉那个 `\n`，替换后老函数体（`const room = rooms.get(...)` 等）会与注入块之间
 * 缺少换行、并在结尾多出一个孤立的 `}`，产出无法解析的 dist（首次实现就踩了这一步）。
 */
const SYNC_REJECT_OLD_BODY = '\n  if (result.status < 400) {';
/** 上式只吃掉到 `{` 为止，它对应的 `}` 也要一并吃掉（缩进 2 空格） */
const SYNC_REJECT_OLD_BODY_CLOSER = '\n  }';

const SYNC_REJECT_BLOCK_HEAD = [
  `// ${SYNC_REJECT_PATCH_NOTE}`,
  '// ⚠️ 本段由 scripts/patch-dist.mjs 注入，勿手改；dist 换版后需重跑该脚本（见该文件头注释）。',
  '//',
  '// 被拒绝的动作必须把**权威状态**也回推给双方。',
  '// 客户端应用服务端状态的唯一入口是 state 帧 / GET /rooms/:id/gameState，',
  '// 而服务端原本只在 result.status < 400 时才广播（且广播的是当前 room 状态）；',
  '// 于是"不是你的回合""非法走法（含送将）""对方的悔棋请求已被处理"这类拒绝',
  '// 会让客户端毫无感知：落子的乐观更新留在盘上、悔棋按钮停在"等待对方同意"，',
  '// 直到下一次成功动作才被顺带纠正。',
  '//',
  '// 这里在非 2xx 时补一次广播（room 未变，所以推过去的正是权威局面）。',
  '// 限流：同一房间 3 秒内最多 8 次，避免被连续非法请求刷屏；',
  '// 且只对 4xx 生效——5xx 属于服务端自身异常，不该顺手改写客户端对局画面。',
  'var syncRejectionCount = 0;',
  'function respondAction(res, roomId, result) {',
  '  var rejected = result.status >= 400;',
].join('\n');

const SYNC_REJECT_BLOCK_TAIL = [
  '  var roomForSync = rooms.get(roomId);',
  '  if (rejected && result.status < 500 && roomForSync) {',
  '    var nowSync = Date.now();',
  '    var lastSyncAt = roomForSync.lastRejectionSyncAt || 0;',
  '    if (nowSync - lastSyncAt >= 3000) {',
  '      syncRejectionCount = 0;',
  '    }',
  '    if (syncRejectionCount < 8) {',
  '      syncRejectionCount += 1;',
  '      roomForSync.lastRejectionSyncAt = nowSync;',
  '      roomBroadcaster(roomForSync);',
  '    }',
  '  }',
].join('\n');

/** 补丁五的状态分析 */
function analyzeSyncReject(src) {
  const hasSyncReject = src.includes(SYNC_REJECT_PATCH_NOTE);
  const hasMarker = src.includes(SYNC_REJECT_MARKER);
  const hasOldBody = src.includes(SYNC_REJECT_OLD_BODY);
  const hasFn = src.includes(RESPOND_FN_ANCHOR);
  return {
    hasSyncReject,
    hasMarker,
    hasOldBody,
    hasFn,
    // 注入块自身也包含 `if (result.status < 400) {`，所以不能把"老写法还在"当作未打补丁的判据；
    // 真正的判据是「NOTE 注释 + 计数变量 + respondAction 声明」三者齐备。
    syncRejectPatched: hasSyncReject && hasMarker && hasFn,
  };
}

/** 补丁五的稳定不变量：标记存在 ⟺ 反刷屏计数变量确实在代码里 */
function syncRejectInvariantHolds(src, expectedPatched) {
  const s = analyzeSyncReject(src);
  return s.syncRejectPatched === expectedPatched;
}

/**
 * 注入补丁五：替换 `function respondAction(...) {` + 紧随其后的老 2xx 判断。
 * 幂等：syncRejectPatched 为真则原样返回。
 * @returns {string} 注入后的源码
 */
function insertSyncReject(src) {
  if (analyzeSyncReject(src).syncRejectPatched) return src;
  const at = src.indexOf(RESPOND_FN_ANCHOR);
  if (at < 0) throw new Error('找不到 respondAction 函数声明；dist 可能已换版');
  // 老写法必须紧跟在函数声明之后（中间允许空行），否则说明结构变了，不动手。
  const after = src.slice(at + RESPOND_FN_ANCHOR.length);
  const bodyRel = after.indexOf(SYNC_REJECT_OLD_BODY);
  if (bodyRel < 0 || bodyRel > 200) {
    throw new Error('respondAction 函数体结构与预期不符（找不到 2xx 广播判断）；dist 可能已换版');
  }
  const bodyAbs = at + RESPOND_FN_ANCHOR.length + bodyRel;
  // 吃掉的范围 = 函数声明行 + `\n  if (result.status < 400) {` + 该 if 的结束 `\n  }`。
  // 那个结束花括号在原文里紧跟 `if (room) roomBroadcaster(room);` 之后；
  // 它与 SYNC_REJECT_OLD_BODY 之间就是原来的两行函数体，必须一起删掉（否则残留未声明的 room 引用）。
  const afterOld = bodyAbs + SYNC_REJECT_OLD_BODY.length;
  const closerAt = src.indexOf(SYNC_REJECT_OLD_BODY_CLOSER, afterOld);
  if (closerAt < 0 || closerAt - afterOld > 200) {
    throw new Error('respondAction 老函数体结构与预期不符（找不到 2xx 块的结束花括号）；dist 可能已换版');
  }
  // ⚠️ 这里**刻意不复用 SYNC_REJECT_OLD_BODY** 来拼中间段：它是以 `\n` 开头的，
  // 直接接在 HEAD（结尾是 `{`）后面会变成 `{  if (...)`，产出粘行。
  // 各段自带换行、显式拼装。
  return (
    src.slice(0, at) +
    SYNC_REJECT_BLOCK_HEAD +
    '\n  if (result.status < 400) {\n' +
    '    syncRejectionCount = 0;\n  }\n' +
    SYNC_REJECT_BLOCK_TAIL +
    '\n' +
    src.slice(closerAt + SYNC_REJECT_OLD_BODY_CLOSER.length)
  );
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const restoreMarker = process.argv.includes('--restore-marker');
  if (!fs.existsSync(DIST)) {
    fail(`找不到 ${DIST}——部署包不完整，无法打补丁`);
  }
  const src = fs.readFileSync(DIST, 'utf8');

  // ------------------------------------------------------------------
  // 统一换行为 LF（一次性、幂等）：dist/index.js 历史上是 CRLF，而部分补丁锚点是
  // 多行字面量（含 `\n`，如补丁三的落盘赋值锚点），CRLF 会让它们永远匹配不上。
  // 逐条锚点去兼容 \r?\n 既啰嗦又容易漏，这里改成「先规范化、再打补丁」。
  // 该改动只涉及换行符，不影响 JavaScript 语义；规范化后，产物里每条补丁的锚点
  // 都只在一种换行约定下书写，长期更稳。已规范化时这里是 no-op。
  // ------------------------------------------------------------------
  let working = src.replace(/\r\n/g, '\n');

  // ------------------------------------------------------------------
  // 补丁二（畸形 FEN 拦截）：纯增量 + 幂等，与补丁一的处理互不依赖，
  // 所以先跑。--check 时同样参与闸门：缺任一条补丁都拒绝启动。
  // ------------------------------------------------------------------
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

  // ------------------------------------------------------------------
  // 补丁三/四（初始局面上传校验）：同样是纯增量 + 幂等，独立于补丁一。
  // --check 时也参与闸门——这条是安全性修复，缺失必须拒绝启动。
  // ------------------------------------------------------------------
  let uploadChanged = false;
  if (!analyzeUpload(working).uploadPatched) {
    if (checkOnly) {
      fail(
        '⚠️ dist/index.js 缺少「初始局面上传收紧」补丁！\n' +
        '  旧协议的完整局面上传分支没有门控：任何人只要知道 6 位房间号，就能匿名改写\n' +
        '  进行中的对局棋盘，并用 gameOver/winner 伪造胜负。\n' +
        '  修复：node scripts/patch-dist.mjs',
      );
    }
    try {
      working = insertUploadGuard(working);
    } catch (e) {
      fail(`注入「初始局面上传收紧」补丁失败：${e.message}`);
    }
    if (!uploadInvariantHolds(working, true)) {
      fail('注入后的产物状态不符合预期，已放弃写入（dist/index.js 未被修改）');
    }
    uploadChanged = true;
  }

  // ------------------------------------------------------------------
  // 补丁五（被拒动作回推权威状态）：同样是纯增量 + 幂等，独立于其它补丁。
  // 这条与送将拦截配套——服务端现在会拒绝送将着法，若拒绝不推状态，
  // 客户端会拿着"已经走成"的乐观画面一直等下去（见注入块注释）。
  // ------------------------------------------------------------------
  let syncRejectChanged = false;
  if (!analyzeSyncReject(working).syncRejectPatched) {
    if (checkOnly) {
      fail(
        '⚠️ dist/index.js 缺少「被拒绝的动作回推权威状态」补丁！\n' +
        '  服务端只在 2xx 时才广播状态，因此被拒绝的动作（不是你的回合 / 非法走法 /\n' +
        '  送将 / 请求已被处理）客户端完全无感知：落子的乐观更新会留在盘上、\n' +
        '  悔棋按钮会停在"等待对方同意"，直到下一次成功动作才被顺带纠正。\n' +
        '  修复：node scripts/patch-dist.mjs',
      );
    }
    try {
      working = insertSyncReject(working);
    } catch (e) {
      fail(`注入「被拒动作回推权威状态」补丁失败：${e.message}`);
    }
    if (!syncRejectInvariantHolds(working, true)) {
      fail('注入后的产物状态不符合预期，已放弃写入（dist/index.js 未被修改）');
    }
    syncRejectChanged = true;
  }

  // 写盘 + 读回校验的统一出口：补丁标记与真实性的不变量都必须成立。
  const commit = (next, message) => {
    fs.writeFileSync(DIST, next, 'utf8');
    const reread = fs.readFileSync(DIST, 'utf8');
    if (!reread.includes(PATCH_NOTE) || !reread.includes(FEN_PATCH_NOTE)) {
      fail('写入后读回校验失败，dist/index.js 可能处于未知状态，请检查');
    }
    if (!uploadInvariantHolds(reread, true)) {
      fail('写入后读回校验失败（初始局面上传保护未生效），请检查 dist/index.js');
    }
    if (!syncRejectInvariantHolds(reread, true)) {
      fail('写入后读回校验失败（被拒动作状态回推未生效），请检查 dist/index.js');
    }
    console.log(message);
    return true;
  };

  // 本轮改动摘要：另几条补丁是纯增量的，任何一次执行都可能顺带把它们补上，
  // 输出必须如实反映，否则「no-op」字样会掩盖刚刚发生的安全修复。
  const extras = [];
  if (fenChanged) extras.push('FEN 行宽校验补丁');
  if (uploadChanged) extras.push('初始局面上传收紧补丁');
  if (syncRejectChanged) extras.push('被拒动作回推权威状态补丁');
  const withExtras = msg => (extras.length ? `${msg}；已注入 ${extras.join(' + ')}` : msg);

  const before = analyze(working);

  // --- 情形 0：拦截块已删、但补丁标记丢失 → 只把标记注回去 ---
  // 出现这种状态通常是手工删过注释，或 diff/裁剪工具顺手移除了未被识别的注释行；
  // 产物本身逻辑是对的（已无拦截），所以只补标记、不动逻辑。
  if (restoreMarker) {
    if (before.patched) {
      const msg = withExtras('patch-dist: 补丁标记已存在，无需处理（no-op）');
      return extras.length ? commit(working, msg) : (console.log(msg), true);
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
    return commit(markerSrc, withExtras('patch-dist: 已补回补丁标记（拦截块本就缺失，未改动逻辑）'));
  }

  // --- 情形 1：已打过补丁 ---
  if (before.patched) {
    if (before.hasAnchor || before.hasRecordBanViolation) {
      fail(
        'dist/index.js 同时存在补丁标记和被拦截的禁着逻辑，说明文件被手工改乱。\n' +
        '  请从版本库恢复 dist/index.js 后重跑：node scripts/patch-dist.mjs',
      );
    }
    const msg = withExtras('patch-dist: 禁着拦截补丁已存在，无需重复注入');
    return extras.length ? commit(working, msg) : (console.log(msg), true);
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
      (extras.length ? `，并注入 ${extras.join(' + ')}` : '（no-op）') +
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
  analyzeUpload,
  findBlockEnd,
  findLeadingCommentStart,
  insertMarker,
  insertFenGuard,
  insertUploadGuard,
  removeGameOverBlock,
  DIST,
  PATCH_NOTE,
  ANCHOR,
  FEN_PATCH_NOTE,
  FEN_ANCHOR,
  FEN_HELPER_ANCHOR,
  UPLOAD_PATCH_NOTE,
  UPLOAD_ANCHOR,
  GAME_OVER_ANCHOR,
  SYNC_REJECT_PATCH_NOTE,
  SYNC_REJECT_MARKER,
  RESPOND_FN_ANCHOR,
  analyzeSyncReject,
  insertSyncReject,
  syncRejectInvariantHolds,
};
