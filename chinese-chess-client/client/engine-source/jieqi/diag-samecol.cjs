/**
 * 根因锁定：黑方两辆车 r@(5,4) 与 r@(5,9) 在**同一列**，
 * 且中间 (5,5) 有黑炮 c、(5,6)~(5,8) 空。
 * 实际上 c@(5,5) 挡着，所以并不直接对穿。
 *
 * 但注意：棋子类型在池里 —— 盘面黑车 2 枚全翻开，池里黑方没有 r。
 * 引擎做揭棋后验时，会为每个**暗子**分配身份；
 * 若它误把「已翻开的 r」也纳入后验池，或反过来…
 *
 * 决定性实验：构造**极小**局面 —— 只留这两枚黑车（同一列）+ 将帅，
 * 逐步逼近，看引擎何时崩。
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
    const sc = (r.filter((l) => /^info depth/.test(l)).slice(-1)[0] || '');
    const m = sc.match(/score mate (-?\d+)/);
    return { best: b, mate: m ? Number(m[1]) : null };
  } catch {
    return { best: 'CRASH', mate: null };
  }
}

const mkBoard = (pieces) => {
  const g = Array.from({ length: 10 }, () => new Array(9).fill(null));
  for (const [col, row, ch] of pieces) g[row][col] = ch;
  return g.map((row) => {
    let s = '', gap = 0;
    for (const ch of row) {
      if (ch === null) { gap++; continue; }
      if (gap) { s += String(gap); gap = 0; }
      s += ch;
    }
    if (gap) s += String(gap);
    return s;
  }).join('/');
};

async function t(label, pieces, pool = '-') {
  const fen = `${mkBoard(pieces)} w ${pool} 0 1`;
  const r = await ask(fen);
  console.log(`${label}`);
  console.log(`  fen : ${fen}`);
  console.log(`  引擎: ${r.best}${r.mate !== null ? ` (mate ${r.mate})` : ''}`);
  return r;
}

async function main() {
  console.log('=== 逼近：两枚黑车同列 ===\n');

  // 基线：只有将帅
  await t('B0 只有将帅', [[4, 0, 'k'], [4, 9, 'K']]);

  // 一枚黑车
  await t('B1 一枚黑车 r@(5,4)', [[4, 0, 'k'], [4, 9, 'K'], [5, 4, 'r']]);

  // 两枚黑车，不同列
  await t('B2 两枚黑车，不同列 r@(5,4) r@(6,9)', [[4, 0, 'k'], [4, 9, 'K'], [5, 4, 'r'], [6, 9, 'r']]);

  // 两枚黑车，同列（关键）
  await t('B3 两枚黑车，【同列】r@(5,4) r@(5,9)', [[4, 0, 'k'], [4, 9, 'K'], [5, 4, 'r'], [5, 9, 'r']]);

  // 两枚红车同列（对称检验）
  await t('B4 两枚红车同列 R@(3,5) R@(3,8)', [[4, 0, 'k'], [4, 9, 'K'], [3, 5, 'R'], [3, 8, 'R']]);

  // 两枚黑车同列 + 中间有黑炮（贴近样本1）
  await t('B5 两枚黑车同列 + 中间黑炮 c@(5,5)', [[4, 0, 'k'], [4, 9, 'K'], [5, 4, 'r'], [5, 5, 'c'], [5, 9, 'r']]);

  console.log('\n若 B3/B4 崩而 B2 正常 ⇒ 引擎对「同列多车」的后验/走法生成有缺陷。');
}

main();