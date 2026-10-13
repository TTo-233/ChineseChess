/**
 * 定向诊断：引擎报 `bestmove (none)` 而客户端认为还有着法时，
 * 到底是谁对？逐帧对比「白脸将/飞将」判定。
 *
 * 用法（⚠️ 切勿传命令行参数）：
 *   $env:G='7'; $env:PLY='79'; node engine-source/jieqi/diag-none.cjs
 */
const path = require('path');
const fs = require('fs');
const here = __dirname;
const X = require(path.join(here, 'stress-entry.bundle.cjs'));
const {
  createJieqiInitialState, makeSeededRand, makeMove,
  enumerateLegalMoves, setJieqiRuntime, clearJieqiRuntime,
  buildJieqiSearchPayload, getJieqiTier, getValidMoves, isMoveKingSafe,
  parseBestmove, createInfoState, consumeEngineLine,
  RED_SIDE,
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

async function engineMove(state) {
  const ctx = X.getJieqiRuntime();
  const t = getJieqiTier('easy');
  const payload = buildJieqiSearchPayload(state, ctx);
  const cmds = ['uci', 'isready', `setoption name MultiPV value ${t.multiPV}`];
  cmds.push(payload.moves.length > 0
    ? `position fen ${payload.fen} moves ${payload.moves.join(' ')}`
    : `position fen ${payload.fen}`);
  cmds.push(`go depth ${t.depth}`, 'quit');
  const lines = await runSession(cmds);
  const info = createInfoState();
  let best = null;
  for (const l of lines) { if (consumeEngineLine(l, info)) { best = l; break; } }
  return { uci: best ? parseBestmove(best) : null, payload, lines };
}

const decode = (u) => ({
  fromCol: u.charCodeAt(0) - 97, fromRow: 9 - Number(u[1]),
  toCol: u.charCodeAt(2) - 97, toRow: 9 - Number(u[3]),
});

/** 棋盘可视化：暗子标 '?'，明子用字 */
function render(state) {
  const CH = { 0: 'k', 16: 'K' };
  const rows = [];
  for (let r = 0; r < 10; r++) {
    let line = '';
    for (let c = 0; c < 9; c++) {
      const id = state.qiPan[c][r];
      if (id === -1) { line += '. '; continue; }
      const hid = state.hiddenMask && state.hiddenMask[id] === true;
      line += hid ? '? ' : (CH[id] || String(id).padStart(2)) + ' ';
    }
    rows.push(String(r) + ' ' + line);
  }
  return rows.join('\n');
}

async function main() {
  const g = Number(process.env.G || 7);
  const seed = 10000 + g;
  const { state: initState, identity } = createJieqiInitialState(makeSeededRand(seed), RED_SIDE, seed);
  let state = initState;
  setJieqiRuntime(initState, seed, X.createDeterminization(seed));

  for (let ply = 0; ply < 200; ply++) {
    if (state.gameStatus !== 'playing') break;
    const res = await engineMove(state);
    if (!res.uci) {
      console.log(`\n### 局 ${g} 第 ${ply} 手：引擎报 (none)`);
      console.log('引擎原始尾部:', res.lines.slice(-4).join(' | '));
      console.log('\n--- 客户端盘面（行号 0..9，列 0..8；? = 暗子）---');
      console.log(render(state));
      console.log('走棋方:', state.sideTag ? 'red' : 'black', ' isCheck:', state.isCheck);
      const legal = enumerateLegalMoves(state, state.sideTag);
      console.log('客户端认为合法着法数:', legal.length);
      for (const m of legal) {
        console.log(`  ${m.pieceId}: (${m.fromCol},${m.fromRow}) -> (${m.toCol},${m.toRow})`);
        // 走完后将帅是否照面？
        const after = state.qiPan.map(r => [...r]);
        after[m.toCol][m.toRow] = m.pieceId;
        after[m.fromCol][m.fromRow] = -1;
        let kc = -1, kr = -1, sc = -1, sr = -1;
        for (let c = 0; c < 9; c++) for (let r = 0; r < 10; r++) {
          if (after[c][r] === 0) { kc = c; kr = r; }
          if (after[c][r] === 16) { sc = c; sr = r; }
        }
        const sameFile = kc === sc && kc >= 0;
        let blockers = [];
        if (sameFile) {
          const top = Math.min(kr, sr), bot = Math.max(kr, sr);
          for (let r = top + 1; r < bot; r++) {
            const id = after[kc][r];
            if (id !== -1) blockers.push(`(${kc},${r})=id${id}${state.hiddenMask && state.hiddenMask[id] ? '暗' : ''}`);
          }
        }
        console.log(`     走后照面=${sameFile} 中间阻挡=[${blockers.join(', ')}]`);
        // 逐个把阻挡子拿走，看会不会真照面
        if (sameFile && blockers.length === 1) {
          console.log(`     ⇒ 唯一阻挡是${blockers[0]}，引擎若把暗子当**不存在**则判照面 ⇒ 报 mate 0/(none)`);
        }
      }
      break;
    }
    const { fromCol, fromRow, toCol, toRow } = decode(res.uci);
    const pid = state.qiPan[fromCol][fromRow];
    state = makeMove(state, pid, toCol, toRow, identity).newState;
  }
  clearJieqiRuntime();
}

main();