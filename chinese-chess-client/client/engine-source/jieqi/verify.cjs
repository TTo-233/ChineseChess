/**
 * 独立验证：用本目录的 jieqi.wasm 跑一次完整揭棋 UCI 流程。
 * 用途：CI / 人工回归，确认引擎产物仍可用。
 *
 * 用法：node verify.cjs        （需 node 在 PATH）
 */
const path = require('path');
const fs = require('fs');
const createModule = require(path.join(__dirname, 'jieqi.js'));

const JIEQI_START =
  'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX w R2A2C2P5N2B2r2a2c2p5n2b2 0 1';

const UCI = [
  'uci',
  'isready',
  'position fen ' + JIEQI_START,
  'go depth 4 movetime 3000',
  'quit',
].join('\n') + '\n';

let pos = 0;
const out = [];

const M = createModule({
  print: (t) => out.push(String(t)),
  printErr: (t) => out.push('[err] ' + String(t)),
  locateFile: (f) => (f.endsWith('.wasm') ? path.join(__dirname, 'jieqi.wasm') : f),
  // 关键：glue 的 `if (!wasmBinary)` 短路 fetch，直接用内联字节（离线必需）。
  wasmBinary: fs.readFileSync(path.join(__dirname, 'jieqi.wasm')),
  stdin: () => (pos < UCI.length ? UCI.charCodeAt(pos++) : null),
  INCOMING_MODULE_JS_API: ['stdin', 'print', 'printErr', 'locateFile', 'noInitialRun', 'wasmBinary'],
});

function finish(label) {
  const text = out.join('\n');
  const uciok = /uciok/.test(text);
  const readyok = /readyok/.test(text);
  const bm = text.match(/bestmove\s+([a-i]\d[a-i]\d)/);
  const nps = text.match(/nps (\d+)/g);
  const ok = uciok && readyok && !!bm && !/Aborted|Assertion/.test(text);
  console.log('=== jieqi.wasm verify (' + label + ') ===');
  console.log('uciok      :', uciok);
  console.log('readyok    :', readyok);
  console.log('bestmove   :', bm ? bm[1] : 'NONE');
  if (nps && nps.length) console.log('nps sample :', nps[nps.length - 1]);
  console.log('RESULT     :', ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

Promise.resolve(M).then(
  () => setTimeout(() => finish('resolved'), 1500),
  (e) => { console.log('[rejected]', e && e.message); finish('rejected'); }
).catch((e) => { console.log('[thrown]', e && e.message); finish('thrown'); });
