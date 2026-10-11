/**
 * 揭棋引擎宿主 —— 把 WASM 的「一次性批量 UCI 会话」包成可调用接口
 *
 * ============================================================================
 * 【⚠️ 架构约束（实测得出，务必先读）】
 *
 * 我们编译的 `jieqi.wasm` 使用**标准 Emscripten IO 契约**：
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
  const asset = require('../../../assets/engines/jieqi.worker.bin');
  return normalizeAssetUrl(asset, '揭棋 Worker 资源（assets/engines/jieqi.worker.bin）');
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
  const asset = require('../../../assets/engines/jieqi.wasm');
  return normalizeAssetUrl(asset, '揭棋引擎二进制（assets/engines/jieqi.wasm）');
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

/** 产物是否齐备（缺任一产物时上层应直接降级到 TS AI，而不是报错） */
export function isJieqiHostAvailable(): boolean {
  try {
    resolveWorkerUrl();
    resolveWasmUrl();
    return true;
  } catch {
    return false;
  }
}

/**
 * 跑一次揭棋 UCI 会话。
 *
 * @param commands  完整命令序列（最后应含 `quit`）
 * @param timeoutMs 墙钟上限
 */
export async function runJieqiSession(
  commands: string[],
  timeoutMs: number
): Promise<JieqiSessionResult> {
  if (typeof Worker === 'undefined') {
    throw new Error('当前环境不支持 Web Worker，无法运行揭棋引擎');
  }
  return runSessionInWorker(
    getJieqiWorkerUrl(),
    getJieqiWasmUrl(),
    commands,
    timeoutMs
  );
}
