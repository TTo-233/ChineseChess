/**
 * 隔离实验：引擎报 mate 0/(none) 时，差异出在「当前局面」还是「历史重放」？
 *
 * 对同一个失败局面发两种 position：
 *   A. 只发当前局面 FEN（不带 moves）—— 绕开全部历史重放
 *   B. 发起点 FEN + 完整 moves（生产同款）
 * 若 A 也报 mate ⇒ 引擎对**当前盘面**的认知就与本仓库不同（棋种/走法口径分歧）
 * 若 A 不报 mate 而 B 报 ⇒ 历史重放不一致（我们的 moves 与引擎理解的盘面不同）
 *
 * 用法（⚠️ 切勿传命令行参数）：$env:G='7'; node engine-source/jieqi/diag-isolate.cjs
 */
const path = require('path');
const fs = require('fs');
const here = __dirname;
const X = require(path.join(here, 'stress-entry.bundle.cjs'));
const {
  createJieqiInitialState, makeSeededRand, makeMove,
  enumerateLegalMoves, setJieqiRuntime, clearJieqiRuntime,
  buildJieqiSearchPayload, parseBestmove, createInfoState, consumeEngineLine,
  toJieqiFen, RED_SIDE,
} = X;

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

/** 返回 {best, scoreLine} */
async function ask(positionCmd, depth = 3) {
  const lines = await runSession(['uci', 'isready', positionCmd, `go depth ${depth}`, 'quit']);
  const info = createInfoState();
  let best = null;
  for (const l of lines) { if (consumeEngineLine(l, info)) { best = l; break; } }
  const uci = best ? parseBestmove(best) : null;
  return { uci, score: lines.filter((l) => l.startsWith('info') && /score/.test(l)).slice(-1)[0] || '' };
}

const decode = (u) => ({
  fromCol: u.charCodeAt(0) - 97, fromRow: 9 - Number(u[1]),
  toCol: u.charCodeAt(2) - 97, toRow: 9 - Number(u[3]),
});

async function replayTo(g) {
  const seed = 10000 + g;
  const { state: initState, identity } = createJieqiInitialState(makeSeededRand(seed), RED_SIDE, seed);
  let state = initState;
  setJieqiRuntime(initState, seed, X.createDeterminization(seed));
  const history = [];
  for (let ply = 0; ply < 200; ply++) {
    if (state.gameStatus !== 'playing') break;
    const ctx = X.getJieqiRuntime();
    const payload = buildJieqiSearchPayload(state, ctx);
    const b = await ask(payload.moves.length > 0
      ? `position fen ${payload.fen} moves ${payload.moves.join(' ')}`
      : `position fen ${payload.fen}`);
    if (!b.uci) return { state, history, payload, stoppedAt: ply };
    const { fromCol, fromRow, toCol, toRow } = decode(b.uci);
    const pid = state.qiPan[fromCol][fromRow];
    history.push(b.uci);
    state = makeMove(state, pid, toCol, toRow, identity).newState;
  }
  return { state, history, payload: null, stoppedAt: -1 };
}

async function main() {
  const g = Number(process.env.G || 7);
  const { state, history, payload, stoppedAt } = await replayTo(g);
  console.log(`局 ${g}：引擎在第 ${stoppedAt} 手报 (none)，历史长度 ${history.length}`);

  // A：只发当前局面 FEN（不带 moves）
  const ctx = X.getJieqiRuntime();
  const freshDet = X.createDeterminization(ctx.determinization.seed);
  const rand = X.makeDeterministicRand(ctx.determinization.seed);
  X.buildJieqiHistoryMoves(state, ctx.initialState, (v, s) =>
    X.declareCapturedIdentity(freshDet, v, rand, s));
  X.topUpCapturedDeclarations(freshDet, state, rand);
  const pool = X.computePoolFromState(state, freshDet.capturedDeclared);
  const curFen = toJieqiFen(state, pool);

  const A = await ask(`position fen ${curFen}`);
  console.log('\n[A] 只发当前局面 FEN（无 moves）:');
  console.log('   fen   :', curFen);
  console.log('   best  :', A.uci, '|', A.score);

  const B = payload
    ? await ask(`position fen ${payload.fen} moves ${payload.moves.join(' ')}`)
    : { uci: '(与A同一局面)', score: '' };
  console.log('\n[B] 起点 FEN + 完整 moves（生产同款）:');
  console.log('   best  :', B.uci, '|', B.score);

  console.log('\n[C] 客户端认为的合法着法:');
  for (const m of enumerateLegalMoves(state, state.sideTag)) {
    console.log(`   ${m.pieceId}: (${m.fromCol},${m.fromRow})->(${m.toCol},${m.toRow})`);
  }

  console.log('\n结论：');
  if (!A.uci) {
    console.log('   ⇒ [A] 不带任何历史、只发当前局面 FEN 也报 mate 0 ⇒');
    console.log('     差异在**当前盘面认知**（引擎与本仓库对某个棋子的棋种/走法理解不同），');
    console.log('     与历史重放、determinization 簿记均无关。');
  } else {
    console.log('   ⇒ [A] 能给出着法：差异在**历史重放**。');
  }
  clearJieqiRuntime();
}

main();