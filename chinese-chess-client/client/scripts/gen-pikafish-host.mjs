/**
 * 生成自包含引擎宿主（两个产物，共享同一份 UCI 逻辑）
 *
 *   assets/engines/pikafish.worker.bin   → Web 端 Dedicated Worker（classic worker）
 *   assets/engines/pikafish.html         → Android/iOS WebView 离线页
 *
 * ⚠️ worker 脚本用 **.bin** 后缀（而不是 .js）：.js 属于 Metro 的 sourceExts，
 *    会被 Babel/JSX 管线转译，那两段 5.5MB 的 base64 会被逐字符处理——
 *    启动慢到数十秒、内存峰值数百 MB，且**不报任何错**。
 *    .bin 登记进 metro.config.js 的 assetExts 后按原字节透传。
 *    它只是给 `new Worker(url)` 用的 URL，浏览器不关心后缀。
 *    （.html 本身就在 Expo 默认 assetExts 里，无需额外处理。）
 *
 * ============================================================================
 * 【为什么在构建期把 UCI 逻辑内联进产物，而不是写 TS 让 Metro 打包】
 *
 * 两个产物都必须**单文件自包含**，且要被 WebView 以 file/baseURL 直接加载
 * （离线场景下不能再向 Metro 请求任何分片）。若把 UCI 逻辑写成 TS 模块，
 * WebView 侧就要额外注入 bundle 胶水，且 Web 与 WebView 很容易各打各的、
 * 悄悄漂移。这里改为在生成脚本里内联**同一份**逻辑字符串，
 * 两端产物出自同一次生成，行为必然一致。
 *
 * ============================================================================
 * 【关键运行时事实（已实测，assets/engines/pikafish.host.js 验证）】
 *
 * 1. 引擎搜索是**同步阻塞**的：send('go') 返回时 bestmove 已产生。
 *    → 必须放在 Worker/WebView 里，不能占用 UI 线程。
 * 2. 因为同步，搜索期间发出的 stop **无法中途打断**（要等搜索结束才被处理）。
 *    → 抢占靠"丢弃迟到结果"，靠 depth+movetime 保证有界。
 * 3. 工厂返回的是 Module['ready'] 这个 **Promise**；
 *    send_command / read_stdout 写在传入的 config 对象上。
 *    → 调用方必须持有 config 引用（宿主的 createEngine 已封装好）。
 * 4. NNUE 经 getPreloadedPackage 注入 MEMFS、WASM 经 instantiateWasm 注入，
 *    **全程不碰 fs**（浏览器/Worker 里没有 fs）。
 *
 * ⚠️ 本脚本生成的 loader 与二进制均来自 chinese-chess-server/ai/pikafish，
 *    两端引擎版本因此天然一致（不会出现"联网强、断网弱"）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');
const repoRoot = path.resolve(clientRoot, '..', '..');
/**
 * 引擎**源**二进制的存放位置（客户端自建，不再依赖服务端）。
 *
 * 变迁（2026-10 服务端去 AI 化）：原先这些文件在 chinese-chess-server/ai/pikafish，
 * 客户端从服务端目录拷贝生成。服务端不再承载 AI 后那个目录要删掉，
 * 于是把引擎源迁到客户端自己的 engine-source/ 下 —— 客户端离线引擎自此
 * **完全自持**，不再与服务端耦合。
 */
const serverAi = path.join(clientRoot, 'engine-source', 'pikafish');

const OUT_DIR = path.join(clientRoot, 'assets', 'engines');
const WORKER_OUT = path.join(OUT_DIR, 'pikafish.worker.bin');
const HTML_OUT = path.join(OUT_DIR, 'pikafish.html');
/** Web 端 Worker 直接 fetch 的二进制（不再 base64 内联，见下方性能说明） */
const WASM_OUT = path.join(OUT_DIR, 'pikafish.wasm');
const NNUE_OUT = path.join(OUT_DIR, 'pikafish.nnue');

const loaderPath = path.join(serverAi, 'pikafish.cjs');
const wasmPath = path.join(serverAi, 'pikafish.wasm');
const dataPath = path.join(serverAi, 'data', 'pikafish.data');

for (const p of [loaderPath, wasmPath, dataPath]) {
  if (!fs.existsSync(p)) {
    console.error(`[gen-pikafish-host] 缺少引擎文件: ${p}`);
    process.exit(1);
  }
}

const loaderSrc = fs.readFileSync(loaderPath, 'utf8');
const wasmBuf = fs.readFileSync(wasmPath);
const dataBuf = fs.readFileSync(dataPath);
const wasmB64 = wasmBuf.toString('base64');
const dataB64 = dataBuf.toString('base64');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const wasmSha = sha256(wasmBuf);
const dataSha = sha256(dataBuf);

/**
 * UCI 状态机（内联进两个产物，保证 Web 与 WebView 行为一致）
 *
 * 只负责：banner/option 收集、info 累积、bestmove 收尾、致命错误上报。
 * **不做**业务判断（合法性、禁着、坐标换算）——那些在主线程 pikafishUci.ts 做。
 */
const UCI_CORE = `
var BANNER_RE = /\\bPikafish\\b/i;
var DEV_RE = /developers/i;
var DEPTH_RE = /info depth (\\d+)/;
var TIME_RE = /\\btime (\\d+)/;
var MULTIPV_RE = /\\bmultipv (\\d+)/;
var PV_RE = /\\bpv\\s+([a-i][0-9][a-i][0-9])/;
var BEST_RE = /^bestmove\\s+([a-i][0-9][a-i][0-9])/;
var OPTION_RE = /^option\\s+name\\s+(\\S+)/;
var CRIT_RE = /CRITICAL ERROR/i;
var QUIT_RE = /^quit\\s*$/i;
var MOVE_RE = /^[a-i][0-9][a-i][0-9]$/;

function PikaCore(send) {
  var options = {};
  var banner = '';
  var bootstrapped = false;
  var info = { depth: 0, candidates: {}, candidateDepth: 0, timeMs: 0 };
  var currentSeq = null;
  var randomPick = false;
  var stopRequested = false;

  function resetInfo() { info = { depth: 0, candidates: {}, candidateDepth: 0, timeMs: 0 }; }

  function candidatesInOrder() {
    var keys = Object.keys(info.candidates).map(Number).sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var v = info.candidates[keys[i]];
      if (MOVE_RE.test(v)) out.push(v);
    }
    return out;
  }

  function fatal(message) {
    var seq = currentSeq;
    currentSeq = null;
    if (seq !== null) {
      send({ type: 'result', seq: seq, fatal: true,
             result: { uci: '', depth: info.depth, candidates: [], timeMs: info.timeMs } });
    } else {
      send({ type: 'error', message: message });
    }
  }

  function finish(line) {
    var seq = currentSeq;
    currentSeq = null;
    var m = BEST_RE.exec(line);
    var cands = candidatesInOrder();
    var uci = m ? m[1] : null;
    if (!uci && cands.length) {
      // bestmove 行缺失但累积到了候选：兜底取一条（正常路径不会走到）
      uci = (randomPick && cands.length > 1) ? cands[Math.floor(Math.random() * cands.length)] : cands[0];
    }
    if (!uci) {
      send({ type: 'result', seq: seq, fatal: true,
             result: { uci: '', depth: info.depth, candidates: cands, timeMs: info.timeMs } });
    } else {
      send({ type: 'result', seq: seq, result: { uci: uci, depth: info.depth, candidates: cands, timeMs: info.timeMs } });
    }
    if (stopRequested) { stopRequested = false; send({ type: 'stopped', seq: seq }); }
  }

  function onLine(raw) {
    var s = String(raw).trim();
    if (!s) return;
    if (BEST_RE.test(s)) { finish(s); return; }
    if (CRIT_RE.test(s)) { fatal('engine CRITICAL ERROR'); return; }
    if (QUIT_RE.test(s)) { send({ type: 'error', message: 'engine quit unexpectedly' }); return; }

    if (BANNER_RE.test(s) && DEV_RE.test(s)) {
      // 引擎会连着打印多行（id name / id author / …）。真正的横幅是**以 Pikafish 开头**的那行，
      // 优先保留它；否则退而记录任何一行（含版本号，最坏情况是 author 行）。
      if (!banner || /^Pikafish\\b/.test(s)) banner = s;
    }
    var o = OPTION_RE.exec(s);
    if (o) options[o[1]] = true;

    if (s.indexOf('info') !== 0) return;
    var d = DEPTH_RE.exec(s);
    if (d) { var depth = parseInt(d[1], 10); if (depth > info.depth) info.depth = depth; }
    var t = TIME_RE.exec(s);
    if (t) info.timeMs = parseInt(t[1], 10);
    var mp = MULTIPV_RE.exec(s);
    var pv = PV_RE.exec(s);
    if (mp && pv) {
      var dd = d ? parseInt(d[1], 10) : info.depth;
      if (dd > info.candidateDepth) { info.candidates = {}; info.candidateDepth = dd; }
      if (dd === info.candidateDepth) info.candidates[parseInt(mp[1], 10)] = pv[1];
    }
  }

  return {
    onLine: onLine,
    isBootstrapped: function () { return bootstrapped; },
    isBusy: function () { return currentSeq !== null; },
    /** 握手：引擎 ready 后发 uci + isready（同步引擎，输出即刻产生） */
    handshake: function () {
      bootstrapped = true;
      send({ type: 'ready', banner: banner, options: Object.keys(options) });
    },
    beginSearch: function (seq, random) {
      if (currentSeq !== null) { send({ type: 'error', message: 'engine busy' }); return; }
      currentSeq = seq;
      randomPick = !!random;
      resetInfo();
      stopRequested = false;
    },
    stop: function () {
      if (currentSeq === null) return false;   // 空闲：交给上层直接 stop
      stopRequested = true;                   // 搜索中：bestmove 之后补发
      return true;
    },
  };
}
`;

const WORKER_BODY = `/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 * 由 client/scripts/gen-pikafish-host.mjs 生成。
 *   loader : client/engine-source/pikafish/pikafish.cjs
 *   wasm   : client/engine-source/pikafish/pikafish.wasm        (sha256 ${wasmSha})
 *   data   : client/engine-source/pikafish/data/pikafish.data  (sha256 ${dataSha})
 *
 * classic Web Worker（**不再内联二进制**）：收到 bootstrap 后用 fetch 并行拉取
 * pikafish.wasm / pikafish.nnue，可在无 require/__dirname/fs 的环境运行。
 * Pikafish 引擎为 GPL-3.0，权重受其独立许可约束；本项目仅内部娱乐使用。
 *
 * 协议（与 pikafish.html 基本一致，差别只在 bootstrap 带 URL）：
 *   in : {type:'bootstrap',wasmUrl,nnueUrl}
 *        {type:'search',seq,commands,randomPick} {type:'stop'} {type:'dispose'}
 *   out: {type:'host-loaded'} {type:'ready',banner,options} {type:'result',seq,result,fatal?}
 *        {type:'error',message} {type:'stopped',seq}
 *
 * ⚠️ 后缀是 .bin 而非 .js：内容虽是 JS，但必须按静态资源原样透传（见脚本头部说明）。
 *    经典 Worker 不要求 MIME 为 JS，浏览器按 URL 取回后直接当脚本执行。
 */
'use strict';

var send = function (msg) { self.postMessage(msg); };
${UCI_CORE}

var WASM_BYTES = null;
var DATA_BYTES = null;

/**
 * 从 URL 拉取二进制（**不再内联 base64**）。
 *
 * ============================================================================
 * 【为什么改成 fetch · 2026-10 性能优化（实测数据）】
 *
 * 原方案把 wasm + nnue 以 base64 内联进脚本。实测代价：
 *   · 体积膨胀 +38%：二进制 4.39MiB → 文本 6.06MiB；
 *   · 脚本本身 6.3MiB，Worker 启动要先解析这两段巨型字面量；
 *   · 本机 dev server 传 6.06MiB 实测约 3.6s，是"首次启动慢"的主因。
 *   （base64 解码本身只占 ~6ms，不是瓶颈；瓶颈是**传输**与**解析**。）
 *
 * 改为把 wasm/nnue 作为独立二进制资源后：
 *   · 传输 6.06MiB → 4.39MiB（-27.5%），且两个文件可**并行**下载；
 *   · Worker 脚本降到几十 KB，解析几乎不花时间；
 *   · 完全省掉 base64 解码与中间字符串。
 *
 * 页面侧（WebView）仍沿用内联 base64 的 html：原生 WebView 以 inline HTML 承载时
 * 没有可用的同源 origin，fetch 兄弟资源会被跨源/CORS 挡住，内联是唯一稳妥选择。
 * 两条路径共用同一份 UCI 逻辑（见 UCI_CORE），行为保持一致。
 */
function fetchBytes(url) {
  return fetch(url, { credentials: 'same-origin' }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.arrayBuffer();
  });
}

/** 并行拉取 wasm 与 nnue；任一失败都让 bootstrap 失败（由上层退避重试） */
function loadBinaries(wasmUrl, nnueUrl) {
  return Promise.all([fetchBytes(wasmUrl), fetchBytes(nnueUrl)]).then(function (bufs) {
    WASM_BYTES = new Uint8Array(bufs[0]);
    DATA_BYTES = new Uint8Array(bufs[1]);
    var expect = ${dataBuf.length};
    if (DATA_BYTES.length !== expect) {
      throw new Error('pikafish.nnue size mismatch: ' + DATA_BYTES.length + ' != ' + expect);
    }
  });
}

// 内联服务端 Emscripten 加载器：它顶层 require('fs') / __dirname，
// 这里提供**永不被调用**的替身（真实加载走 getPreloadedPackage / instantiateWasm）。
var fsStub = { readFile: function (p, cb) { cb(new Error('fs unavailable: ' + p)); } };
function req(name) { if (name === 'fs') return fsStub; throw new Error('unexpected require: ' + name); }
var mod = { exports: {} };

(function (require, module, exports, __dirname) {
${loaderSrc}
})(req, mod, mod.exports, '/pikafish');

var factory = mod.exports;

/**
 * 创建引擎实例。
 *
 * ⚠️ 契约：factory 返回 Module['ready']（Promise），而 send_command / read_stdout
 *    被 loader 写在**传入的 config 对象**上。因此必须持有 config 引用。
 */
function createEngine(onOutput) {
  if (!WASM_BYTES || !DATA_BYTES) throw new Error('binaries not loaded');
  var config = {
    print: function () {},
    printErr: function (t) { onOutput('CRITICAL ERROR ' + t); },
    setStatus: function () {},
    read_stdout: function (text) {
      var lines = String(text).split('\\n');
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (l) onOutput(l);
      }
    },
    getPreloadedPackage: function (name, size) {
      if (name !== 'pikafish.data') return null;
      if (DATA_BYTES.length !== size) throw new Error('pikafish.data size mismatch');
      return DATA_BYTES.buffer;
    },
    wasmBinary: WASM_BYTES,
    instantiateWasm: function (imports, onSuccess) {
      WebAssembly.instantiate(WASM_BYTES, imports).then(
        function (res) { onSuccess(res.instance, res.module); },
        function (err) { onOutput('CRITICAL ERROR instantiate: ' + ((err && err.message) || err)); }
      );
      return {};
    },
    locateFile: function (p) { return p; }
  };
  var ready = factory(config);
  return {
    ready: ready,
    send: function (cmd) {
      if (typeof config.send_command !== 'function') throw new Error('engine not ready');
      config.send_command(cmd);
    }
  };
}

var engine = null;
var core = null;

function getCore() { if (!core) core = PikaCore(send); return core; }

/**
 * bootstrap 需要带上 wasm / nnue 的 URL（本 Worker 不再内联二进制）。
 * @param {{wasmUrl?:string, nnueUrl?:string}} msg
 */
function bootstrap(msg) {
  var wasmUrl = msg && msg.wasmUrl;
  var nnueUrl = msg && msg.nnueUrl;
  if (!wasmUrl || !nnueUrl) {
    send({ type: 'error', message: 'bootstrap 缺少 wasmUrl/nnueUrl' });
    return;
  }
  loadBinaries(wasmUrl, nnueUrl).then(function () {
    engine = createEngine(function (line) { getCore().onLine(line); });
    return engine.ready;
  }).then(function () {
    engine.send('uci');
    engine.send('isready');
    getCore().handshake();
  }, function (err) {
    send({ type: 'error', message: (err && err.message) || String(err) });
  });
}

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || !msg.type) return;
  try {
    if (msg.type === 'bootstrap') { bootstrap(msg); return; }
    if (msg.type === 'search') {
      if (!engine) { send({ type: 'error', message: 'engine not bootstrapped' }); return; }
      var c = getCore();
      if (c.isBusy()) { send({ type: 'error', message: 'engine busy' }); return; }
      c.beginSearch(msg.seq, msg.randomPick);
      for (var i = 0; i < msg.commands.length; i++) engine.send(msg.commands[i]);
      return;
    }
    if (msg.type === 'stop') {
      var cc = getCore();
      if (cc.isBusy()) { cc.stop(); return; }
      if (engine && engine.send) { try { engine.send('stop'); } catch (e) {} }
      return;
    }
    if (msg.type === 'dispose') {
      try { if (engine) { engine.send('stop'); engine.send('quit'); } } catch (e) {}
      engine = null; core = null;
      return;
    }
  } catch (err) {
    send({ type: 'error', message: (err && err.message) || String(err) });
  }
};

send({ type: 'host-loaded' });
`;

const HTML_BODY = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>Pikafish Host</title>
</head>
<body>
<script>
/**
 * GENERATED FILE — DO NOT EDIT.
 * 由 client/scripts/gen-pikafish-host.mjs 生成（与 pikafish.worker.js 共享同一份 UCI 逻辑）。
 * 离线引擎页：不发任何网络请求，宿主脚本内联在本文件中。
 * 协议与 pikafish.worker.js 完全一致。
 *
 * Pikafish 引擎：GPL-3.0（源二进制见 client/engine-source/pikafish/）。
 * NNUE 权重：受皮卡鱼官方 NNUE 协议约束（非 GPL，商用需另行授权）。
 * 本项目仅内部娱乐使用。
 */
'use strict';

var send = function (msg) {
  if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
};
${UCI_CORE}

function b64ToBytes(b64) {
  var clean = b64.replace(/\\s+/g, '');
  var CHUNK = 32768;
  var bin = '';
  for (var i = 0; i < clean.length; i += CHUNK) {
    bin += atob(clean.slice(i, i + CHUNK));
  }
  var bytes = new Uint8Array(bin.length);
  for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
  return bytes;
}

var WASM_B64 = '${wasmB64}';
var DATA_B64 = '${dataB64}';
var DATA_SIZE = ${dataBuf.length};
var WASM_BYTES = null;
var DATA_BYTES = null;

function ensureBinaries() {
  if (!WASM_BYTES) WASM_BYTES = b64ToBytes(WASM_B64);
  if (!DATA_BYTES) DATA_BYTES = b64ToBytes(DATA_B64);
}

var fsStub = { readFile: function (p, cb) { cb(new Error('fs unavailable: ' + p)); } };
function req(name) { if (name === 'fs') return fsStub; throw new Error('unexpected require: ' + name); }
var mod = { exports: {} };

(function (require, module, exports, __dirname) {
${loaderSrc}
})(req, mod, mod.exports, '/pikafish');

var factory = mod.exports;

function createEngine(onOutput) {
  ensureBinaries();
  var config = {
    print: function () {},
    printErr: function (t) { onOutput('CRITICAL ERROR ' + t); },
    setStatus: function () {},
    read_stdout: function (text) {
      var lines = String(text).split('\\n');
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (l) onOutput(l);
      }
    },
    getPreloadedPackage: function (name, size) {
      if (name !== 'pikafish.data') return null;
      if (DATA_BYTES.length !== size) throw new Error('pikafish.data size mismatch');
      return DATA_BYTES.buffer;
    },
    wasmBinary: WASM_BYTES,
    instantiateWasm: function (imports, onSuccess) {
      WebAssembly.instantiate(WASM_BYTES, imports).then(
        function (res) { onSuccess(res.instance, res.module); },
        function (err) { onOutput('CRITICAL ERROR instantiate: ' + ((err && err.message) || err)); }
      );
      return {};
    },
    locateFile: function (p) { return p; }
  };
  var ready = factory(config);
  return {
    ready: ready,
    send: function (cmd) {
      if (typeof config.send_command !== 'function') throw new Error('engine not ready');
      config.send_command(cmd);
    }
  };
}

var engine = null;
var core = null;
function getCore() { if (!core) core = PikaCore(send); return core; }

function bootstrap() {
  engine = createEngine(function (line) { getCore().onLine(line); });
  engine.ready.then(function () {
    engine.send('uci');
    engine.send('isready');
    getCore().handshake();
  }, function (err) {
    send({ type: 'error', message: (err && err.message) || String(err) });
  });
}

window.addEventListener('message', function (ev) {
  var msg = ev && ev.data;
  if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
  if (!msg || !msg.type) return;
  try {
    if (msg.type === 'bootstrap') { bootstrap(); return; }
    if (msg.type === 'search') {
      if (!engine) { send({ type: 'error', message: 'engine not bootstrapped' }); return; }
      var c = getCore();
      if (c.isBusy()) { send({ type: 'error', message: 'engine busy' }); return; }
      c.beginSearch(msg.seq, msg.randomPick);
      for (var i = 0; i < msg.commands.length; i++) engine.send(msg.commands[i]);
      return;
    }
    if (msg.type === 'stop') {
      var cc = getCore();
      if (cc.isBusy()) { cc.stop(); return; }
      if (engine) { try { engine.send('stop'); } catch (e) {} }
      return;
    }
    if (msg.type === 'dispose') {
      try { if (engine) { engine.send('stop'); engine.send('quit'); } } catch (e) {}
      engine = null; core = null;
    }
  } catch (err) {
    send({ type: 'error', message: (err && err.message) || String(err) });
  }
});

send({ type: 'host-loaded' });
</script>
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(WORKER_OUT, WORKER_BODY, 'utf8');
fs.writeFileSync(HTML_OUT, HTML_BODY, 'utf8');
// Web 端 Worker 直接 fetch 这两个二进制（不再 base64 内联）
fs.copyFileSync(wasmPath, WASM_OUT);
fs.copyFileSync(dataPath, NNUE_OUT);

const ws = fs.statSync(WORKER_OUT).size;
const hs = fs.statSync(HTML_OUT).size;
console.log('[gen-pikafish-host] 已生成：');
console.log(`  ${path.relative(clientRoot, WORKER_OUT)}  ${ws} B (${(ws / 1048576).toFixed(2)} MiB)  ← Web Worker（小）`);
console.log(`  ${path.relative(clientRoot, HTML_OUT)}  ${hs} B (${(hs / 1048576).toFixed(2)} MiB)  ← 原生 WebView（内联）`);
console.log(`  ${path.relative(clientRoot, WASM_OUT)}  ${wasmBuf.length} B`);
console.log(`  ${path.relative(clientRoot, NNUE_OUT)}  ${dataBuf.length} B`);
console.log(`  Web 端首启需传：${((ws + wasmBuf.length + dataBuf.length) / 1048576).toFixed(2)} MiB` +
  `（原单文件方案为 ${(hs / 1048576).toFixed(2)} MiB）`);
console.log(`  wasm sha256 : ${wasmSha}`);
console.log(`  data sha256 : ${dataSha}`);
