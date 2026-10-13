/**
 * 调查 100 局里「规则 5 之外」的 57 次分歧。
 *
 * 已知规则 5 能解释大部分（已翻开出九宫/过河的士象）。
 * 剩下这些局面**盘上没有**这种子，说明还有**第二个**认知分歧点。
 *
 * 首要嫌疑：**飞将（白脸将）是否把暗子当阻挡**。
 * 本仓库 MoveCheck.afterMoveStillJiangJun:519-527 对「两将同列」的判定是
 *   「中间只要有任何子（包括暗子）就视为被阻挡」；
 * 而规则 6 说暗子不构成攻击。若引擎把暗子**当空气**，
 * 那么「唯一挡在将帅之间的是一枚暗子」时它会判照面 ⇒ 报 mate 0/(none)。
 *
 * 用法（⚠️ 切勿传命令行参数）。
 */
const path = require('path');
const fs = require('fs');
const here = __dirname;
const X = require(path.join(here, 'stress-entry.bundle.cjs'));
const { enumerateLegalMoves, getValidMoves, isMoveKingSafe, RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS } = X;

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

async function best(fen, depth = 3) {
  const r = await runSession(['uci', 'isready', `position fen ${fen}`, `go depth ${depth}`, 'quit']);
  const b = (r.filter((l) => l.startsWith('bestmove'))[0] || '').replace('bestmove ', '').trim();
  const sc = r.filter((l) => /^info depth/.test(l)).slice(-1)[0] || '';
  return { best: b, score: sc };
}

/** 造揭棋局面：给两将 + 若干指定子（可指定暗子/已翻开） */
function mk(extra) {
  const qiPan = Array.from({ length: BOARD_COLS }, () => new Array(BOARD_ROWS).fill(-1));
  const pieces = Array.from({ length: 32 }, (_, i) => ({ id: i, col: -1, row: -1, alive: false }));
  const hiddenMask = new Array(32).fill(false);
  const revealedType = new Array(32).fill(null);
  qiPan[4][0] = 0; pieces[0] = { id: 0, col: 4, row: 0, alive: true };
  qiPan[4][9] = 16; pieces[16] = { id: 16, col: 4, row: 9, alive: true };
  for (const p of extra) {
    qiPan[p.col][p.row] = p.id;
    pieces[p.id] = { id: p.id, col: p.col, row: p.row, alive: true };
    hiddenMask[p.id] = p.hidden === true;
    if (p.hidden !== true) revealedType[p.id] = p.revealed ?? null;
  }
  return { qiPan, pieces, sideTag: RED_SIDE, moveHistory: [], gameStatus: 'playing',
    isCheck: false, checkMessage: '', zobristHash: 0, variant: 'jieqi', hiddenMask, revealedType };
}

async function report(label, state, fen) {
  const mine = enumerateLegalMoves(state, state.sideTag).length;
  const b = await best(fen);
  console.log(`\n${label}`);
  console.log(`  fen        : ${fen}`);
  console.log(`  客户端合法 : ${mine} 步`);
  console.log(`  引擎 best  : ${b.best}`);
  console.log(`  引擎 score : ${b.score}`);
  const agree = mine === 0 ? b.best === '(none)' : b.best !== '(none)';
  console.log(`  判定       : ${agree ? '✅ 一致' : '❌ 分歧'}`);
  return !agree;
}

async function main() {
  let divergent = 0, total = 0;
  const t = (x) => { total++; if (x) divergent++; };

  console.log('=== 假设：飞将（白脸将）是否把「暗子」当阻挡 ===\n');

  // 场景 1：将帅同列，中间**只有一枚暗子**。
  // 本仓库：暗子算阻挡 ⇒ 不算照面 ⇒ 红帅可动。
  // 若引擎把暗子当空气 ⇒ 判照面 ⇒ mate 0/(none)。
  {
    const s = mk([{ id: 23, col: 4, row: 5, hidden: true }]);
    // 暗子放在 (4,5)。红帅在 (4,9)，黑将在 (4,0)。
    // 注意红帅走 (4,8) 仍是同列且中间有暗子 → 应合法。
    t(await report('S1 将帅同列，中间唯一阻挡是【暗子】(4,5)', s,
      '4k4/9/9/9/9/4x4/9/9/9/4K4 w - 0 1'));
  }

  // 场景 2：同上，但阻挡子是**已翻开的明子**（对照，应一致）
  {
    const s = mk([{ id: 23, col: 4, row: 5, revealed: 'bing' }]);
    t(await report('S2 对照：中间阻挡是【明子】(4,5)', s,
      '4k4/9/9/9/9/4P4/9/9/9/4K4 w - 0 1'));
  }

  // 场景 3：暗子在别处，将帅同列且中间**空无一物** ⇒ 真照面，两边都该 (none)
  {
    const s = mk([{ id: 23, col: 0, row: 5, hidden: true }]);
    t(await report('S3 将帅同列且中间为空（真照面）', s,
      '4k4/9/9/9/9/x8/9/9/9/4K4 w - 0 1'));
  }

  // 场景 4：暗子紧贴红帅，红帅想横走 —— 检验暗子是否构成「攻击」
  {
    const s = mk([{ id: 23, col: 5, row: 9, hidden: true }]);
    t(await report('S4 红帅(4,9) 旁有暗子(5,9)，红帅可横走吗', s,
      '4k4/9/9/9/9/9/9/9/9/3xK4 w - 0 1'));
  }

  console.log(`\n=== 小结：${total} 个场景中 ${divergent} 个分歧 ===`);
  if (divergent > 0) {
    console.log('⇒ 存在**第二个**认知分歧点（与规则 5 无关）。');
  } else {
    console.log('⇒ 飞将/暗子阻挡口径一致，不是分歧来源。');
  }
}

main();