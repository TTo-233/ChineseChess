/**
 * 生成揭棋引擎宿主产物（两套宿主，共享同一份引擎核心语义）
 *
 *   assets/engines/jieqi_worker.bin → Web 端 Dedicated Worker（classic worker）
 *   assets/engines/jieqi_wasm.wasm  → Web 端 Worker 经同源 URL fetch 的 wasm
 *   assets/engines/jieqi.html       → Android/iOS WebView 离线自包含页
 *
 * ============================================================================
 * 【为什么原生端必须另做一个 HTML 产物，而不是复用 Worker 产物】
 *
 * Hermes 不支持 WebAssembly，原生端跑不了 Worker 里的引擎。先例是皮卡鱼：
 * assets/engines/pikafish.html 把 loader + base64 内联的 wasm/nnue 全塞进一个离线页，
 * 由屏幕外 WebView 以 inline HTML 加载（详见 gen-pikafish-host.mjs）。
 * 揭棋此前**只有** Worker 产物，于是原生端根本没有 AI 可用 —— 本脚本补上这一环。
 *
 * ============================================================================
 * 【模型：一次性批量 UCI 会话】
 *
 * `jieqi.wasm` 用标准 Emscripten IO（stdin 喂命令 / print 收输出），而 `main()`
 * 进入的 `UCI::loop()` 是**同步阻塞**的：整段命令一次性喂进去，跑完才返回。
 * 实测一次 `uci/isready/position/go depth 4/quit` 实例化 + 搜索 ≈ 80ms。
 *
 * ⇒ 宿主收到的不是"逐条命令"，而是**一整段命令序列**：
 *     { type: 'session', commands: [...] }
 * 跑完整段后回 `{ type: 'done', lines: [...] }`。
 *
 * 详见 utils/chess/pikafish/jieqiHost.ts 顶部的架构约束说明。
 *
 * ⚠️ 因此 HTML 侧**必须可重复调用**：每次 session 都重新实例化一个 glue 实例，
 *    没有可复用的常驻实例（这一点与 pikafish.html 的长驻引擎不同）。
 *
 * ============================================================================
 * 【worker 产物后缀必须是 .bin（不是 .js）】
 *
 * `.js` 属 Metro sourceExts，会被 Babel 逐字符转译内联的 base64（~384KB），
 * 启动极慢、内存峰值高且不报错。`.bin` 已登记进 metro.config.js 的 assetExts，
 * 按原字节透传。它只是给 `new Worker(url)` 用的 URL，浏览器不关心后缀。
 *
 * ⚠️ 产物文件名的 **stem 必须彼此不同**（2026-10 Android 构建阻塞修复）：
 *    本目录产物会被 Metro 一起打进 Android `res/raw/`，而 AAPT 以
 *    「**去掉最后一个扩展名**的相对路径」作资源名，stem 相同的两个文件会压成
 *    同一个 raw 资源 → Duplicate resources，构建在 mergeReleaseResources 失败
 *    （实测过）。
 *    ⚠️ 改扩展名**没用**（被剥离的是最后一个点之后的任意后缀），
 *       必须改扩展名之前的那一段。故命名统一为 jieqi_worker.bin / jieqi_wasm.wasm / jieqi.html。
 *    （页面曾因此命名成 jieqi.page——但 expo-asset 复制进 cache 保留 .page 扩展名，
 *    WebView 按 text/plain 渲染、脚本不执行，见 HTML_OUT 的说明，已回 .html。）
 *    该约束由 client/scripts/verify-asset-resource-names.mjs 常态校验。
 *
 * ============================================================================
 * 【为什么 wasm 在两个产物里的处理方式相反】
 *
 * · jieqi.worker.bin —— wasm **不内联**，作为独立同源资源由 Metro 提供。
 *   实测（headless Chrome）Worker 内 fetch(data:) 不可靠：blob: 来源的 Worker
 *   直接 "Failed to fetch"；同源 Worker 虽能取回字节，但 instantiateStreaming 会因
 *   data: 响应被物化为文本而报 "expected magic word 00 61 73 6d, found \"Asse\""。
 *   这正是 glue 原生支持的路径（fetch + instantiateStreaming），运行时传 URL 进来。
 *
 * · jieqi.html —— wasm **内联 base64**。原生 WebView 以 file:// 缓存文件承载时
 *   没有可用的同源 origin，fetch 兄弟资源会被跨源/CORS 挡住，内联是唯一稳妥选择。
 *   （与 gen-pikafish-host.mjs 的 HTML 产物同一条理由。）
 *
 * ============================================================================
 * 【关键运行时事实：jieqi.js 这版 glue 没有 instantiateWasm】
 *
 * ⚠️ 与 Pikafish 的 loader 不同，这版 glue（engine-source/jieqi/jieqi.js）里
 *    **根本没有** `instantiateWasm` 这个钩子（实测 grep 计数 = 0），
 *    也没有 `getPreloadedPackage`。它只有一套固定加载链：
 *
 *      findWasmBinary() -> locateFile("jieqi_r.wasm")
 *        -> instantiateAsync(wasmBinary, file, imports)
 *             ├─ 首选 instantiateStreaming(fetch(file, {credentials:'same-origin'}))
 *             └─ 失败则 instantiateArrayBuffer -> getWasmBinary(file)
 *                                            -> readAsync(file) -> fetch(...).arrayBuffer()
 *                                            -> WebAssembly.instantiate(bytes, imports)
 *
 *    且 `wasmBinary` 是一个**闭包局部变量**，从未从 `Module` 读取
 *    （实测 `Module["wasmBinary"]` 出现次数 = 0），因此**无法**从外部直接注入字节。
 *
 * ⇒ 唯一可行的注入点是 **`locateFile` + 在页面里接管 `fetch`**：
 *    locateFile 返回一个哨兵 URL，我们替换 window.fetch，
 *    只对哨兵 URL 返回内联的 ArrayBuffer，其余请求照常放行。
 *
 *    这不是权宜之计，而是这条链路的原生形态：glue 本来就用 fetch 取字节。
 *
 * ⚠️ **绝不能设 `noInitialRun`**：glue 的 run() 靠 callMain() 驱动 UCI::loop()。
 *    设了 noInitialRun 后 run() 跳过 callMain，而 initRuntime() 已经建好 stdin 设备，
 *    手动调 mod._main() 会看到 EOF 直接退出 —— 实测一条命令都不执行。
 *
 * ⚠️ **stdin 必须能一次性喂完整段并返回 null 表示 EOF**：UCI::loop() 靠 stdin 读到
 *    null（EOF）才退出；stdinFn 被 EM_ASYNC_JS 回调数十次（一次 6 命令会话约 147 次），
 *    每次返回一个字节码，最后返回 null 结束。一次性喂完即可，无需异步。
 *
 * ============================================================================
 * 【页面协议】
 *
 *   out: { type: 'host-loaded' }
 *        { type: 'done',  banner, lines }
 *        { type: 'error', message }
 *   in : { type: 'session', commands: string[] }
 *        { type: 'dispose' }
 *
 * ============================================================================
 * 【worker 核心为什么放在独立文件】
 *
 * worker 核心代码里含有大量反引号与 `${}` 形态的注释（说明 Emscripten 内部
 * 变量名）。若把它内联在本文件的模板字符串里，任何一个反引号都会提前终止模板
 * （实测反复踩坑）。故核心代码放在 `worker-core.js`，此处只做**读取与拼接**。
 *
 * 用法：node client/scripts/gen-jieqi-host.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');

const SRC_DIR = path.join(clientRoot, 'engine-source', 'jieqi');
const OUT_DIR = path.join(clientRoot, 'assets', 'engines');
/**
 * ⚠️ 每个产物文件名在「扩展名之前」的部分（stem）必须彼此不同，
 *    否则 Android 构建会失败（2026-10 真实踩过，用户实测 Run gradlew 报错）：
 *
 * AAPT 以「**去掉最后一个扩展名**的相对路径」生成 raw 资源名，于是
 *   jieqi_wasm.wasm  → raw/assets_engines_jieqi_wasm
 *   jieqi.html       → raw/assets_engines_jieqi
 *   jieqi_worker.bin → raw/assets_engines_jieqi_worker
 *
 * ⚠️ 关键：**改扩展名无效**。被剥离的是"最后一个点之后的任意后缀"，
 *    与后缀是什么无关——当年 `jieqi.wasm` 与页面同 stem（jieqi）才是撞名根源，
 *    改 wasm 的 stem（jieqi_wasm）才是正解，页面扩展名与此无关。
 *    （页面一度改成 jieqi.page 规避，结果踩上 expo-asset 保留扩展名 +
 *    WebView 按扩展名定 Content-Type 的坑，见 HTML_OUT 说明，已回 .html。）
 *
 * 该约束由 client/scripts/verify-asset-resource-names.mjs 常态校验（已进 pnpm -w validate）。
 */
const WORKER_OUT = path.join(OUT_DIR, 'jieqi_worker.bin');
/**
 * 原生端离线页（wasm 以 base64 内联，单文件自包含）。
 *
 * ⚠️ 扩展名必须是 .html，绝不能用 .page（2026-10 真机实锤）：
 * expo-asset 把 res/raw 资源复制进应用 cache 时**原样保留扩展名**，而 WebView
 * 以 `file://…/ExponentAsset-<hash>.<ext>` 导航时**按扩展名**决定 Content-Type：
 * `.page` 无注册 MIME → text/plain → 整页进 <pre>、0 个 <script> 执行 →
 * host-loaded 永不到来 → 揭棋永远「基础AI」。（PTP-AN10 真机 CDP 实测。）
 * 曾用 .page 是因为旧产物 jieqi.wasm 与页面同 stem（jieqi）撞 AAPT 资源名；
 * 现 wasm 已改名 jieqi_wasm.wasm，stem 互异，页面安全回 .html。
 */
const HTML_OUT = path.join(OUT_DIR, 'jieqi.html');
const WASM_OUT = path.join(OUT_DIR, 'jieqi_wasm.wasm');

const gluePath = path.join(SRC_DIR, 'jieqi.js');
const wasmPath = path.join(SRC_DIR, 'jieqi.wasm');
const corePath = path.join(SRC_DIR, 'worker-core.js');

for (const p of [gluePath, wasmPath, corePath]) {
  if (!fs.existsSync(p)) {
    console.error('[gen-jieqi-host] missing file: ' + p);
    console.error('Build the engine first (see engine-source/jieqi/README.md)');
    process.exit(1);
  }
}

const glue = fs.readFileSync(gluePath, 'utf8');
const wasm = fs.readFileSync(wasmPath);
const core = fs.readFileSync(corePath, 'utf8');
const wasmB64 = wasm.toString('base64');
const wasmSha = crypto.createHash('sha256').update(wasm).digest('hex');

/**
 * 守卫：glue 的形态若变化（工厂改名 / 突然多出 instantiateWasm / 换成依赖 fs 的构建），
 * 产物就会静默跑不起来。这里把已实测的关键事实固化成断言，生成期就失败。
 */
function assertGlueShape(where) {
  const fail = (msg) => {
    console.error(`[gen-jieqi-host] ${where}: ${msg}`);
    process.exit(1);
  };
  if (!glue.includes('var PikaJieqi=')) {
    fail('glue 不再以 `var PikaJieqi=` 导出工厂（宿主侧取不到该标识符）');
  }
  if (!glue.includes('Module["locateFile"]')) {
    fail('glue 不再读取 Module["locateFile"]，内联 wasm 的注入点失效');
  }
  if (!glue.includes('Module["stdin"]')) {
    fail('glue 不再读取 Module["stdin"]，stdin 注入点失效');
  }
  if (!glue.includes('instantiateStreaming')) {
    fail('glue 不再使用 instantiateStreaming，接管 fetch 的注入方案需重新评估');
  }
  // 这版 glue 没有 instantiateWasm 钩子；若将来换成了带钩子的构建，
  // 页面侧仍可工作（locateFile+fetch 兜底），但注释与注入点需同步更新。
  const hasHook = glue.includes('instantiateWasm');
  return hasHook;
}
const glueHasInstantiateWasmHook = assertGlueShape('jieqi.js');

if (core.includes('</scr' + 'ipt>')) {
  console.error('[gen-jieqi-host] worker-core.js must not contain a script-closing tag');
  process.exit(1);
}

/**
 * 拼接 Worker 产物：IIFE 包裹，内联 worker 核心 + Emscripten glue。
 * ⚠️ wasm **不内联**（理由见文件头），运行时经 postMessage 传同源 URL。
 */
const workerParts = [
  '/* jieqi.worker.bin - generated by gen-jieqi-host.mjs, do not edit */',
  '/* wasm asset: jieqi.wasm (' + wasm.length + ' B, sha256 ' + wasmSha + ') */',
  '/* engine license: GPLv3 (see engine-source/jieqi/README.md) */',
  '(function () {',
  '/* ---- Emscripten glue (jieqi.js, inlined) ---- */',
  glue,
  '/* ---- worker core (worker-core.js, inlined) ---- */',
  core,
  '})();',
  '',
].join('\n');

/**
 * ============================================================================
 * 【为什么页面侧逻辑不在 TS 里，而是内联进 HTML】
 *
 * 与 gen-pikafish-host.mjs 同理：原生 WebView 以**单文件 inline HTML** 加载，
 * 离线场景下不能再向 Metro 请求任何分片。若把 UCI 逻辑写成 TS 模块，WebView 侧
 * 就要额外注入 bundle 胶水，且 Web 端与 WebView 端很容易各打各的、悄悄漂移。
 *
 * 页面侧与 Worker 侧共享**同一套语义**（banner/option 收集、逐行解析、EOF 收尾），
 * 但注入方式不同：Worker 有真实同源 origin，走 fetch + instantiateStreaming；
 * 页面没有可用 origin，改走"内联字节 + 接管 fetch"。
 * ============================================================================
 */
const HTML_BODY = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>Jieqi Host</title>
</head>
<body>
<script>
/**
 * GENERATED FILE — DO NOT EDIT.
 * 由 client/scripts/gen-jieqi-host.mjs 生成。
 *   glue : client/engine-source/jieqi/jieqi.js
 *   wasm : client/engine-source/jieqi/jieqi.wasm  (${wasm.length} B, sha256 ${wasmSha})
 *
 * 揭棋引擎页（原生 WebView 离线自包含版）：不发任何网络请求，glue + wasm 全部内联。
 * 协议见 gen-jieqi-host.mjs 文件头；语义与 jieqi.worker.bin 一致。
 *
 * 揭棋引擎：GPLv3（源二进制见 client/engine-source/jieqi/README.md）。
 * 本项目仅内部娱乐使用。
 */
'use strict';

var send = function (msg) {
  if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
};

/** base64 -> Uint8Array（分块 atob，避免一次性拼 500KB 字符串导致峰值内存翻倍） */
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
var WASM_SIZE = ${wasm.length};
var WASM_BYTES = null;

/**
 * ============================================================================
 * 【为什么必须接管 fetch —— 这版 glue 没有 instantiateWasm 钩子】
 *
 * jieqi.js 的加载链（实测 grep）里没有 \`instantiateWasm\`，\`wasmBinary\` 又是闭包
 * 局部变量、从不由 Module 读取 ⇒ 字节无法从外部直接塞进去。
 * glue 的原生取字节路径是：
 *     locateFile("jieqi_r.wasm") -> fetch(..., {credentials:'same-origin'})
 *                                  -> WebAssembly.instantiateStreaming / instantiate
 * 所以这里让 locateFile 返回一个**哨兵 URL**，并接管 window.fetch：
 * 命中哨兵就返回内联字节，其余请求原样放行（不干扰页面里任何其它请求）。
 * ============================================================================
 */
var INLINE_WASM_URL = 'jieqi-inline-wasm://jieqi_r.wasm';
var origFetch = null;

function installFetchHook() {
  if (origFetch !== null) return;
  origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || String(input);
    } catch (e) { url = ''; }
    if (url === INLINE_WASM_URL) {
      if (!WASM_BYTES) WASM_BYTES = b64ToBytes(WASM_B64);
      if (WASM_BYTES.length !== WASM_SIZE) {
        return Promise.reject(new Error('jieqi.wasm size mismatch: ' + WASM_BYTES.length));
      }
      /* 复制一份 buffer：glue 会把它交给 instantiateStreaming，
         而 ArrayBuffer 被 transfer/detach 后第二次用就会炸。 */
      var copy = WASM_BYTES.slice().buffer;
      return Promise.resolve({
        ok: true,
        url: url,
        status: 200,
        clone: function () { return this; },
        arrayBuffer: function () { return Promise.resolve(copy.slice(0)); }
      });
    }
    if (!origFetch) return Promise.reject(new Error('fetch unavailable for ' + url));
    return origFetch(input, init);
  };
}

if (typeof WebAssembly !== 'undefined' && WebAssembly.instantiateStreaming) {
  /**
   * 让 instantiateStreaming 对我们的哨兵响应**优雅降级**为 ArrayBuffer 实例化。
   *
   * glue 首选 instantiateStreaming，但它要求一个**真正的** Response（内部会
   * 调 Response 的 body 流）。内联字节无法提供真实的流，只能自己桥接：
   * 这里用 \`new Response(bytes, {headers:{'content-type':'application/wasm'}})\`
   * 造一个真的 Response 交给 WebAssembly，桥接成功就用流式编译（更快），
   * 失败则原样抛出，让 glue 自己 fallback 到 instantiateArrayBuffer。
   */
  var origStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly);
  WebAssembly.instantiateStreaming = function (source, importObject) {
    var p = Promise.resolve(source).then(function (resp) {
      if (resp && resp.__jieqiInlineWasm) {
        var bytes = WASM_BYTES.slice().buffer;
        return new Response(bytes, { headers: { 'content-type': 'application/wasm' } });
      }
      return resp;
    });
    return origStreaming(p, importObject);
  };
}

/* glue 里的 \`require("node:fs")\` 只在 ENVIRONMENT_IS_NODE 时求值；
   页面里 window 存在 → 走不到。但仍给出**永不被调用**的替身，
   与 gen-pikafish-host.mjs 保持同一套写法，避免任何意外 require 直接 ReferenceError。 */
var fsStub = { readFile: function (p, cb) { cb(new Error('fs unavailable: ' + p)); } };
function req(name) { if (name === 'fs') return fsStub; throw new Error('unexpected require: ' + name); }
var mod = { exports: {} };

(function (require, module, exports, __dirname) {
${glue}
})(req, mod, mod.exports, '/jieqi');

var factory = mod.exports;

/**
 * 跑一次完整 UCI 会话（one-shot）。
 *
 * ⚠️ 引擎是**一次性**的：UCI::loop() 阻塞到 stdin EOF 才返回，之后这个实例不可复用。
 *    所以每次 session 都新建一个 factory 实例（实测 ≈80ms，可接受）。
 *
 * ⚠️ 绝不设 noInitialRun：glue 的 run() 靠 callMain() 驱动 UCI::loop()。
 * ⚠️ stdin 一次性喂完整段 + 返回 null（EOF）→ UCI loop 正常收尾退出。
 */
function runSession(commands, done) {
  var stdinText = commands.join('\\n') + '\\n';
  var stdinPos = 0;
  var lines = [];
  var banner = '';
  var options = [];

  function stdinFn() {
    if (stdinPos >= stdinText.length) return null; /* EOF -> UCI loop exits */
    return stdinText.charCodeAt(stdinPos++);
  }

  function emit(line) {
    var l = String(line).trim();
    if (!l) return;
    if (l.indexOf('id name ') === 0) { banner = l.slice(8).trim(); return; }
    if (l.indexOf('option name ') === 0) {
      var m = /^option name (\\S+)/.exec(l);
      if (m) options.push(m[1]);
      return;
    }
    lines.push(l);
  }

  function printFn(t) {
    var parts = String(t).split('\\n');
    for (var i = 0; i < parts.length; i++) emit(parts[i]);
  }

  try {
    var ready = factory({
      print: printFn,
      printErr: printFn,
      locateFile: function (f) {
        if (/\\.wasm(\\?|#|$)/i.test(String(f || ''))) return INLINE_WASM_URL;
        return f;
      },
      stdin: stdinFn,
    });
    Promise.resolve(ready).then(function () {
      /* glue 已跑完 callMain()，整段命令处理完毕，输出全部落定。 */
      done(null, { banner: banner, lines: lines, options: options });
    }, function (e) {
      /* 即使 reject，引擎输出也已收集到 —— 优先把已有输出带回去，
         上层仍可能从 bestmove 里拿到结果（与 Worker 版的处理一致）。 */
      var hasBest = lines.some(function (l) { return l.indexOf('bestmove ') === 0; });
      if (hasBest) {
        done(null, { banner: banner, lines: lines, options: options });
      } else {
        done(new Error('engine init failed: ' + ((e && e.message) || e)));
      }
    });
  } catch (e) {
    done(new Error('engine threw: ' + ((e && e.message) || e)));
  }
}

var busy = false;

window.addEventListener('message', function (ev) {
  var msg = ev && ev.data;
  if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (e) { return; } }
  if (!msg || !msg.type) return;
  try {
    if (msg.type === 'session') {
      if (busy) { send({ type: 'error', message: 'engine busy' }); return; }
      busy = true;
      installFetchHook();
      runSession(msg.commands || [], function (err, out) {
        busy = false;
        if (err) { send({ type: 'error', message: err.message || String(err) }); return; }
        send({ type: 'done', banner: out.banner, lines: out.lines });
      });
      return;
    }
    if (msg.type === 'dispose') {
      /* one-shot 引擎无长驻实例可释放；此处只解除 fetch 接管并复位状态。 */
      if (origFetch !== null) { window.fetch = origFetch; origFetch = null; }
      WASM_BYTES = null;
      busy = false;
      return;
    }
  } catch (err) {
    busy = false;
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
 * ⚠️ 旧文件若留在 assets/engines/ 里会继续被打进 res/raw：
 *   · `jieqi.wasm` / `jieqi.worker.bin` —— 与现行产物同 stem 撞 AAPT 资源名
 *     → Duplicate resources，Gradle 构建失败；
 *   · `jieqi.page` —— 2026-10 真机故障的旧名：expo-asset 复制进 cache 保留
 *     .page 扩展名，WebView 按 text/plain 渲染、脚本不执行（见 HTML_OUT 说明）。
 */
for (const stale of ['jieqi.page', 'jieqi.wasm', 'jieqi.worker.bin']) {
  const stalePath = path.join(OUT_DIR, stale);
  if (fs.existsSync(stalePath)) {
    fs.rmSync(stalePath);
    console.log('[gen-jieqi-host] 已清理旧命名产物 ' + stale);
  }
}
fs.writeFileSync(WORKER_OUT, workerParts, 'utf8');
fs.writeFileSync(HTML_OUT, HTML_BODY, 'utf8');
// wasm 复制到 assets/engines 供 Metro 以同源资源提供（Content-Type: application/wasm）
fs.copyFileSync(wasmPath, WASM_OUT);

const ws = fs.statSync(WORKER_OUT).size;
const hs = fs.statSync(HTML_OUT).size;
console.log('[gen-jieqi-host] generated:');
console.log(`  ${path.relative(clientRoot, WORKER_OUT)}  ${ws} B`);
console.log(`  ${path.relative(clientRoot, HTML_OUT)}  ${hs} B (${(hs / 1048576).toFixed(2)} MiB)  <- WebView (inlined)`);
console.log(`  ${path.relative(clientRoot, WASM_OUT)}  ${wasm.length} B (sha256 ${wasmSha.slice(0, 16)}...)`);
console.log('  model: one-shot batch UCI session (see jieqiHost.ts)');
console.log('  NOTE: worker.bin serves wasm as a separate same-origin asset; jieqi.html inlines it.');
if (glueHasInstantiateWasmHook) {
  console.log('  NOTE: glue now exposes instantiateWasm — the fetch hook is still correct but redundant.');
}