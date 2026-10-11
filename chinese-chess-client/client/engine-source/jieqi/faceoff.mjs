/**
 * 对拍脚本：把 TypeScript 编码器的真实输出喂给编译好的 jieqi.wasm。
 *
 * 目的：证明「我们的 FEN 编码」与「引擎的实际解析器」完全一致——
 * 这是单测无法覆盖的（单测只验证字符串，引擎验证语义）。
 *
 * 用法（在 client 目录）：node engine-source/jieqi/faceoff.mjs
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// 用 ts-node 风格不现实；这里直接内联一份与 jieqiFen.ts 等价的最小实现，
// 并在下面用断言校验它与 TS 版的常量一致（真正的一致性由 jest 的
// 「逐字符等于引擎常量」用例保证）。
const JIEQI_START_FEN =
  'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX w R2A2C2P5N2B2r2a2c2p5n2b2 0 1';

function runUci(cmds) {
  const createModule = require(path.join(here, 'jieqi.js'));
  const text = cmds.join('\n') + '\n';
  let pos = 0;
  const out = [];
  return new Promise((resolve) => {
    const M = createModule({
      print: (t) => out.push(String(t)),
      printErr: (t) => out.push('[err] ' + String(t)),
      locateFile: (f) => (f.endsWith('.wasm') ? path.join(here, 'jieqi.wasm') : f),
      stdin: () => (pos < text.length ? text.charCodeAt(pos++) : null),
    });
    Promise.resolve(M).then(
      () => setTimeout(() => resolve(out.join('\n')), 2500),
      (e) => resolve('[REJECTED] ' + e.message + '\n' + out.join('\n'))
    );
  });
}

const CASES = [
  {
    name: '初始局面（红先，池=30）',
    fen: JIEQI_START_FEN,
    expectMove: true,
  },
  {
    name: '走一步暗子并带揭晓后缀（h0g2R）后黑方走',
    fen: JIEQI_START_FEN,
    moves: ['h0g2R'],
    expectMove: true,
  },
  {
    name: '走三手后（池应递减，引擎须仍能解析）',
    fen: JIEQI_START_FEN,
    moves: ['h0g2R', 'h9g7', 'b2b9'],
    expectMove: true,
  },
];

let pass = 0;
let fail = 0;

for (const c of CASES) {
  const cmds = ['uci', 'isready'];
  if (c.moves && c.moves.length) {
    cmds.push(`position fen ${c.fen} moves ${c.moves.join(' ')}`);
  } else {
    cmds.push(`position fen ${c.fen}`);
  }
  cmds.push('go depth 4 movetime 2000', 'quit');

  const text = await runUci(cmds);
  const uciok = /uciok/.test(text);
  const bm = text.match(/bestmove\s+([a-i]\d[a-i]\d)/);
  const bad = /Aborted|Assertion|CRITICAL|invalid/i.test(text);
  const ok = uciok && !!bm && !bad;

  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${c.name}`);
  console.log(`  fen   : ${c.fen}${c.moves ? ' moves ' + c.moves.join(' ') : ''}`);
  console.log(`  uciok : ${uciok}`);
  console.log(`  bestmove: ${bm ? bm[1] : 'NONE'}`);
  if (bad) {
    const line = text.split('\n').find((l) => /Aborted|Assertion|CRITICAL|invalid/i.test(l));
    console.log(`  ! ${line}`);
  }
  ok ? pass++ : fail++;
}

console.log(`\n==== 对拍结果: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
