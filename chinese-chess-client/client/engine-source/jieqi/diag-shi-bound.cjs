/**
 * 确认 calcShi crossRiver 分支的行边界 bug。
 *
 * 代码（MoveCheck.ts:319-327）：
 *   if (crossRiver) {
 *     if (row >= 1 && row <= BOARD_ROWS - 2) {   // ← row 9 被排除
 *       ... row±1 四个落点 ...
 *     }
 *     return;                                     // ← row 0/9 直接「无着法」
 *   }
 *
 * 士只走斜行**一步**，落点是 `row±1`。`row+1` 越界的条件是 `row >= 10`，
 * 而 row 最大 9 ⇒ **向下永远不越界**；`row-1` 越界条件是 `row < 1`。
 * 所以正确的判据是 `row >= 1`（只需挡 row 0），或干脆逐个落点判。
 * 现在写成 `row >= 1 && row <= 8`，**把 row 9 的士判成无棋可走**。
 *
 * 后果：揭棋里一枚**已翻开的仕**走到底线（row 0 或 row 9）后就彻底僵死。
 * 引擎不会这样（它的 A@row9 能走），于是双方对同一局面产生分歧。
 *
 * 本脚本对照「本仓库走点」与「引擎 PV」，验证：
 *   · A@(2,9)（九宫外底线）本仓库给 0 步，引擎能走 ⇒ 我们错
 *   · A@(2,8)（九宫外）两边都应能走 4 个斜向
 *
 * 用法（⚠️ 切勿传命令行参数）。
 */
const path = require('path');
const fs = require('fs');
const here = __dirname;
const X = require(path.join(here, 'stress-entry.bundle.cjs'));
const { getValidMoves, isMoveKingSafe, RED_SIDE, BOARD_COLS, BOARD_ROWS } = X;

const createModule = require(path.join(here, 'jieqi.js'));
const WASM = fs.readFileSync(path.join(here, 'jieqi.wasm'));

function runSession(commands) {
  const text = commands.join('\n') + '\n';
  let pos = 0;
  const out = [];
  return new Promise((resolve, reject) => {
    const M = createModule({
      print: (t) => out.push(String(t)),
      printErr: (t) => out.push('[err] ' + String(t)),
      locateFile: (f) => (f.endsWith('.wasm') ? path.join(here, 'jieqi.wasm') : f),
      wasmBinary: WASM,
      stdin: () => (pos < text.length ? text.charCodeAt(pos++) : null),
      INCOMING_MODULE_JS_API: ['stdin', 'print', 'printErr', 'locateFile', 'noInitialRun', 'wasmBinary'],
    });
    Promise.resolve(M).then(() => setTimeout(() => resolve(out), 400), (e) => reject(e));
  });
}

async function askMoves(fen) {
  try {
    const r = await runSession(['uci', 'isready', `position fen ${fen}`, 'go depth 3', 'quit']);
    const b = (r.filter((l) => l.startsWith('bestmove'))[0] || '').replace('bestmove ', '').trim();
    // 用 go perft 风格拿不到全部走法；改为让引擎只走该子：把红帅困住做不了，
    // 所以这里只报告 bestmove 与是否存在任何一步。
    return b;
  } catch {
    return 'CRASH';
  }
}

const BK = 0, RK = 16, RSHOU = 17, RSHIANG = 19;

function toState(spec, sideToMove = RED_SIDE) {
  const qiPan = Array.from({ length: BOARD_COLS }, () => new Array(BOARD_ROWS).fill(-1));
  const pieces = Array.from({ length: 32 }, (_, i) => ({ id: i, col: -1, row: -1, alive: false }));
  const hiddenMask = new Array(32).fill(false);
  const revealedType = new Array(32).fill(null);
  for (const [id, col, row, rev] of spec) {
    qiPan[col][row] = id;
    pieces[id] = { id, col, row, alive: true };
    if (rev !== null) revealedType[id] = rev;
  }
  return { qiPan, pieces, sideTag: sideToMove, moveHistory: [], gameStatus: 'playing',
    isCheck: false, checkMessage: '', zobristHash: 0, variant: 'jieqi', hiddenMask, revealedType };
}

function toFen(spec, sideToMove = RED_SIDE) {
  const st = toState(spec, sideToMove);
  const CH = ['k','a','a','b','b','n','n','r','r','c','c','p','p','p','p','p',
              'K','A','A','B','B','N','N','R','R','C','C','P','P','P','P','P'];
  const MAP = { che: 'R', ma: 'N', pao: 'C', shi: 'A', xiang: 'B', bing: 'P', zu: 'p' };
  const rows = [];
  for (let r = 0; r < BOARD_ROWS; r++) {
    let line = '', gap = 0;
    for (let c = 0; c < BOARD_COLS; c++) {
      const id = st.qiPan[c][r];
      if (id === -1) { gap++; continue; }
      if (gap) { line += String(gap); gap = 0; }
      const rv = st.revealedType[id];
      const mc = rv ? MAP[rv] : null;
      line += mc ? (id <= 15 ? mc.toLowerCase() : mc) : CH[id];
    }
    if (gap) line += String(gap);
    rows.push(line);
  }
  return `${rows.join('/')} ${sideToMove === RED_SIDE ? 'w' : 'b'} A2P5N2B2 0 1`;
}

async function probe(label, spec, focusId) {
  const st = toState(spec);
  const pts = getValidMoves(st, focusId);
  const mine = [];
  for (let c = 0; c < BOARD_COLS; c++) {
    for (let r = 0; r < BOARD_ROWS; r++) if (pts[c][r]) mine.push(`(${c},${r})`);
  }
  const fen = toFen(spec);
  const e = await askMoves(fen);
  const p = st.pieces[focusId];
  console.log(`${label}`);
  console.log(`   位置      : (${p.col},${p.row})  id=${focusId}`);
  console.log(`   fen       : ${fen}`);
  console.log(`   本仓库走点: ${mine.length} 个 → ${mine.join(' ') || '（无）'}`);
  console.log(`   引擎 best : ${e}`);
  console.log('');
}

async function main() {
  console.log('=== calcShi crossRiver 行边界 bug 验证 ===\n');
  console.log('（红帅放 (8,9) 远离该子，使其不构成白脸将干扰）\n');

  console.log('--- 仕在九宫外、常规行 ---');
  await probe('A@(2,8) 九宫外 row8', [[BK, 4, 0], [RK, 8, 9], [RSHIANG, 2, 8, 'shi']], RSHIANG);
  await probe('A@(2,6) 半场 row6', [[BK, 4, 0], [RK, 8, 9], [RSHIANG, 2, 6, 'shi']], RSHIANG);

  console.log('--- 仕在底线 row9（疑点）---');
  await probe('A@(2,9) 底线 row9', [[BK, 4, 0], [RK, 8, 9], [RSHIANG, 2, 9, 'shi']], RSHIANG);

  console.log('--- 仕在顶线 row0（对称检验）---');
  await probe('a@(2,0) 顶线 row0（黑士）', [[BK, 6, 9], [RK, 8, 9], [1, 2, 0, 'shi']], 1);

  console.log('--- 象在底线的对称情形（calcXiang 同样有边界守卫）---');
  await probe('B@(2,9) 底线 row9', [[BK, 4, 0], [RK, 8, 9], [RSHIANG, 2, 9, 'xiang']], RSHIANG);

  console.log('=== 判读 ===');
  console.log('若「本仓库走点 = （无）」而引擎仍能走该子 ⇒ 我们把底线上的士/象判成了不能动。');
}

main();