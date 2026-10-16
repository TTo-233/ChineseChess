/**
 * 在**真实 Chromium 内核**里端到端验证自包含引擎产物（2026-10 新增）
 *
 * ============================================================================
 * 【为什么必须真的执行一遍，而不是只校验字节】
 *
 * verify-pikafish-engine-assets.mjs / verify-jieqi-engine-assets.mjs 只做
 * sha256 与"关键字符出现次数"检查——产物里内联的东西被截断、glue 包装被改坏、
 * 协议关键字对不上但文件仍完整，这些都照样绿灯。
 *
 * 而真实故障恰恰发生在**运行期**：用户在实机看到"皮卡鱼启动中"，
 * 排查一圈才发现问题不在产物、而在 RN 侧的承载接线。
 * 本脚本的作用就是把"产物能不能跑"这个前提性问题**一次性钉死**，
 * 让后续排查不必再怀疑产物。
 *
 * ============================================================================
 * 【为什么模拟方式要"像原生"】
 *
 * · 通过 `Page.addScriptToEvaluateOnNewDocument` 注入 `window.ReactNativeWebView`
 *   桩 —— 必须**在页面脚本执行之前**注入（与原生注入时机一致）。
 *   若改用"加载后再补注入"，页面的 `send({type:'host-loaded'})` 早已执行，
 *   桩还不存在，探针会给出假失败。
 * · 经**本地 http server** 提供页面，不用 data: URL —— data: 导航会新建
 *   document，导致预注入失效（实测踩过）。
 * · 轮询等待必须 `setTimeout` 让出主线程。**不能用 `while` 忙等**：
 *   忙等会占死主线程，WASM 实例化与引擎回调根本跑不起来，
 *   表现为"引擎永远不 ready"的假失败（实测踩过，这是最阴的一个坑）。
 *
 * ============================================================================
 * 【用法】
 *
 *   node scripts/verify-engine-in-chromium.mjs              # 验证全部引擎
 *   node scripts/verify-engine-in-chromium.mjs pikafish    # 只验证象棋
 *   node scripts/verify-engine-in-chromium.mjs jieqi
 *
 * 退出码 0 = 通过；非 0 = 失败（原因打印到 stderr）。
 *
 * ⚠️ 若机器上没有 Chrome/Edge，脚本**跳过并 exit 0**：
 *    CI 环境未必装了浏览器，不应该因此阻塞流水线（产物完整性仍由
 *    verify-*-engine-assets.mjs 保证）。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');
const ENGINE_DIR = path.join(clientRoot, 'assets', 'engines');

/** 逐个引擎的验证规格 */
const SPECS = {
  pikafish: {
    file: 'pikafish.page',
    label: '皮卡鱼（象棋）',
    /**
     * ⚠️ bootstrap 必须带 wasmUrl/nnueUrl（2026-10 真机修复后页面改为 fetch 二进制，
     * 不再内联 base64）。本地 http server 会把两个产物作为兄弟资源一起提供。
     */
    bootstrap: (urls) => ({
      type: 'bootstrap',
      wasmUrl: urls.wasm,
      nnueUrl: urls.nnue,
    }),
    /** 页面之外还需要提供的二进制产物（相对 assets/engines/） */
    binaries: [
      { key: 'wasm', file: 'pikafish_wasm.wasm' },
      { key: 'nnue', file: 'pikafish_nnue.nnue' },
    ],
    /** 等待页面自发的那条消息 */
    expect: 'ready',
    expectTimeoutMs: 60000,
    /** 握手成功后发一次真实搜索 */
    search: {
      type: 'search',
      seq: 1,
      randomPick: false,
      commands: ['ucinewgame', 'position startpos', 'go depth 6'],
    },
    expectAfterSearch: 'result',
    searchTimeoutMs: 90000,
    /** 从 result 消息里判定成功 */
    ok: (msg) => !!(msg.result && msg.result.uci),
    describe: (msg) => `bestmove=${msg.result.uci} depth=${msg.result.depth} ${msg.result.timeMs}ms`,
  },
  jieqi: {
    file: 'jieqi.page',
    label: '揭棋引擎',
    bootstrap: {
      type: 'session',
      commands: ['uci', 'isready', 'position startpos', 'go depth 4', 'quit'],
    },
    expect: 'host-loaded',
    expectTimeoutMs: 20000,
    /** 揭棋是一次性批量会话：注入即执行，不需要额外的 search */
    search: null,
    expectAfterSearch: 'done',
    searchTimeoutMs: 90000,
    ok: (msg) => Array.isArray(msg.lines) && msg.lines.some((l) => /^bestmove\s/.test(l)),
    describe: (msg) => {
      const best = (msg.lines || []).find((l) => /^bestmove\s/.test(l)) || '(缺)';
      return `banner="${msg.banner || ''}" 行数=${(msg.lines || []).length} ${best}`;
    },
  },
};

/** 找浏览器（Chromium 内核与 Android WebView 同源，可作为原生 WebView 的代理） */
function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** Node 22+ 自带全局 WebSocket，无需外部依赖 */
function hasWebSocket() {
  return typeof globalThis.WebSocket === 'function';
}

/** 单个引擎的验证：起浏览器 → 注入桩 → 载页 → 握手 → 搜索 */
async function verifyOne(spec, bin) {
  const htmlPath = path.join(ENGINE_DIR, spec.file);
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`产物缺失：${path.relative(clientRoot, htmlPath)}（先跑 gen-${spec.label.includes('揭棋') ? 'jieqi' : 'pikafish'}-host）`);
  }
  const html = fs.readFileSync(htmlPath, 'utf8');

  const userDataDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'engine-cdp-'));
  const port = 9700 + Math.floor(Math.random() * 400);
  const proc = spawn(
    bin,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let ws = null;
  let msgId = 0;
  const pending = new Map();
  const pageLogs = [];

  const cleanup = () => {
    try {
      proc.kill();
    } catch {
      /* 忽略 */
    }
    try {
      ws?.close();
    } catch {
      /* 忽略 */
    }
  };

  try {
    // 等 DevTools 端口就绪
    let version = null;
    for (let i = 0; i < 60 && !version; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!version) throw new Error('DevTools 端口未就绪（浏览器可能无法启动）');

    ws = new globalThis.WebSocket(version.webSocketDebuggerUrl);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });

    const send = (method, params, sessionId) => {
      const id = ++msgId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    };

    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (text) pageLogs.push(text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        pageLogs.push(
          '[exception] ' +
            (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text)
        );
      }
    });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);

    // ⚠️ 必须在页面脚本执行前注入（复刻原生注入时机）
    await send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: `
          window.__msgs = [];
          window.ReactNativeWebView = {
            postMessage: function (s) { window.__msgs.push(s); }
          };
          // 页面侧轮询助手：必须用 setTimeout 让出主线程
          window.__waitFor = function (type, timeoutMs) {
            return new Promise(function (resolve) {
              var t0 = Date.now();
              function check() {
                for (var i = 0; i < window.__msgs.length; i++) {
                  try { var m = JSON.parse(window.__msgs[i]); if (m.type === type) return resolve(JSON.stringify(m)); } catch (e) {}
                }
                if (Date.now() - t0 > timeoutMs) return resolve(null);
                setTimeout(check, 50);
              }
              check();
            });
          };
          true;
        `,
      },
      sessionId
    );

    /**
     * 本地 http server：**页面 + 它要 fetch 的二进制**。
     *
     * ⚠️ 这一段是本脚本能覆盖真机故障的关键：原生页面现在靠 fetch 拿
     *    wasm/nnue（不再内联 base64），所以必须像真机那样把这些文件作为
     *    **同源独立资源**提供出去。若只提供页面、不提供二进制，
     *    页面会在 bootstrap 阶段报 "HTTP 404"，那时我们会立刻看到红灯，
     *    而不是像以前那样"内联 base64 所以永远绿"。
     */
    const binPaths = {};
    for (const b of spec.binaries || []) {
      const p = path.join(ENGINE_DIR, b.file);
      if (!fs.existsSync(p)) {
        throw new Error(`缺少引擎二进制产物：${b.file}（先跑 gen-*-host）`);
      }
      binPaths[b.key] = p;
    }

    const srv = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
      // 命中任意一个二进制产物：按原始字节返回（wasm 用 application/wasm）
      for (const [key, filePath] of Object.entries(binPaths)) {
        if (reqPath === '/' + key) {
          const buf = fs.readFileSync(filePath);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': buf.length,
            'Cache-Control': 'no-store',
          });
          res.end(buf);
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const httpPort = srv.address().port;

    // 与真机一致：bootstrap 带上二进制 URL（原生是 file://，这里是 http://）
    const bootstrapMsg =
      typeof spec.bootstrap === 'function'
        ? spec.bootstrap({
            wasm: `http://127.0.0.1:${httpPort}/wasm`,
            nnue: `http://127.0.0.1:${httpPort}/nnue`,
          })
        : spec.bootstrap;

    await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/engine.html` }, sessionId);
    await new Promise((r) => setTimeout(r, 1000));

    const evalJs = async (expression) => {
      const r = await send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId
      );
      if (r.exceptionDetails) {
        throw new Error(
          r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面求值失败'
        );
      }
      return r.result.value;
    };

    // 1) 页面自发的就绪消息
    //
    // ⚠️ 顺序要点：必须先等 "host-loaded"（页面脚本已就位、可以接收消息），
    //    **再**注入握手消息；反过来（先等 ready 再发 bootstrap）会永远等不到，
    //    因为 ready 正是 bootstrap 的产物。
    const loaded = await evalJs(`window.__waitFor('host-loaded', ${spec.expectTimeoutMs})`);
    if (!loaded) {
      const seen = await evalJs('JSON.stringify(window.__msgs.slice(0, 8))');
      throw new Error(
        `${spec.expectTimeoutMs}ms 内未收到 "host-loaded"；已收到: ${seen}` +
          (pageLogs.length ? `\n页面日志: ${pageLogs.slice(0, 10).join(' | ')}` : '')
      );
    }

    // 2) 注入握手/会话消息
    await evalJs(
      `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(bootstrapMsg)} })); true;`
    );

    if (!spec.search) {
      // 揭棋：一次性会话，注入即执行，等 done/error
      const done = await evalJs(
        `window.__waitFor('done', ${spec.searchTimeoutMs}) || window.__waitFor('error', 1000)`
      );
      if (!done) throw new Error(`${spec.searchTimeoutMs}ms 内会话未返回 done`);
      const msg = JSON.parse(done);
      if (msg.type === 'error') throw new Error(`揭棋会话错误: ${msg.message}`);
      if (!spec.ok(msg)) {
        throw new Error(`会话完成但结果不合格: ${JSON.stringify(msg).slice(0, 300)}`);
      }
      return { banner: msg.banner || '', detail: spec.describe(msg) };
    }

    // 3) 象棋：握手成功后发一次真实搜索
    const readyMsg = await evalJs(`window.__waitFor('ready', ${spec.expectTimeoutMs})`);
    if (!readyMsg) {
      const seen = await evalJs('JSON.stringify(window.__msgs.slice(0, 8))');
      throw new Error(
        `${spec.expectTimeoutMs}ms 内未收到 "ready"；已收到: ${seen}` +
          (pageLogs.length ? `\n页面日志: ${pageLogs.slice(0, 10).join(' | ')}` : '')
      );
    }
    const banner = JSON.parse(readyMsg).banner || '';

    const result = await evalJs(
      `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(spec.search)} }));` +
        ` window.__waitFor('result', ${spec.searchTimeoutMs}) || window.__waitFor('error', 1000)`
    );
    if (!result) throw new Error(`${spec.searchTimeoutMs}ms 内未收到搜索结果`);
    const msg = JSON.parse(result);
    if (msg.type === 'error') throw new Error(`引擎报错: ${msg.message}`);
    if (!spec.ok(msg)) throw new Error(`结果不合格: ${JSON.stringify(msg).slice(0, 300)}`);
    return { banner, detail: spec.describe(msg) };
  } finally {
    cleanup();
    // ⚠️ Chrome 的子进程可能仍持有 stdio，Node 事件循环不会自然退出 → 脚本"卡住"。
    // 验证结果已经拿到，直接结束进程是最简单的收尾。
    process.exitCode = 0;
  }
}

async function main() {
  const only = process.argv[2];
  const targets = only ? { [only]: SPECS[only] } : SPECS;

  if (!hasWebSocket()) {
    console.log('[verify-engine-chromium] 跳过：当前 Node 无全局 WebSocket（需 Node 22+）');
    return;
  }
  const bin = findChromium();
  if (!bin) {
    console.log('[verify-engine-chromium] 跳过：本机未找到 Chrome/Edge/Chromium');
    return;
  }

  let failed = 0;
  for (const [key, spec] of Object.entries(targets)) {
    if (!spec) {
      console.error(`[verify-engine-chromium] 未知引擎: ${key}`);
      failed += 1;
      continue;
    }
    const sizeMiB = (() => {
      try {
        return (fs.statSync(path.join(ENGINE_DIR, spec.file)).size / 1048576).toFixed(2);
      } catch {
        return '?';
      }
    })();
    process.stdout.write(`[verify-engine-chromium] ${spec.label}（${spec.file} ${sizeMiB} MiB）… `);
    try {
      const { banner, detail } = await verifyOne(spec, bin);
      console.log(`通过\n    ${detail}`);
      if (banner) console.log(`    ${banner}`);
    } catch (err) {
      failed += 1;
      console.log('失败');
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failed > 0) {
    console.error(`[verify-engine-chromium] ${failed} 个引擎未通过`);
    // Chrome 子进程常驻会让事件循环不空，这里必须显式退出，否则脚本挂住不退。
    process.exit(1);
  }
  console.log('[verify-engine-chromium] 全部引擎在真实 Chromium 中验证通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('[verify-engine-chromium] 验证脚本异常:', e instanceof Error ? e.message : e);
  process.exit(1);
});