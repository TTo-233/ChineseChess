/**
 * 生成自包含引擎宿主（两个产物，共享同一份 UCI 逻辑）
 *
 *   assets/engines/pikafish_worker.bin → Web 端 Dedicated Worker（classic worker）
 *   assets/engines/pikafish.html       → Android/iOS WebView 离线页
 *
 * ⚠️ worker 脚本用 **.bin** 后缀（而不是 .js）：.js 属于 Metro 的 sourceExts，
 *    会被 Babel/JSX 管线转译，那两段 5.5MB 的 base64 会被逐字符处理——
 *    启动慢到数十秒、内存峰值数百 MB，且**不报任何错**。
 *    .bin 登记进 metro.config.js 的 assetExts 后按原字节透传。
 *    它只是给 `new Worker(url)` 用的 URL，浏览器不关心后缀。
 *
 * ⚠️ 产物文件名的 **stem 必须彼此不同**（2026-10 Android 构建阻塞修复）：
 *    这些产物会被 Metro 打进 Android `res/raw/`，而 AAPT 以
 *    「**去掉最后一个扩展名**的相对路径」作资源名，stem 相同的两个文件会压成
 *    同一个 raw 资源 → Duplicate resources，构建在 mergeReleaseResources 失败
 *    （实测：Run gradlew 跑了近 6 分钟后报错）。
 *    ⚠️ 改扩展名**没用**（被剥离的是最后一个点之后的任意后缀），
 *       必须改扩展名之前的那一段。故命名统一为
 *       pikafish_worker.bin / pikafish_wasm.wasm / pikafish_nnue.nnue / pikafish.html。
 *    该约束由 client/scripts/verify-asset-resource-names.mjs 常态校验。
 *
 * ⚠️⚠️ 原生端离线页**必须叫 .html，绝不能回退到 .page**（2026-10 真机实锤）：
 *    expo-asset 把 res/raw 资源复制进应用 cache 时**原样保留扩展名**，
 *    WebView 以 `file://…/ExponentAsset-<hash>.<ext>` 导航时**按扩展名**决定
 *    Content-Type：`.page` 无注册 MIME → text/plain → 整页进 <pre>、
 *    0 个 <script> 执行 → host-loaded 永不到来 → 引擎必然启动超时。
 *    （PTP-AN10 真机 CDP 实测 contentType==='text/plain'、scriptCount===0。）
 *    当年改 .page 是因为旧产物 pikafish.html 与 pikafish.wasm 同 stem 撞资源名；
 *    现产物 stem 已唯一（pikafish / pikafish_wasm / pikafish_nnue / pikafish_worker），
 *    .html 不再撞名，而 .page 的渲染坑是真实的——两害相权，回 .html。
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
/**
 * ⚠️ 每个产物文件名在「扩展名之前」的部分（stem）必须彼此不同，
 *    否则 Android 构建会失败（2026-10 真实踩过，详见下方 HTML_OUT 的长注释）：
 *
 * AAPT 以「**去掉最后一个扩展名**的相对路径」生成 raw 资源名，于是
 *   pikafish_wasm.wasm  → raw/assets_engines_pikafish_wasm
 *   pikafish_nnue.nnue  → raw/assets_engines_pikafish_nnue
 *   pikafish.html       → raw/assets_engines_pikafish
 *   pikafish_worker.bin → raw/assets_engines_pikafish_worker
 *
 * ⚠️ 关键：**改扩展名无效**（被剥离的是"最后一个点之后的任意后缀"，
 *    与后缀是什么无关）。必须改 stem。
 *    （曾因此把页面命名成 pikafish.page——但 expo-asset 复制进 cache 会保留
 *    .page 扩展名，WebView 按 text/plain 渲染、脚本不执行，见文件头长注释。
 *    现在 wasm/nnue 已改名 pikafish_wasm/pikafish_nnue，stem 互异，页面安全回 .html。）
 *
 * 该约束由 client/scripts/verify-asset-resource-names.mjs 常态校验（已进 pnpm -w validate），
 * 因此新增引擎产物时它会立刻拦下，而不是让你等一次 6 分钟的 Gradle 构建。
 */
const WORKER_OUT = path.join(OUT_DIR, 'pikafish_worker.bin');
/**
 * 原生端离线页（小页面 + 运行时 fetch 两个二进制，见 HTML_BODY 说明）。
 *
 * ⚠️ 扩展名必须是 .html：原生端经 expo-asset 落成 file:// 缓存文件后，
 * WebView 按扩展名决定 Content-Type（.page → text/plain → 脚本不执行）。
 * 详见文件头「必须叫 .html」的长注释。
 */
const HTML_OUT = path.join(OUT_DIR, 'pikafish.html');
/** Web 端 Worker 直接 fetch 的二进制（不再 base64 内联，见下方性能说明） */
const WASM_OUT = path.join(OUT_DIR, 'pikafish_wasm.wasm');
const NNUE_OUT = path.join(OUT_DIR, 'pikafish_nnue.nnue');

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
 * 【Worker 与页面共用的取字节实现】
 * 页面侧（WebView）承载在 file://（不透明源）下，fetch 的 credentials 语义
 * 在该环境下没有可靠契约，所以取字节一律"fetch 为主、XHR 兜底"，详见下方
 * HTML_BODY 侧同名函数的完整说明。本 Worker 只在 Web 端以 http(s) 运行。
 */
function fetchBytes(url) {
  return fetch(url)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.arrayBuffer();
    })
    .catch(function (err) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function () {
          if (xhr.response && xhr.response.byteLength) resolve(xhr.response);
          else reject(new Error('XHR returned no bytes for ' + url +
            ' (fetch: ' + (err && err.message ? err.message : err) + ')'));
        };
        xhr.onerror = function () {
          reject(new Error('XHR failed for ' + url +
            ' (fetch: ' + (err && err.message ? err.message : err) + ')'));
        };
        try { xhr.send(); } catch (e) { reject(e); }
      });
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
 * 由 client/scripts/gen-pikafish-host.mjs 生成（与 pikafish_worker.bin 共享同一份 UCI 逻辑）。
 *
 * ⚠️ 原生端离线引擎页：**小页面 + 外部二进制**（不再内联 base64）。
 *
 *   历史上这里内联了 wasm + NNUE 的 base64（约 6.05 MiB 的单文件）。在真机上
 *   代价很大（见 gen 脚本头部与 CLIENT-PIKAFISH-OFFLINE.md）：WebView 要解析
 *   6MB 巨型字面量、再 atob 出 4.4MB 二进制，低端机内存峰值高、易被系统
 *   OOM 杀掉渲染进程。现在改为与 Worker 同构的「小页面 + fetch 两个二进制」，
 *   页面本身降到 ~200KB 量级，行为与 Web 端完全一致。
 *
 *   ⚠️ 【2026-10 真机修复】本页在原生端由 file:// 加载，origin 是 **null**
 *   （opaque origin），不是可用的同源 origin。此前 fetchBytes 用
 *   fetch(url, {credentials:'same-origin'}) 取二进制，在 opaque origin 下
 *   被 Chromium 判为跨源并拒绝，wasm/nnue 永远拉不到 —— 引擎启动必然失败。
 *   现已按协议分派：file:// 走 XHR（见 fetchBytes），http(s) 走 fetch。
 *
 *   若拿不到 URL（bootstrap 没带），会显式报 error 而不是静默挂起。
 *
 * 协议与 pikafish_worker.bin 完全一致。
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

var DATA_SIZE = ${dataBuf.length};
var WASM_BYTES = null;
var DATA_BYTES = null;

/**
 * 拉取一个二进制资源。
 *
 * 【2026-10 真机修复 · 回归根因】
 * 引擎页曾为"减小体积"把 wasm/nnue 改成运行时 fetch 取。原生端页面由
 * file:// 承载（origin 为 file://，在 Chromium 里是不透明源），**fetch 在
 * 不透明源下的行为没有可靠契约**：credentials:'same-origin' 直接不可用，
 * 而带不带 credentials 又因 WebView 版本而异 —— 结果 wasm/nnue 取不到，
 * bootstrap 失败，UI 永远停在"引擎启动中"。
 *
 * 修法不是赌某一条路可用，而是**两条路互为兜底**：
 *   先试 fetch（http(s) 与多数 WebView 的正常路径），失败/拿不到字节再走 XHR
 *   （file:// 下唯一稳定可用的通道）。任一条成功即返回，两条都失败才 reject。
 * 这样无论设备上 fetch 与 XHR 各自是否被允许，引擎都能启动。
 * 注意不要再给 fetch 传 credentials:'same-origin'——不透明源下它是无效甚至有害的。
 */
function fetchBytes(url) {
  return fetch(url)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.arrayBuffer();
    })
    .catch(function (err) {
      // 落到这里可能是网络错，也可能是 file:// 下 fetch 被拒；都用 XHR 再试一次。
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function () {
          // file:// 下 status 恒为 0，不能用 res.ok 判成败，只看有没有字节。
          if (xhr.response && xhr.response.byteLength) resolve(xhr.response);
          else reject(new Error('XHR returned no bytes for ' + url +
            ' (fetch: ' + (err && err.message ? err.message : err) + ')'));
        };
        xhr.onerror = function () {
          reject(new Error('XHR failed for ' + url +
            ' (fetch: ' + (err && err.message ? err.message : err) + ')'));
        };
        try { xhr.send(); } catch (e) { reject(e); }
      });
    });
}

/** 并行拉取 wasm 与 nnue；任一失败都让 bootstrap 失败（由上层退避重试） */
function loadBinaries(wasmUrl, nnueUrl) {
  return Promise.all([fetchBytes(wasmUrl), fetchBytes(nnueUrl)]).then(function (bufs) {
    WASM_BYTES = new Uint8Array(bufs[0]);
    DATA_BYTES = new Uint8Array(bufs[1]);
    if (DATA_BYTES.length !== DATA_SIZE) {
      throw new Error('pikafish.nnue size mismatch: ' + DATA_BYTES.length + ' != ' + DATA_SIZE);
    }
  });
}

var fsStub = { readFile: function (p, cb) { cb(new Error('fs unavailable: ' + p)); } };
function req(name) { if (name === 'fs') return fsStub; throw new Error('unexpected require: ' + name); }
var mod = { exports: {} };

(function (require, module, exports, __dirname) {
${loaderSrc}
})(req, mod, mod.exports, '/pikafish');

var factory = mod.exports;

function createEngine(onOutput) {
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

window.addEventListener('message', function (ev) {
  var msg = ev && ev.data;
  if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
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
/**
 * 清理历史遗留的旧命名产物。
 *
 * ⚠️ 这一步不是"顺手删"，而是防止旧文件继续被打进 res/raw：
 *   · `pikafish.wasm` / `pikafish.nnue` / `pikafish.worker.bin` —— 与现行产物
 *     同 stem 撞 AAPT 资源名 → Duplicate resources，Gradle 构建失败；
 *   · `pikafish.page` —— 2026-10 真机故障的旧名：expo-asset 复制进 cache 保留
 *     .page 扩展名，WebView 按 text/plain 渲染、脚本不执行（见文件头说明）。
 *   不清理的话新产物即使生成了，旧的坑文件也还在包里。
 */
for (const stale of [
  'pikafish.page',
  'pikafish.wasm',
  'pikafish.nnue',
  'pikafish.worker.bin',
]) {
  const stalePath = path.join(OUT_DIR, stale);
  if (fs.existsSync(stalePath)) {
    fs.rmSync(stalePath);
    console.log(`[gen-pikafish-host] 已清理旧命名产物 ${stale}`);
  }
}
fs.writeFileSync(WORKER_OUT, WORKER_BODY, 'utf8');
fs.writeFileSync(HTML_OUT, HTML_BODY, 'utf8');
// Web 端 Worker 直接 fetch 这两个二进制（不再 base64 内联）
fs.copyFileSync(wasmPath, WASM_OUT);
fs.copyFileSync(dataPath, NNUE_OUT);

const ws = fs.statSync(WORKER_OUT).size;
const hs = fs.statSync(HTML_OUT).size;
console.log('[gen-pikafish-host] 已生成：');
console.log(`  ${path.relative(clientRoot, WORKER_OUT)}  ${ws} B (${(ws / 1048576).toFixed(2)} MiB)  ← Web Worker（小）`);
console.log(`  ${path.relative(clientRoot, HTML_OUT)}  ${hs} B (${(hs / 1048576).toFixed(2)} MiB)  ← 原生 WebView（小页面 + fetch 二进制）`);
console.log(`  ${path.relative(clientRoot, WASM_OUT)}  ${wasmBuf.length} B`);
console.log(`  ${path.relative(clientRoot, NNUE_OUT)}  ${dataBuf.length} B`);
console.log('  两端首启需传：' + ((ws + wasmBuf.length + dataBuf.length) / 1048576).toFixed(2) + ' MiB' +
  `（页面本身 ${(hs / 1048576).toFixed(2)} MiB，二进制与 Worker 共用同一对文件）`);
console.log(`  wasm sha256 : ${wasmSha}`);
console.log(`  data sha256 : ${dataSha}`);
