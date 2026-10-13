/**
 * 复现 100 局里「规则 5 之外」的分歧：局面很好（客户端 23 步合法），
 * 引擎却报 mate 0 / (none)。
 *
 * 关键嫌疑：**暗子池段**。引擎除了棋盘段还吃一个「未揭暗子池」段，
 * 它会据此做后验推理；若池与棋盘的实际暗子数/种类对不上（例如重复局面
 * 导致池算多、某种类超过上限 5、或某侧池为 0），引擎可能内部判定非法 → mate 0。
 *
 * 用法（⚠️ 切勿传命令行参数）。
 */
const path = require('path');
const fs = require('fs');
const here = __dirname;
const X = require(path.join(here, 'stress-entry.bundle.cjs'));
const { enumerateLegalMoves } = X;

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

async function ask(fen, depth = 3) {
  const r = await runSession(['uci', 'isready', `position fen ${fen}`, `go depth ${depth}`, 'quit']);
  const b = (r.filter((l) => l.startsWith('bestmove'))[0] || '').replace('bestmove ', '').trim();
  return { best: b, lines: r };
}

const SAMPLES = [
  'x2xk1xb1/9/4p4/3R5/p3pr3/2P1c4/X7X/4B3P/4P4/X1XXKrX2 w A1C1P2N2p2n1 1 29',
  'x2xk1xb1/9/4p4/3R5/p3pr3/2P1c4/X7X/B3B3P/4P4/X2XKrX2 b A1C1P1N2p2n1 2 29',
  'x2x1kxb1/9/4p4/3R5/p3pr3/2P1c4/X7X/B3B3P/4P4/X2XKrX2 w A1C1P1N2p2n1 3 30',
];

async function main() {
  console.log('=== 第二类分歧：池段是否是元凶 ===\n');
  for (const fen of SAMPLES) {
    const parts = fen.split(' ');
    const board = parts[0], side = parts[1], pool = parts[2];

    // 盘上暗子计数（x/X）
    const hiddenOnBoard = (board.match(/[xX]/g) || []).length;
    let poolTotal = 0;
    const poolM = /([A-Za-z])(\d)/g;
    let mm;
    while ((mm = poolM.exec(pool)) !== null) poolTotal += Number(mm[2]);

    const full = await ask(fen);
    // 逐个棋子统计：找出棋盘上「已翻开」的子各是什么、有几个同类
    // 引擎的揭棋后验要给每个暗子枚举身份，可能有数量上限。
    const rows = board.split('/');
    const revealed = [];
    for (let r = 0; r < rows.length; r++) {
      let c = 0;
      for (const ch of rows[r]) {
        if (/[0-9]/.test(ch)) { c += Number(ch); continue; }
        if (/[a-z]/i.test(ch) && ch !== 'x') revealed.push(`${ch}@(${c},${r})`);
        c++;
      }
    }
    const counts = {};
    for (const r of revealed) { const t = r[0]; counts[t] = (counts[t] || 0) + 1; }

    console.log(`fen     : ${fen}`);
    console.log(`盘上暗子: ${hiddenOnBoard}   池总数: ${poolTotal}   一致: ${hiddenOnBoard === poolTotal}`);
    console.log(`已明子分布: ${JSON.stringify(counts)}`);
    console.log(`明子总数  : ${revealed.length}`);
    console.log(`引擎结果  : ${full.best}`);
    console.log('');
  }
}

main();