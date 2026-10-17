/**
 * 本地引擎装配（平台无关入口）
 *
 * 对外只暴露一个懒加载单例：调用方拿到的永远是 `OfflineEngineOrchestrator`，
 * 至于底下跑的是 Worker 还是 WebView、还是已经降级到兜底 AI，都不必关心。
 *
 * ============================================================================
 * 【资产解析：两条路径】
 *
 * · Web：`require()` 一个 .js 资产 → 交给 `new Worker(url)`。
 *   metro.config.js 已把 assets/engines 加入 blockList + assetExts，
 *   使这两个 6MB 文件**原样透传**而不进 Babel 管线（否则启动会慢到不可用）。
 * · 原生（Android/iOS）：用 `require()` 拿到 HTML 文本，交给屏幕外 WebView。
 *
 * 两条路径都要求 `pnpm gen:pikafish-host` 已生成 assets/engines 下的产物。
 * 产物缺失时抛出的错误会被编排器捕获 → 自动降级，UI 显示"本地引擎不可用"。
 */

import { Platform } from 'react-native';

import type { OfflineEngine } from '../offlineEngine';
import type { EngineHostSource } from './engineTransport';
import { resolveNativeAssetUri } from './nativeAsset';
import { PikafishOfflineEngine } from './pikafishLocalEngine';
import { LegacyTsEngine } from './legacyTsEngine';
import { OfflineEngineOrchestrator } from './offlineOrchestrator';
import { createWebWorkerTransport } from './webWorkerTransport';
import { createWebViewTransport, supportsWebViewTransport } from './webViewTransport';

// ⚠️ 刻意**不**在这里 re-export PikafishWebViewHost：
// 它依赖 react-native-webview（import 即要求原生模块），而本模块被
// offlineAiAdapter → usePendingAIMove 间接引入，会让纯逻辑单测在 Jest 下抛错。
// 需要该组件的地方（根布局）直接从 './pikafish/webViewHost' 引入。
export type { OfflineEngineStatus, LocalEngineSource } from './offlineOrchestrator';

/**
 * 引擎产物（构建产物，由 client/scripts/gen-pikafish-host.mjs 生成）
 *
 * ⚠️ worker 脚本后缀是 `.bin` 而不是 `.js`：.js 属于 Metro 的 sourceExts，
 * 会被 Babel 转译那两段 5.5MB 的 base64（启动极慢、内存峰值高、且不报错）。
 * .bin 已在 metro.config.js 登记为 assetExt，按原字节透传；
 * 它只是给 `new Worker(url)` 的 URL，浏览器不关心后缀。
 *
 * ⚠️ 必须**惰性 require**，不能在模块顶层 require：
 *   Metro 对 assetExts 里的文件在 web 上返回资源句柄（{ uri }），
 *   而在 Jest/node 解析器下会把它当普通 JS 模块**执行**——
 *   而 worker 脚本顶层就有 `self.onmessage = ...`，在 Node 里直接
 *   ReferenceError: self is not defined，会连带打挂所有间接引入本模块的单测。
 *   惰性化之后，只有真正要用引擎时才 require，测试环境完全不会碰到它。
 */
function requireWorkerAsset(): unknown {
  return require('../../../assets/engines/pikafish_worker.bin');
}

/**
 * ⚠️ 扩展名必须是 `.html`（2026-10 真机实锤修复，勿回退）：
 * 原生端经 expo-asset 落成 `file://…/ExponentAsset-<hash>.<ext>` 缓存文件后，
 * WebView **按扩展名**决定 Content-Type——`.html` 得 text/html 且脚本执行；
 * 自造扩展名（曾用 .page）得 text/plain、整页进 <pre>、0 个脚本执行，
 * host-loaded 永不到来，引擎必然启动超时（PTP-AN10 CDP 实测）。
 * AAPT 资源名唯一性看 stem（pikafish 与 pikafish_wasm 等互异），.html 不再撞名。
 * 详见 metro.config.js 与 gen-pikafish-host.mjs 的说明。
 */
function requireHtmlAsset(): unknown {
  return require('../../../assets/engines/pikafish.html');
}

/** Web 端 Worker 直接 fetch 的二进制（不再 base64 内联，见生成脚本说明） */
function requireWasmAsset(): unknown {
  return require('../../../assets/engines/pikafish_wasm.wasm');
}

function requireNnueAsset(): unknown {
  return require('../../../assets/engines/pikafish_nnue.nnue');
}

/**
 * 把 Metro 的资源 require 结果归一化成 URI。
 *
 * ⚠️ 形态因平台而异：
 *   · Web     → **字符串** `/assets/?unstable_path=....bin`
 *   · 原生    → **数字**（AssetRegistry 的资源 id）或 { uri }
 *   只判断 string / {uri} 会在原生上漏掉数字形态 → 解析抛错 →
 *   `OfflineEngineHost` **渲染期崩溃**（比降级严重得多）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ **仅限 Web 端使用（Worker 及其 fetch 的二进制）——原生端禁止用于 WebView 源**
 *
 * 这里的数字分支用 `Image.resolveAssetSource` 换 uri。它在**开发态**返回
 * `http://localhost:8081/...`（真 URL，恰好能用），但在**打包态**返回的是
 * Android **裸资源名**（无 scheme），WebView 无法导航且不报错 →
 * 引擎永远「启动中」。这正是 2026-10 实机故障的根因。
 *
 * 原生端请一律走 `resolveNativeAssetUri()`（见 ./nativeAsset.ts）。
 * ═══════════════════════════════════════════════════════════════════════════
 */
function resolveAssetUri(asset: unknown): string | null {
  if (typeof asset === 'string' && asset.length > 0) return asset;

  if (typeof asset === 'number') {
    // Web 端数字形态（极少见）：用 Image.resolveAssetSource 换 uri。
    // ⚠️ 这里**只服务 Web 端**。原生端绝不能走这条分支，见函数顶部的警示。
    try {
      const { Image } = require('react-native') as typeof import('react-native');
      const resolved = Image.resolveAssetSource(asset) as { uri?: unknown } | null;
      if (resolved && typeof resolved.uri === 'string') return resolved.uri;
    } catch {
      /* 落到下面的 null */
    }
    return null;
  }

  if (asset && typeof asset === 'object') {
    const uri = (asset as { uri?: unknown }).uri;
    if (typeof uri === 'string') return uri;
    // 资源模块形态（部分 bundler 会包一层 default）
    const def = (asset as { default?: unknown }).default;
    if (typeof def === 'string') return def;
    if (typeof def === 'number') return resolveAssetUri(def);
    if (def && typeof def === 'object') {
      const defUri = (def as { uri?: unknown }).uri;
      if (typeof defUri === 'string') return defUri;
    }
  }
  return null;
}

/** 解析 Worker 资源 URL（Web 端给 `new Worker(url)` 用） */
function resolveWorkerUrl(): string {
  const uri = resolveAssetUri(requireWorkerAsset());
  if (uri) return uri;
  throw new Error('无法解析引擎 Worker 资源 URL（assets/engines/pikafish_worker.bin 缺失或未被登记为资源）');
}

/** 解析 Worker 需要 fetch 的二进制 URL（wasm + nnue） */
function resolveBinaryUrls(): { wasmUrl: string; nnueUrl: string } {
  const wasmUrl = resolveAssetUri(requireWasmAsset());
  const nnueUrl = resolveAssetUri(requireNnueAsset());
  if (!wasmUrl || !nnueUrl) {
    throw new Error(
      '无法解析引擎二进制资源 URL（assets/engines/pikafish_wasm.wasm / pikafish_nnue.nnue 缺失或未被登记为资源）'
    );
  }
  return { wasmUrl, nnueUrl };
}

/** WebView 引擎页的加载来源（类型定义在 engineTransport，避免循环依赖） */
export type { EngineHostSource } from './engineTransport';

/**
 * 解析 WebView 引擎页来源（原生端）。
 *
 * ⚠️ **这里必须是异步的，且必须经 nativeAsset 而不是 Image.resolveAssetSource。**
 *
 * 打包态下 `Image.resolveAssetSource(资源id)` 返回的是 Android **裸资源名**
 * （如 `engines_pikafish`，无任何 scheme，见 @react-native/assets-registry
 * 的 getAndroidResourceIdentifier）。它不是 URL，WebView 导航必然失败，
 * 且**不会触发任何错误回调**——引擎于是一直停在「启动中」。
 * 2026-10 实机故障的根因就是这里，现由 resolveNativeAssetUri 兜住。
 *
 * @see ./nativeAsset.ts 的完整根因说明
 */
export async function getEngineHostSource(): Promise<EngineHostSource> {
  const asset = requireHtmlAsset();

  // bundler 把 .html 当文本模块导出时，字符串本身就是 HTML 源码（不是 URL）。
  if (typeof asset === 'string' && asset.trimStart().startsWith('<')) {
    return { html: asset };
  }

  // 原生：资源 id → file:// 本地缓存 URI（WebView 可导航）
  return { uri: await resolveNativeAssetUri(asset, 'pikafish.html', 'html') };
}

/** 是否需要挂载屏幕外引擎宿主（仅原生端；Web 走 Worker） */
export function needsWebViewEngineHost(): boolean {
  return supportsWebViewTransport();
}

let singleton: OfflineEngineOrchestrator | null = null;

/** 取全局编排器（懒创建） */
export function getOfflineEngine(): OfflineEngineOrchestrator {
  if (singleton) return singleton;

  const primary = createPrimaryEngine();
  const fallback: OfflineEngine = new LegacyTsEngine();
  singleton = new OfflineEngineOrchestrator(primary, fallback);
  return singleton;
}

/** 按平台创建本地皮卡鱼引擎 */
function createPrimaryEngine(): OfflineEngine {
  if (Platform.OS === 'web') {
    return new PikafishOfflineEngine(() =>
      createWebWorkerTransport(resolveWorkerUrl(), resolveBinaryUrls())
    );
  }
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    /**
     * 原生：屏幕外 WebView。
     *
     * ⚠️ wasm/nnue 的 URI 必须与页面同源且**可被 WebView 内的 fetch 访问**。
     * 二者是各自独立的 res/raw 资源，因此**不能**把页面地址当基准去推相对路径
     * （expo-asset 复制进 cache 目录后文件并不相邻）。必须逐个解析成 file:// URI，
     * 再经 bootstrap 交给页面。
     */
    return new PikafishOfflineEngine(async () =>
      createWebViewTransport({
        wasmUrl: await resolveNativeAssetUri(
          requireWasmAsset(),
          'pikafish_wasm.wasm',
          'wasm'
        ),
        nnueUrl: await resolveNativeAssetUri(
          requireNnueAsset(),
          'pikafish_nnue.nnue',
          'nnue'
        ),
      })
    );
  }
  // 其他平台（Expo Go 之外的少见环境）：直接判定不可用，由编排器降级
  return new PikafishOfflineEngine(() => {
    throw new Error(`平台 ${Platform.OS} 不支持本地引擎承载`);
  });
}

/**
 * 预热本地引擎（App 启动时调用一次）。
 *
 * 不阻塞首屏：失败也只是降级，绝不抛出。目的是让"玩家进入对局前"就把
 * 6MB 引擎的加载与 WASM 实例化成本付掉。
 */
export function warmupLocalEngine(): void {
  setTimeout(() => {
    void getOfflineEngine().warmup();
  }, 0);
}

/** 仅测试用：重置单例 */
export function __resetOfflineEngineForTest(): void {
  if (singleton) {
    try {
      singleton.dispose();
    } catch {
      /* 忽略 */
    }
  }
  singleton = null;
}
