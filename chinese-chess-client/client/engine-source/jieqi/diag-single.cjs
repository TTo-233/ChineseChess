/**
 * 定位「已翻开的车」到底触发了什么。
 *
 * 已确证：池段无关（清空池照样罢工），把 R/r 换成 X/x 立刻恢复。
 * 现在缩小到**具体是哪枚车、什么位置**。
 *
 * 样本1 棋盘（逐格）：
 *   row0 : x 2 x k 1 x b 1     → x@(0,0) x@(3,0) k@(4,0) x@(6,0) b@(7,0)
 *   row1 : 9
 *   row2 : 4 p 4                → p@(4,2)
 *   row3 : 3 R 5                → R@(3,3)
 *   row4 : p 3 p r 3            → p@(0,4) p@(4,4) r@(6,4)
 *   row5 : 2 P 1 c 4            → P@(2,5) c@(5,5)
 *   row6 : X 7 X                → X@(0,6) X@(8,6)
 *   row7 : 4 B 3 P              → B@(4,7) P@(8,7)
 *   row8 : 4 P 4                → P@(4,8)
 *   row9 : X 1 X X K r X 2      → X@(0,9) X@(2,9) X@(3,9) K@(4,9) r@(6,9) X@(8,9)
 *
 * 注意 row9：K 在 (4,9)，紧邻右侧 (5,9) 是**空格**，(6,9) 是黑车 r。
 * 黑车 (6,9) 沿 row9 向左： (5,9) 空、(4,9) 是红帅 K ⇒ **黑车正将军**！
 * 红帅被将，而红方唯一能解的可能是……
 *
 * 本脚本：逐一删除/替换单枚棋子，找出「让引擎恢复」的那一处最小改动。
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
    return (r.filter((l) => l.startsWith('bestmove'))[0] || '').replace('bestmove ', '').trim();
  } catch {
    return 'CRASH';
  }
}

const S1 = 'x2xk1xb1/9/4p4/3R5/p3pr3/2P1c4/X7X/4B3P/4P4/X1XXKrX2 w A1C1P2N2p2n1 1 29';

/** 把棋盘段解析成 10×9 网格（字符，null=空） */
function toGrid(board) {
  const g = [];
  for (const row of board.split('/')) {
    const line = [];
    for (const ch of row) {
      if (/[0-9]/.test(ch)) for (let i = 0; i < Number(ch); i++) line.push(null);
      else line.push(ch);
    }
    if (line.length !== 9) throw new Error(`行宽 ${line.length}: ${row}`);
    g.push(line);
  }
  return g;
}
const toBoard = (g) => g.map((row) => {
  let s = '', gap = 0;
  for (const ch of row) {
    if (ch === null) { gap++; continue; }
    if (gap) { s += String(gap); gap = 0; }
    s += ch;
  }
  if (gap) s += String(gap);
  return s;
}).join('/');

async function main() {
  console.log('=== 样本1 棋盘逐格可视化 ===\n');
  const [board0, side, poolSeg] = S1.split(' ');
  const g = toGrid(board0);
  for (let r = 0; r < 10; r++) {
    console.log(String(r) + ' ' + g[r].map((c) => (c === null ? '.' : c)).join(' '));
  }

  console.log('\n=== 逐一删除单枚棋子，看引擎是否恢复 ===\n');
  const base = await ask(`${board0} ${side} ${poolSeg} 0 1`);
  console.log(`原样: ${base}\n`);

  const fixes = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const ch = g[r][c];
      if (ch === null) continue;
      const g2 = g.map((row) => [...row]);
      g2[r][c] = null;
      const b = await ask(`${toBoard(g2)} ${side} ${poolSeg} 0 1`);
      if (b !== '(none)' && b !== 'CRASH') {
        fixes.push({ ch, col: c, row: r, best: b });
        console.log(`删 ${ch}@(${c},${r}) → 恢复: ${b}`);
      }
    }
  }

  if (fixes.length === 0) {
    console.log('单删任何一枚都不能恢复 ⇒ 不是「某一枚车的存在」，而是**全局组合**。');
  } else {
    console.log(`\n可恢复的单点改动 ${fixes.length} 处：`);
    for (const f of fixes) console.log(`  ${f.ch}@(${f.col},${f.row})`);
  }
}

main();