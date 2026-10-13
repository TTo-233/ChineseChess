/**
 * 第二类分歧的触发条件判定（全部同时问「引擎」与「本仓库」）。
 *
 * 已确证的真实分歧：
 *   FEN `4k4/9/9/9/9/9/9/9/9/4K1r2 w - 0 1`
 *   红帅(4,9) 被黑车(6,9) 沿底线将军；(3,9)/(5,9) 仍在同一行受攻击、
 *   (4,8) 与黑将同列属白脸将 ⇒ 唯一合法着是帅退 (3,8)/(5,8)。
 *   本仓库：2 步（对）；引擎：mate 0 / (none)（错）。
 *
 * 本脚本做判别实验，区分下列几种可能：
 *   H1 只有「黑车沿底线将军」会触发？
 *   H2 黑车沿**竖线**将军也会触发？
 *   H3 黑炮沿底线将军也会触发？（是��滑子通病还是车的特例）
 *   H4 反过来（红车沿底线将军黑将）是否也触发？
 *
 * 用法（⚠️ 切勿传命令行参数）。
 */
const path = require('path');
const fs = require('fs');
const here = __dirname;
const X = require(path.join(here, 'stress-entry.bundle.cjs'));
const { enumerateLegalMoves, RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS } = X;

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

async function ask(fen) {
  try {
    const r = await runSession(['uci', 'isready', `position fen ${fen}`, 'go depth 3', 'quit']);
    return (r.filter((l) => l.startsWith('bestmove'))[0] || '').replace('bestmove ', '').trim();
  } catch {
    return 'CRASH';
  }
}

const FEN_CHARS = [
  'k', 'a', 'a', 'b', 'b', 'n', 'n', 'r', 'r', 'c', 'c', 'p', 'p', 'p', 'p', 'p',
  'K', 'A', 'A', 'B', 'B', 'N', 'N', 'R', 'R', 'C', 'C', 'P', 'P', 'P', 'P', 'P',
];
// 棋位 id（揭棋盘面 id 恒为棋位 id，未设 revealedType 时即按该 id 的棋种走）
const BK = 0, BSHI = 1, BXIANG = 3, BMA = 5, BCHE = 7, BPAO = 9, BZU = 11;
const RK = 16, RSHI = 17, RXIANG = 19, RMA = 21, RCHE = 23, RPAO = 25, RBING = 27;

/** spec: [[id,col,row], ...]；sideToMove 默认红 */
function toState(spec, sideToMove = RED_SIDE) {
  const qiPan = Array.from({ length: BOARD_COLS }, () => new Array(BOARD_ROWS).fill(-1));
  const pieces = Array.from({ length: 32 }, (_, i) => ({ id: i, col: -1, row: -1, alive: false }));
  for (const [id, col, row] of spec) {
    qiPan[col][row] = id;
    pieces[id] = { id, col, row, alive: true };
  }
  return { qiPan, pieces, sideTag: sideToMove, moveHistory: [], gameStatus: 'playing',
    isCheck: false, checkMessage: '', zobristHash: 0, variant: 'jieqi',
    hiddenMask: new Array(32).fill(false), revealedType: new Array(32).fill(null) };
}

function toFen(spec, sideToMove = RED_SIDE) {
  const st = toState(spec, sideToMove);
  const rows = [];
  for (let r = 0; r < BOARD_ROWS; r++) {
    let line = '', gap = 0;
    for (let c = 0; c < BOARD_COLS; c++) {
      const id = st.qiPan[c][r];
      if (id === -1) { gap++; continue; }
      if (gap) { line += String(gap); gap = 0; }
      line += FEN_CHARS[id];
    }
    if (gap) line += String(gap);
    rows.push(line);
  }
  const s = sideToMove === RED_SIDE ? 'w' : 'b';
  return `${rows.join('/')} ${s} - 0 1`;
}

async function t(label, spec, sideToMove = RED_SIDE, expect = '') {
  const st = toState(spec, sideToMove);
  const legal = enumerateLegalMoves(st, sideToMove);
  const fen = toFen(spec, sideToMove);
  const b = await ask(fen);
  const engineNone = b === '(none)' || b === 'CRASH';
  const weNone = legal.length === 0;
  const agree = engineNone === weNone;
  console.log(`${agree ? '✅一致' : (weNone ? '❌引擎误报将死' : '⚠️ 引擎漏判将死')}`
    + `  ${label}${expect ? '   [' + expect + ']' : ''}`);
  console.log(`      本仓库 ${legal.length} 步 | 引擎 ${b}`);
  if (!weNone) console.log(`      我方着法: ${legal.map((m) => `${m.pieceId}→(${m.toCol},${m.toRow})`).join(' ')}`);
  console.log('');
}

async function main() {
  console.log('=== 判别实验：谁在「被将军且可解」时误报 mate 0 ===\n');
  console.log('⚠️ 上一版 diag-mate2 用 id=5 却渲染成 r，引擎与本仓库拿到的根本不是同一个棋子，');
  console.log('   结论无效。已改为统一用 FEN_CHARS[id] 渲染。\n');

  console.log('--- H0 真实分歧局面（100 局压测抓到的原始样本）---');
  {
    const board = 'x2xk1xb1/9/4p4/3R5/p3pr3/2P1c4/X7X/4B3P/4P4/X1XXKrX2';
    const pool = 'A1C1P2N2p2n1';
    const r = await runSession(['uci', 'isready', `position fen ${board} w ${pool} 0 1`, 'go depth 3', 'quit']);
    const b = (r.filter((l) => l.startsWith('bestmove'))[0] || '').replace('bestmove ', '').trim();
    console.log(`   fen: ${board} w ${pool} 0 1`);
    console.log(`   引擎: ${b}`);
    console.log('');
  }

  console.log('--- H1 黑车沿底线(row9)将军（真实棋位 id）---');
  await t('黑车(6,9) 将红帅(4,9)', [[BK, 4, 0], [RK, 4, 9], [BCHE, 6, 9]]);
  await t('黑车(6,9) + 红车(0,9) 可横吃', [[BK, 4, 0], [RK, 4, 9], [BCHE, 6, 9], [RCHE, 0, 9]]);
  await t('黑车(6,8) 不将军（对照）', [[BK, 4, 0], [RK, 4, 9], [BCHE, 6, 8]]);

  console.log('--- H2 黑车沿竖线(col4)将军 ---');
  await t('黑车(4,5) 将红帅(4,9)', [[BK, 4, 0], [RK, 4, 9], [BCHE, 4, 5]]);

  console.log('--- H3 双黑车同底线（两个不同棋位 id）---');
  await t('黑车(2,9)(6,9) 夹住红帅(4,9)', [[BK, 4, 0], [RK, 4, 9], [BCHE, 2, 9], [BCHE, 6, 9]]);
  await t('黑车(6,9)(8,9)（漏一个 id，会塌成一枚）', [[BK, 4, 0], [RK, 4, 9], [BCHE, 6, 9], [BCHE, 8, 9]]);

  console.log('--- H4 反向：红车沿底线(row0)将军黑将 ---');
  await t('红车(6,0) 将黑将(4,0)', [[BK, 4, 0], [RK, 4, 9], [RCHE, 6, 0]], BLACK_SIDE);

  console.log('--- H5 对照：黑马/黑卒将军 ---');
  await t('黑马(4,7) 将红帅(4,9)', [[BK, 4, 0], [RK, 4, 9], [BMA, 4, 7]]);
  await t('黑卒(4,8) 顶住红帅(4,9)', [[BK, 4, 0], [RK, 4, 9], [BZU, 4, 8]]);
  await t('黑炮(6,9)+炮架(5,9) 将红帅', [[BK, 4, 0], [RK, 4, 9], [BPAO, 6, 9], [BCHE, 5, 9]]);
}

main();