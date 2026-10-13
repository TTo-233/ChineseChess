/**
 * 定位第二类分歧的根因：**「已翻开的子」总数触发了引擎的揭棋后验上限**。
 *
 * 观察：分歧局面里已翻开的明子很多（sample1 有 12 个非 x 的子），
 * 引擎的 `jieqi_old` 后验推理要为每个暗子枚举身份，
 * 内部有一张定长表；明子越多、剩余身份组合越受限，
 * 引擎可能越界写坏栈/堆 → `mate 0 / (none)` 甚至 **WASM memory access out of bounds**。
 *
 * 实验：固定同一个暗子布局，**逐步增加已翻开的明子数量**，
 * 看引擎从第几个明子开始罢工。
 *
 * 用法（⚠️ 切勿传命令行参数）。
 */
const path = require('path');
const fs = require('fs');
const here = __dirname;
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
    const r = await runSession(['uci', 'isready', `position fen ${fen}`, 'go depth 2', 'quit']);
    const b = (r.filter((l) => l.startsWith('bestmove'))[0] || '').replace('bestmove ', '').trim();
    return { ok: true, best: b };
  } catch (e) {
    return { ok: false, best: 'CRASH: ' + String(e).split('\n')[0] };
  }
}

/**
 * 造一个「红方明子递增」的残局：
 * 暗子放在固定若干格，明子从池里按类型依次翻开。
 */
function build(nRevealed) {
  const g = Array.from({ length: 10 }, () => new Array(9).fill(null));
  g[0][4] = 'k'; g[9][4] = 'K';
  // 放 8 个暗子在红方半场（行为红方，棋位类型 = 所在列的兵位/车位…）
  const darkSpots = [
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
    [1, 7], [3, 7], [5, 7],
  ];
  for (const [c, r] of darkSpots) g[r][c] = 'x';
  // 其中前 nRevealed 个翻成明子（按红方棋种 R,C,N,B,P 轮换）
  const redTypes = ['R', 'C', 'N', 'B', 'P'];
  const poolRed = { R: 2, C: 2, N: 2, B: 2, P: 5 };
  const flipped = darkSpots.slice(0, nRevealed);
  flipped.forEach(([c, r], i) => {
    g[r][c] = redTypes[i % redTypes.length];
  });
  // 池 = 总数 - 已翻开
  let pool = '';
  const order = ['R', 'A', 'C', 'P', 'N', 'B'];
  for (const t of order) {
    const used = flipped.filter((_, i) => redTypes[i % redTypes.length] === t).length;
    const left = (poolRed[t] ?? 0) - used;
    if (left > 0) pool += t + left;
  }
  // 黑方暗子固定
  const blackSpots = [[0, 3], [2, 3], [4, 3], [6, 3], [8, 3], [1, 2], [3, 2], [5, 2], [7, 2]];
  for (const [c, r] of blackSpots) g[r][c] = 'X';
  let bpool = '';
  for (const t of ['r', 'a', 'c', 'p', 'n', 'b']) {
    const cnt = { r: 2, a: 2, c: 2, p: 5, n: 2, b: 2 }[t];
    if (cnt > 0) bpool += t + cnt;
  }
  const board = g.map((row) => {
    let s = '', gap = 0;
    for (const ch of row) {
      if (ch === null) { gap++; continue; }
      if (gap) { s += String(gap); gap = 0; }
      s += ch;
    }
    if (gap) s += String(gap);
    return s;
  }).join('/');
  return `${board} w ${pool}${bpool} 0 1`;
}

async function main() {
  console.log('=== 逐步增加已翻开明子，看引擎从几个开始罢工 ===\n');
  for (let n = 0; n <= 8; n++) {
    const fen = build(n);
    const r = await ask(fen);
    const board = fen.split(' ')[0];
    const hidden = (board.match(/[xX]/g) || []).length;
    console.log(`明子 ${n} 个 (盘上剩余暗子 ${hidden}): ${r.best}`);
    if (r.ok && r.best === '(none)') {
      console.log('  ⚠️ 从这里开始引擎罢工');
      break;
    }
  }
}

main();