/**
 * 揭棋引擎宿主 —— 把 WASM 的「一次性批量 UCI 会话」包成可调用接口
 *
 * ============================================================================
 * 【⚠️ 架构约束（实测得出，务必先读）】
 *
 * 我们编译的 `jieqi_wasm.wasm` 使用**标准 Emscripten IO 契约**：
 *   · 命令 → `stdin` 回调
 *   · 输出 → `print` / `printErr` 回调
 *   · `main()` → 进入 `UCI::loop()`，**同步阻塞**地 getline(cin) 直到 EOF
 *
 * 实测（engine-source/jieqi/probe-sync.cjs）：初始化期一次性喂入
 * `uci / isready / quit`，引擎在 **84ms** 内跑完全部交互并返回。
 *
 * ⇒ **这与象棋引擎的「常驻可交互」模型不同**：
 *    · 象棋：worker 里 `send_command()` 逐条下发，能在搜索中途 `stop`；
 *    · 揭棋：**一次搜索 = 一个完整的 WASM 实例生命周期**。
 *
 * 因此本模块的模型是：
 *   `searchOnce(commands) → 启动实例 → 喂完整命令序列 → 收集输出 → 实例结束`
 *
 * 代价与取舍：
 *   · 每次搜索都要重新实例化 WASM（约 80ms，P0 实测），可接受；
 *   · **无法中途抢占**（`stop` 不可用）——与象棋同款限制
 *     （象棋也是同步阻塞，靠 depth+movetime 保证有界，见 CLIENT-PIKAFISH-OFFLINE.md:86-88）；
 *   · 不能复用实例做 ponder。
 *
 * 🔑 若未来需要「常驻 + 可抢占」，需**重新编译引擎**并把 `UCI::loop()`
 *    改成事件驱动（暴露 `wasm_uci_execute` 之类），工作量约 1 人日。
 *    当前版本不实现，理由见 README「已知限制」。
 *
 * ============================================================================
 */

import { Platform } from 'react-native';

import type { EngineHostSource } from './engineTransport';
import { resolveNativeAssetUri } from './nativeAsset';
import {
  runSessionInWebView,
  supportsJieqiWebView,
} from './jieqiWebViewBridge';

export interface JieqiSessionResult {
  lines: string[];
  banner: string;
  options: string[];
}

/**
 * 在 Web 端用 Worker 跑一次性会话。
 *
 * Worker 产物由 `client/scripts/gen-jieqi-host.mjs` 生成（自包含，含 base64 wasm）。
 */
function runSessionInWorker(
  workerUrl: string,
  wasmUrl: string,
  commands: string[],
  timeoutMs: number
): Promise<JieqiSessionResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl);
    } catch (err) {
      reject(new Error(`创建揭棋 Worker 失败: ${(err as Error).message}`));
      return;
    }

    const lines: string[] = [];
    let banner = '';
    const options: string[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new Error(`揭棋引擎会话超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve({ lines, banner, options });
    };

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data || {};
      if (msg.type === 'line') {
        if (typeof msg.line === 'string') lines.push(msg.line);
      } else if (msg.type === 'done') {
        // banner / options 随 done 一起回来（worker 在结束时汇总）
        if (typeof msg.banner === 'string' && msg.banner) banner = msg.banner;
        if (Array.isArray(msg.options)) options.push(...msg.options);
        if (Array.isArray(msg.lines)) {
          for (const l of msg.lines) if (typeof l === 'string') lines.push(l);
        }
        finish();
      } else if (msg.type === 'error') {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(String(msg.message ?? '揭棋引擎错误')));
        }
      }
    };

    worker.onerror = (ev: ErrorEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(`揭棋 Worker 异常: ${ev.message}`));
    };

    // wasmUrl 必须传给 worker：它把该 URL 交回 glue 的 locateFile，
    // 由 glue 用 fetch + instantiateStreaming 加载（见 worker-core.js 顶部说明）。
    worker.postMessage({ type: 'session', commands, wasmUrl });
  });
}

/** 解析 Worker URL（惰性 require，理由同 pikafish/index.ts） */
function resolveWorkerUrl(): string {
  // ⚠️ require 的参数必须是**静态字符串字面量**：Metro 在打包期做静态分析，
  // 写成 `require(variable)` 会直接抛 TransformError（
  // "Invalid call ... require(modulePath)"），导致**整个 bundle 编译失败**、
  // 应用回退到旧 bundle —— 表现为揭棋静默走 TS AI 兜底（踩过）。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asset = require('../../../assets/engines/jieqi_worker.bin');
  return normalizeAssetUrl(asset, '揭棋 Worker 资源（assets/engines/jieqi_worker.bin）');
}

/**
 * 解析 wasm 资源 URL。
 *
 * ⚠️ 必须把 wasm 作为**独立同源资源**提供给引擎，不能内联进 worker：
 * 实测（headless Chrome）——blob: 来源的 Worker 里 `fetch(data:...)` 直接
 * "Failed to fetch"；同源 Worker 里 data: URL 虽能取回字节，但
 * `instantiateStreaming` 会因响应被物化为文本而报
 * `CompileError: expected magic word 00 61 73 6d, found "Asse"`。
 * 只有真正的同源 http(s) 资源（Metro 以 `application/wasm` 提供）才能走通
 * glue 原生的 fetch + instantiateStreaming 路径。
 */
function resolveWasmUrl(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asset = require('../../../assets/engines/jieqi_wasm.wasm');
  return normalizeAssetUrl(asset, '揭棋引擎二进制（assets/engines/jieqi_wasm.wasm）');
}

/**
 * 把 Metro 的资源 require 结果归一化成 URL。
 *
 * 形态因平台而异（与 pikafish/index.ts 的 resolveAssetUri 同源问题）：
 *   · Web    → 字符串 `/assets/?unstable_path=...`
 *   · 原生   → 数字（AssetRegistry id）或 { uri }
 */
function normalizeAssetUrl(asset: unknown, label: string): string {
  if (typeof asset === 'string' && asset.length > 0) return asset;
  if (typeof asset === 'number') {
    const { Image } = require('react-native');
    const r = Image.resolveAssetSource(asset) as { uri?: string } | null;
    if (r?.uri) return r.uri;
  }
  if (asset && typeof asset === 'object') {
    const uri = (asset as { uri?: unknown }).uri;
    if (typeof uri === 'string') return uri;
    const def = (asset as { default?: unknown }).default;
    if (typeof def === 'string') return def;
    if (typeof def === 'number') {
      const { Image } = require('react-native');
      const r = Image.resolveAssetSource(def) as { uri?: string } | null;
      if (r?.uri) return r.uri;
    }
  }
  throw new Error(`无法解析${label}：资源缺失或未登记为资源`);
}

let workerUrlCache: string | null = null;
let wasmUrlCache: string | null = null;

/** 取得（并缓存）揭棋 Worker 的 URL */
export function getJieqiWorkerUrl(): string {
  if (!workerUrlCache) workerUrlCache = resolveWorkerUrl();
  return workerUrlCache;
}

/** 取得（并缓存）揭棋 wasm 的 URL */
export function getJieqiWasmUrl(): string {
  if (!wasmUrlCache) wasmUrlCache = resolveWasmUrl();
  return wasmUrlCache;
}

/**
 * 揭棋引擎页的加载来源（类型定义在 engineTransport，避免循环依赖）
 *
 * ⚠️ 只在文件顶部 `import type` 引入，不做 re-export：
 *    `export type { X } from './y'` 只是转发，本文件内拿不到本地名 X。
 */
export type { EngineHostSource };

/**
 * 惰性 require 揭棋离线页（理由同上面的静态字符串要求）
 *
 * ⚠️ 扩展名必须是 `.html`（2026-10 真机实锤修复，勿回退）：
 * 原生端经 expo-asset 落成 `file://…/ExponentAsset-<hash>.<ext>` 缓存文件后，
 * WebView **按扩展名**决定 Content-Type——`.html` 得 text/html 且脚本执行；
 * 自造扩展名（曾用 .page）得 text/plain、整页进 <pre>、0 个脚本执行，
 * host-loaded 永不到来，揭棋永远「基础AI」（PTP-AN10 CDP 实测）。
 * AAPT 资源名唯一性看 stem（jieqi 与 jieqi_wasm/jieqi_worker 互异），.html 不再撞名。
 */
function requireHtmlAsset(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../../assets/engines/jieqi.html');
}

/**
 * 解析揭棋离线页来源（原生端用）。
 *
 * ⚠️ 与 pikafish/index.ts 的 getEngineHostSource 同构，且**同样必须异步**：
 *   · 产物本身是 HTML 文本 → 直接 `{ html }` 内联；
 *   · 原生端 require 到的是**资源 id** → 必须经 resolveNativeAssetUri 转成
 *     `file://` 本地缓存 URI。用 Image.resolveAssetSource 在打包态会得到
 *     **裸资源名**（无 scheme），WebView 导航静默失败 → 揭棋永远「基础AI」。
 *     这正是 2026-10 实机故障的根因之一。
 *
 * @see ./nativeAsset.ts 的完整根因说明
 */
export async function getJieqiHostSource(): Promise<EngineHostSource> {
  const asset = requireHtmlAsset();
  if (typeof asset === 'string' && asset.trimStart().startsWith('<')) {
    return { html: asset };
  }
  return { uri: await resolveNativeAssetUri(asset, 'jieqi.html', 'html') };
}

/**
 * 产物与承载是否齐备（缺任一产物时上层应直接降级到 TS AI，而不是报错）
 *
 * ============================================================================
 * 【2026-10 三态判定：Worker 或 WebView，任一可用即可】
 *
 * 原实现只认 Worker，并给原生端硬编码 `return false`，于是：
 *   1. 原生端每次都走 TS 兜底，角标显示「基础AI」，揭棋引擎永不参与；
 *   2. 即使补齐了 WebView 产物，也无法表达"原生现在也能用了"。
 *
 * 现在改为按平台各问一次实际能力：
 *   · Web    → Worker 是否存在 + 产物能否解析；
 *   · 原生    → 离线页资源能否解析（承载由根布局挂载，能力即产物）。
 *
 * ⚠️ 这里**只判断"能不能"，不判断"此刻是否就绪"**——就绪与否由
 *   runSessionInWebView 的挂起/超时表达，不由上层预判。
 *
 * ⚠️ 原生端**只能做同步的粗判**：getJieqiHostSource 现在是异步的
 *   （要经 expo-asset 把资源 id 换成 file:// 缓存 URI），Promise 无法在
 *   同步 try/catch 里捕获失败。因此这里退化为「产物能被 require 出来
 *   就认为可用」，真正的失败（URI 解析不出）由 runSessionInWebView 抛出、
 *   走正常降级路径 —— 不要在这里假装能校验出解析结果。
 */
export function isJieqiHostAvailable(): boolean {
  try {
    if (supportsJieqiWebView()) {
      // 原生：WebView 承载。产物缺失/未登记 → require 直接抛，判不可用（诚实降级）。
      // 只验证 require 能成功；URI 解析结果不在同步判定范围内（见上方说明）。
      requireHtmlAsset();
      return true;
    }
    if (typeof Worker === 'undefined') return false;
    resolveWorkerUrl();
    resolveWasmUrl();
    return true;
  } catch {
    return false;
  }
}

/**
 * 跑一次揭棋 UCI 会话（自动按平台选承载：Web → Worker，原生 → WebView）。
 *
 * @param commands  完整命令序列（最后应含 `quit`）
 * @param timeoutMs 墙钟上限
 */
export async function runJieqiSession(
  commands: string[],
  timeoutMs: number
): Promise<JieqiSessionResult> {
  if (supportsJieqiWebView()) {
    // 原生：屏幕外 WebView。命令以 injectJavaScript 下发，
    // 页面把整段喂给一次性实例，跑完回 {type:'done', banner, lines}。
    const res = await runSessionInWebView(commands, timeoutMs);
    if (res.type === 'error') {
      throw new Error(String(res.message ?? '揭棋引擎错误'));
    }
    if (res.type !== 'done') {
      throw new Error(`揭棋引擎返回了非预期消息: ${res.type}`);
    }
    const lines = Array.isArray(res.lines) ? res.lines.filter((l) => typeof l === 'string') : [];
    const banner = typeof res.banner === 'string' ? res.banner : '';
    // 与 Worker 路径保持同一套 option 提取口径（见 runSessionInWorker 的 done 处理）
    const options: string[] = [];
    for (const l of lines) {
      const m = /^option\s+name\s+(\S+)/i.exec(l.trim());
      if (m) options.push(m[1]);
    }
    return { lines, banner, options };
  }

  if (typeof Worker === 'undefined') {
    throw new Error('当前环境既不支持 WebView 承载也不支持 Web Worker，无法运行揭棋引擎');
  }
  return runSessionInWorker(
    getJieqiWorkerUrl(),
    getJieqiWasmUrl(),
    commands,
    timeoutMs
  );
}
