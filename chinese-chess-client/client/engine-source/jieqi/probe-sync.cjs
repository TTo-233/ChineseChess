/**
 * 验证：jieqi.wasm 的 _main() 是否同步阻塞？
 * 若是，则 Worker 里必须「一次性喂完整命令序列」而非逐条交互。
 */
const path = require('path');
const fs = require('fs');
const createModule = require(path.join(__dirname, 'jieqi.wasm'.replace('.wasm', '.js')).replace('D:\\Code\\ChineseChess\\chinese-chess-client\\client\\engine-source\\jieqi\\jieqi.wasm', 'D:/Code/ChineseChess/chinese-chess-client/client/engine-source/jieqi/jieqi.js'));

let pos = 0;
const out = [];
const CMDS = ['uci', 'isready', 'quit'].join('\n') + '\n';

const t0 = Date.now();
const M = createModule({
  print: (t) => out.push(String(t)),
  printErr: (t) => out.push('[e]' + String(t)),
  locateFile: (f) => (f.endsWith('.wasm') ? path.join(__dirname, 'jieqi.wasm') : f),
  stdin: () => (pos < CMDS.length ? CMDS.charCodeAt(pos++) : null),
});

Promise.resolve(M).then(() => {
  const dt = Date.now() - t0;
  console.log('elapsed(ms):', dt);
  console.log('has _main export:', typeof (M && M._main));
  console.log('output lines:', out.length);
  console.log('uciok:', /uciok/.test(out.join('\n')));
  // 关键：初始化是否已经自己跑完 main（因为我们没设 noInitialRun）
  console.log('=> 若 elapsed>0 且有输出，说明 main() 在初始化期同步跑完');
}).catch(e => console.log('ERR:', e.message));
