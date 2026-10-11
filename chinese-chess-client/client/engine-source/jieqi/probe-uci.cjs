const path = require('path');
const jsFile = process.env.PROBE_JS || 'jieqi.js';
const createModule = require(path.join(__dirname, 'build', jsFile));

const UCI = (process.env.UCI_CMDS ? process.env.UCI_CMDS.split('|') : ['uci', 'quit']).join('\n') + '\n';
let pos = 0;
const out = [];

function dump(label) {
  const text = out.join('\n');
  console.log('=== ' + label + ' | js=' + jsFile + ' ===');
  console.log(text.slice(0, 4000));
  console.log('--- uciok:', /uciok/.test(text),
              '| bestmove:', (text.match(/bestmove\s+([a-i]\d[a-i]\d)/) || [null, 'NONE'])[1],
              '| probes:', (text.match(/\[PROBE\][^\n]*/g) || []).length);
}

const M = createModule({
  print: (t) => out.push(String(t)),
  printErr: (t) => out.push('[err] ' + String(t)),
  locateFile: (f) => (f.endsWith('.wasm') ? path.join(__dirname, 'build', f) : f),
  stdin: () => (pos < UCI.length ? UCI.charCodeAt(pos++) : null),
});

// 关键：无论 resolve 还是 reject，都要打印已捕获的输出
Promise.resolve(M).then(
  () => setTimeout(() => dump('RESOLVED'), 1200),
  (e) => { console.log('[REJECTED]', e && e.message); dump('REJECTED'); }
).catch((e) => { console.log('[THROWN]', e && e.message); dump('THROWN'); });

// 兜底：1.5s 后无论如何打印一次
setTimeout(() => { if (out.length) dump('TIMEOUT-DUMP'); }, 1500);
