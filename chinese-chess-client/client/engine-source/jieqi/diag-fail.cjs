/**
 * 诊断脚本：复现并定位 100 局压测里的两类硬失败
 *   ① 引擎失败（21 次，无 bestmove）
 *   ② 非法着法（10 次，引擎给的落点不在合法着法表里）
 *
 * 用法（⚠️ 切勿传命令行参数，见文件头说明）：
 *   $env:D1_SEED='10000'; node engine-source/jieqi/diag-fail.cjs
 */
const path = require('path');
const fs = require('fs');
const here = __dirname;
const X = require(path.join(here, 'stress-entry.bundle.cjs'));
const {
  createJieqiInitialState, makeSeededRand, makeMove,
  enumerateLegalMoves, setJieqiRuntime, clearJieqiRuntime,
  buildJieqiSearchPayload, getJieqiTier,
  parseBestmove, createInfoState, consumeEngineLine,
  isCriticalErrorLine, effectiveTypeOf,
  RED_SIDE, BOARD_COLS, BOARD_ROWS,
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
      INCOMING_MODULE_JS_API: [
        'stdin', 'print', 'printErr', 'locateFile', 'noInitialRun', 'wasmBinary',
      ],
    });
    Promise.resolve(M).then(
      () => setTimeout(() => {
        // ⚠️ 必须显式释放 WASM 线性内存：揭棋引擎一次搜索 = 一个实例，
        // 而本脚本要连跑上万次，不释放会在几十局后堆到 4GB 直接 OOM。
        // （主进程侧 Worker 每次都是新实例、天然被回收，故只影响本诊断脚本。）
        try {
          if (typeof M._destroy === 'function') M._destroy();
        } catch { /* 释放失败不影响本次统计 */ }
        // 释放后主动提示一次 GC：跑上万次实例时，这是唯一的回收时机
        if (typeof global.gc === 'function') global.gc();
        resolve(out);
      }, 400),
      (e) => reject(e)
    );
  });
}

async function engineMove(state, tier) {
  const ctx = X.getJieqiRuntime();
  const t = getJieqiTier(tier);
  const payload = buildJieqiSearchPayload(state, ctx);
  const commands = ['uci', 'isready', `setoption name MultiPV value ${t.multiPV}`];
  if (payload.moves.length > 0) {
    commands.push(`position fen ${payload.fen} moves ${payload.moves.join(' ')}`);
  } else {
    commands.push(`position fen ${payload.fen}`);
  }
  commands.push(`go depth ${t.depth}`);
  commands.push('quit');
  const lines = await runSession(commands);
  const info = createInfoState();
  let bestLine = null;
  for (const line of lines) {
    if (consumeEngineLine(line, info)) { bestLine = line; break; }
  }
  return { uci: bestLine ? parseBestmove(bestLine) : null, payload, info, lines };
}

const decode = (uci) => ({
  fromCol: uci.charCodeAt(0) - 97,
  fromRow: 9 - Number(uci[1]),
  toCol: uci.charCodeAt(2) - 97,
  toRow: 9 - Number(uci[3]),
});

function legalSet(state) {
  const s = new Set();
  for (const m of enumerateLegalMoves(state, state.sideTag)) {
    s.add(`${m.pieceId}:${m.fromCol},${m.fromRow}->${m.toCol},${m.toRow}`);
  }
  return s;
}

const TIER = process.env.TIER || 'easy';
const GAMES = Number(process.env.GAMES || 100);

async function main() {
  let engineFail = 0, illegal = 0, reported = 0;
  const illegalSamples = [];
  const engineFailSamples = [];

  for (let g = 0; g < GAMES; g++) {
    const seed = 10000 + g;
    const { state: initState, identity } = createJieqiInitialState(makeSeededRand(seed), RED_SIDE, seed);
    let state = initState;
    setJieqiRuntime(initState, seed, X.createDeterminization(seed));

    for (let ply = 0; ply < 200; ply++) {
      if (state.gameStatus !== 'playing') break;
      let res;
      try { res = await engineMove(state, TIER); }
      catch (e) {
        engineFail++;
        engineFailSamples.push({ g, ply, kind: 'throw', msg: String(e && e.message) });
        break;
      }
      if (!res.uci) {
        engineFail++;
        if (engineFailSamples.length < 12) {
          // 关键判定：客户端自己认为「还有合法着法」吗？
          //  · 有 ⇒ 引擎的 (none) 是**误判**，是我们要报的缺陷；
          //  · 无 ⇒ 双方都认为走不动，属正常的终局口径分歧（非缺陷）。
          const legal = enumerateLegalMoves(state, state.sideTag);
          engineFailSamples.push({
            g, ply, kind: 'no-bestmove',
            critical: res.lines.filter(isCriticalErrorLine),
            tail: res.lines.slice(-6),
            pool: res.payload.fen.split(' ')[2],
            nMoves: res.payload.moves.length,
            clientGameStatus: state.gameStatus,
            clientIsCheck: state.isCheck,
            sideToMove: state.sideTag ? 'red' : 'black',
            nClientLegal: legal.length,
            clientLegalSample: legal.slice(0, 5).map((m) => `${m.pieceId}:${m.fromCol},${m.fromRow}->${m.toCol},${m.toRow}`),
            aliveBySide: (() => {
              const r = { red: 0, black: 0 };
              for (let i = 0; i < 32; i++) {
                if (!state.pieces[i].alive) continue;
                if (i === 0 || i === 16) continue;
                if (i <= 15) r.black++; else r.red++;
              }
              return r;
            })(),
          });
        }
        break;
      }
      const { fromCol, fromRow, toCol, toRow } = decode(res.uci);
      const pid = state.qiPan[fromCol][fromRow];
      const key = `${pid}:${fromCol},${fromRow}->${toCol},${toRow}`;
      if (!legalSet(state).has(key)) {
        illegal++;
        if (illegalSamples.length < 12) {
          // 诊断要点：是「盘面没这子」「走法越界」还是「送将」？
          const piece = state.pieces[pid];
          const myPts = X.getValidMoves(state, pid);
          const pseudoOk = myPts[toCol] && myPts[toCol][toRow] === true;
          illegalSamples.push({
            g, ply, uci: res.uci, pid, fromCol, fromRow, toCol, toRow,
            pieceAlive: piece ? piece.alive : null,
            piecePos: piece ? [piece.col, piece.row] : null,
            onBoard: state.qiPan[fromCol][fromRow] === pid,
            hidden: state.hiddenMask ? state.hiddenMask[pid] : null,
            revealed: state.revealedType ? state.revealedType[pid] : null,
            effType: effectiveTypeOf(state, pid),
            pseudoOk,
            nPseudo: myPts.reduce((a, c) => a + c.filter(Boolean).length, 0),
          });
        }
        break;
      }
      state = makeMove(state, pid, toCol, toRow, identity).newState;
    }
    clearJieqiRuntime();
  }

  console.log('\n=== 诊断汇总（tier=' + TIER + '）===');
  console.log('引擎失败:', engineFail, ' 非法着法:', illegal);
  console.log('\n--- 引擎失败样本 ---');
  for (const s of engineFailSamples) console.log(JSON.stringify(s));
  console.log('\n--- 非法着法样本 ---');
  for (const s of illegalSamples) console.log(JSON.stringify(s));
}

main();