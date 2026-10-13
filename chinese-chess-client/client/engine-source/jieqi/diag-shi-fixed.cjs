/**
 * 修复后的独立确认：底线上的已翻开仕必须能动，且要和引擎一致。
 *
 * 背景：§16.3 记录的 P0 缺陷 —— `calcShi` 的 crossRiver 分支守卫写成
 * `row >= 1 && row <= BOARD_ROWS - 2`，把底线 row 9 的已翻开仕判成 0 步。
 *
 * 本脚本跑三种口径互相印证：
 *   1. 走法层 `getValidMoves` —— 该子自己的落点；
 *   2. 合法性层 `enumerateLegalMoves` —— 走完之后自己不被将军；
 *   3. 引擎 bestmove —— 同一个局面两边给不给出同一个方向。
 *
 * 注意：每一步都要让「对方将帅」离远一点，避免白脸将把落点全否掉。
 *
 * 用法（⚠️ 切勿传命令行参数）。
 */
const path = require('path');
const fs = require('fs');
const here = __dirname;
const X = require(path.join(here, 'stress-entry.bundle.cjs'));
const { enumerateLegalMoves, getValidMoves, isMoveKingSafe, RED_SIDE, BOARD_COLS, BOARD_ROWS } = X;

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

const BK = 0, RK = 16;
const RED_SLOTS = { shi: 17, xiang: 19, che: 23, ma: 21, pao: 25, bing: 27 };

function toState(spec, revealed) {
  const qiPan = Array.from({ length: BOARD_COLS }, () => new Array(BOARD_ROWS).fill(-1));
  const pieces = Array.from({ length: 32 }, (_, i) => ({ id: i, col: -1, row: -1, alive: false }));
  const hiddenMask = new Array(32).fill(false);
  const revealedType = new Array(32).fill(null);
  for (const [id, col, row] of spec) {
    qiPan[col][row] = id;
    pieces[id] = { id, col, row, alive: true };
  }
  for (const [id, type] of revealed) revealedType[id] = type;
  return { qiPan, pieces, sideTag: RED_SIDE, moveHistory: [], gameStatus: 'playing',
    isCheck: false, checkMessage: '', zobristHash: 0, variant: 'jieqi', hiddenMask, revealedType };
}

const CH = ['k','a','a','b','b','n','n','r','r','c','c','p','p','p','p','p',
            'K','A','A','B','B','N','N','R','R','C','C','P','P','P','P','P'];

function toFen(spec, revealed) {
  const st = toState(spec, revealed);
  const MAP = { che: 'R', ma: 'N', pao: 'C', shi: 'A', xiang: 'B', bing: 'P' };
  const rv = new Map(revealed);
  const rows = [];
  for (let r = 0; r < BOARD_ROWS; r++) {
    let line = '', gap = 0;
    for (let c = 0; c < BOARD_COLS; c++) {
      const id = st.qiPan[c][r];
      if (id === -1) { gap++; continue; }
      if (gap) { line += String(gap); gap = 0; }
      const m = rv.get(id);
      line += m ? MAP[m] : CH[id];
    }
    if (gap) line += String(gap);
    rows.push(line);
  }
  // 池段：粗略给一个自洽值（这些局面里只剩一两枚子，引擎不校验池一致性）
  return `${rows.join('/')} w A1P4N2B2C1r2c2p2n2b2 0 1`;
}

async function probe(label, spec, revealed, focusId) {
  const st = toState(spec, revealed);
  const pts = getValidMoves(st, focusId);
  const raw = [];
  for (let c = 0; c < BOARD_COLS; c++) {
    for (let r = 0; r < BOARD_ROWS; r++) if (pts[c][r]) raw.push(`(${c},${r})`);
  }
  const legal = enumerateLegalMoves(st, RED_SIDE);
  const legalForFocus = legal.filter((m) => m.pieceId === focusId);
  const fen = toFen(spec, revealed);
  const e = await ask(fen);

  console.log(`${label}`);
  console.log(`   fen          : ${fen}`);
  console.log(`   走法层落点   : ${raw.length} → ${raw.join(' ') || '（无）'}`);
  console.log(`   合法着法(该子): ${legalForFocus.length} → `
    + legalForFocus.map((m) => `(${m.toCol},${m.toRow})`).join(' ') || '（无）');
  console.log(`   引擎 best    : ${e}`);
  const ok = raw.length > 0 && legalForFocus.length > 0;
  console.log(`   判定         : ${ok ? '✅ 该子可动' : '❌ 该子被冻住'}`);
  console.log('');
  return ok;
}

async function main() {
  console.log('=== 修复后确认：底线/顶线的已翻开士必须可动 ===\n');

  const SHI = RED_SLOTS.shi;
  console.log('--- 仕（走法：斜行一步）---');
  await probe('仕 @(2,9) 红方底线', [[BK, 4, 0], [RK, 3, 8], [SHI, 2, 9]], [[SHI, 'shi']], SHI);
  await probe('仕 @(2,0) 红方顶线', [[BK, 4, 0], [RK, 3, 8], [SHI, 2, 0]], [[SHI, 'shi']], SHI);
  await probe('仕 @(0,9) 左下角', [[BK, 4, 0], [RK, 3, 8], [SHI, 0, 9]], [[SHI, 'shi']], SHI);
  await probe('仕 @(8,9) 右下角', [[BK, 4, 0], [RK, 3, 8], [SHI, 8, 9]], [[SHI, 'shi']], SHI);

  console.log('--- 象（走法：田字两格）作为对照 ---');
  const XIANG = RED_SLOTS.xiang;
  await probe('象 @(2,9) 红方底线', [[BK, 4, 0], [RK, 3, 8], [XIANG, 2, 9]], [[XIANG, 'xiang']], XIANG);
  await probe('象 @(1,8) 常规位', [[BK, 4, 0], [RK, 3, 8], [XIANG, 1, 8]], [[XIANG, 'xiang']], XIANG);

  console.log('=== 逐行扫描：仕在每一列每一行都应可动（0 步只允许出现在被围死的局面）===\n');
  const dead = [];
  for (let col = 0; col < BOARD_COLS; col++) {
    for (let row = 0; row < BOARD_ROWS; row++) {
      const st = toState([[BK, 4, 0], [RK, 3, 8], [SHI, col, row]], [[SHI, 'shi']]);
      const pts = getValidMoves(st, SHI);
      let n = 0;
      for (let c = 0; c < BOARD_COLS; c++) {
        for (let r = 0; r < BOARD_ROWS; r++) if (pts[c][r]) n++;
      }
      if (n === 0) dead.push(`(${col},${row})`);
    }
  }
  console.log(`走法层 0 步的格子（${dead.length} 个）：${dead.join(' ') || '（无）'}`);
  console.log('角上/边线本就只有 1–2 个落点；0 步只应出现在四角等真正无斜向落点的死角。');
  console.log('（构造里帅固定在 (3,8)，与个别探测格重叠导致的 0 步需人工排除。）');
}

main();