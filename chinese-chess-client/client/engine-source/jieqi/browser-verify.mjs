/**
 * 浏览器端到端验证：揭棋引擎接入层
 *
 * 用途：确认「接入层生成的载荷」（FEN + 带揭晓后缀的历史着法）能被引擎
 * 接受并正确出着。这是单元测试无法覆盖的部分 —— 单测只验证字符串，
 * 这里验证引擎的**真实解析器**是否认同我们的编码。
 *
 * 为什么必须在浏览器里跑：
 *   引擎的 wasm 加载依赖真实同源 http(s) 资源与 fetch +
 *   instantiateStreaming（见 utils/chess/pikafish/jieqiHost.ts 的说明），
 *   Node 环境既没有 WorkerGlobalScope 也没有 instantiateStreaming，
 *   无法复现这条路径。Node 侧的回归基线是 verify.cjs / faceoff.mjs。
 *
 * 前置：Expo Web 已启动（默认 http://127.0.0.1:5000）
 * 依赖：puppeteer-core（复用本机 Chrome，不下载浏览器）
 *
 * 用法：
 *   node browser-verify.mjs
 *   可选环境变量：
 *     APP_URL     默认 http://127.0.0.1:5000
 *     CHROME_PATH 默认 C:\Program Files\Google\Chrome\Application\chrome.exe
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5000';
const CHROME =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * puppeteer-core 是**可选**依赖（只在跑本验证时需要）。
 * 用 createRequire 解析，并在缺失时给出可执行的安装提示，
 * 而不是抛 ERR_MODULE_NOT_FOUND 让使用者一头雾水。
 */
const require = createRequire(import.meta.url);

/** 在若干候选位置查找 puppeteer-core（含 NODE_PATH 与常见安装点） */
function loadPuppeteer() {
  const candidates = [];
  if (process.env.PUPPETEER_CORE_PATH) candidates.push(process.env.PUPPETEER_CORE_PATH);
  if (process.env.NODE_PATH) {
    for (const p of process.env.NODE_PATH.split(path.delimiter)) {
      if (p) candidates.push(path.join(p, 'puppeteer-core'));
    }
  }
  candidates.push('puppeteer-core');
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const puppeteer = loadPuppeteer();
if (!puppeteer) {
  console.error('[browser-verify] 缺少可选依赖 puppeteer-core。');
  console.error('  它复用本机已安装的 Chrome，不会下载浏览器。安装：');
  console.error('    npm i puppeteer-core');
  console.error('  若装在别处，用环境变量指向它：');
  console.error('    $env:PUPPETEER_CORE_PATH="<path>/node_modules/puppeteer-core"');
  console.error('    node browser-verify.mjs');
  process.exit(2);
}

/** Metro 对 assetExts 资源的 URL 形态（实测：直接 /assets/engines/x.bin 是 404） */
const WORKER_ASSET =
  '/assets/?unstable_path=assets%2Fengines%2Fjieqi.worker.bin&platform=web';
const WASM_ASSET =
  '/assets/?unstable_path=assets%2Fengines%2Fjieqi.wasm&platform=web';

/** 揭棋初始 FEN（与 utils/chess/jieqiFen.ts 的 JIEQI_START_FEN 一致） */
const START_FEN =
  'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX w R2A2C2P5N2B2r2a2c2p5n2b2 0 1';

const CASES = [
  { name: '初始局面（无历史）', moves: [], depth: 6 },
  { name: '三手历史（h0g2R h9g7 b2b9）', moves: ['h0g2R', 'h9g7', 'b2b9'], depth: 5 },
  {
    name: '长历史（6 手，含黑方揭晓）',
    moves: ['h0g2R', 'h9g7', 'b2b9', 'b7b0R', 'a0a1', 'a9a8'],
    depth: 5,
  },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  console.log('opening ' + APP_URL);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // 等 Metro 完成首次 bundle
  await new Promise((r) => setTimeout(r, 8000));

  const results = await page.evaluate(
    async (workerAsset, wasmAsset, startFen, cases) => {
      const wasmUrl = new URL(wasmAsset, location.href).href;
      const out = [];

      for (const c of cases) {
        const position =
          c.moves.length > 0
            ? `position fen ${startFen} moves ${c.moves.join(' ')}`
            : `position fen ${startFen}`;

        const res = await new Promise((resolve) => {
          const w = new Worker(workerAsset);
          const lines = [];
          let settled = false;
          const done = (r) => {
            if (settled) return;
            settled = true;
            try {
              w.terminate();
            } catch {
              /* ignore */
            }
            resolve(r);
          };
          const timer = setTimeout(() => done({ ok: false, reason: 'timeout', lines }), 60000);

          w.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type === 'done') {
              clearTimeout(timer);
              const all = (m.lines || []).join('\n');
              const bm = all.match(/bestmove\s+([a-i]\d[a-i]\d)/);
              const bad = /Aborted|Assertion|CRITICAL|invalid/i.test(all);
              done({
                ok: !!bm && !bad,
                bestmove: bm ? bm[1] : null,
                uciok: /uciok/.test(all),
                infoLines: (m.lines || []).filter((l) => l.startsWith('info depth')).length,
                bad: bad
                  ? (
                      all
                        .split('\n')
                        .find((l) => /Aborted|Assertion|CRITICAL|invalid/i.test(l)) || ''
                    ).slice(0, 120)
                  : null,
              });
            } else if (m.type === 'error') {
              clearTimeout(timer);
              done({ ok: false, reason: m.message, lines });
            }
          };
          w.onerror = (ev) => {
            clearTimeout(timer);
            done({ ok: false, reason: ev.message, lines });
          };

          w.postMessage({
            type: 'session',
            wasmUrl,
            commands: [
              'uci',
              'isready',
              position,
              `go depth ${c.depth} movetime 3000`,
              'quit',
            ],
          });
        });

        out.push({ name: c.name, ...res });
      }
      return out;
    },
    WORKER_ASSET,
    WASM_ASSET,
    START_FEN,
    CASES
  );

  console.log('\n===== jieqi engine browser E2E =====');
  let pass = 0;
  for (const r of results) {
    console.log(`\n[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}`);
    console.log(`  uciok=${r.uciok} bestmove=${r.bestmove} info=${r.infoLines}`);
    if (r.bad) console.log(`  ! ${r.bad}`);
    if (r.reason) console.log(`  ! ${r.reason}`);
    if (r.ok) pass++;
  }
  if (pageErrors.length) {
    console.log('\n[page errors]');
    pageErrors.slice(-5).forEach((e) => console.log('  ' + e));
  }
  console.log(`\nRESULT: ${pass}/${results.length} passed`);
  process.exitCode = pass === results.length ? 0 : 1;
} finally {
  await browser.close();
}
