/**
 * WebView 承载层 —— **命令式部分**（不含 React 组件，不 import react-native-webview）
 *
 * ============================================================================
 * 【为什么把组件拆到另一个文件】
 *
 * `react-native-webview` 在 import 时就会 `TurboModuleRegistry.getEnforcing('RNCWebViewModule')`，
 * 在 Jest（无原生二进制）里**直接抛错**。而本模块被 offlineAiAdapter → usePendingAIMove
 * 间接引入，若在此 import WebView，所有纯逻辑单测都会连带炸掉。
 *
 * 因此这里只保留命令式桥与类型（零原生依赖），
 * 真正渲染 WebView 的组件放在 webViewHost.tsx，由根布局单独 import。
 */

import { Platform } from 'react-native';

import type {
  EngineTransport,
  HostInbound,
  HostSearchMessage,
  HostOutbound,
} from './engineTransport';
import { TransportStartError } from './engineTransport';

type Listener = (msg: HostOutbound) => void;
type DeadListener = (reason: string) => void;

/** 平台是否支持 WebView 承载（Web 端走 Worker 分支） */
export function supportsWebViewTransport(): boolean {
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

/**
 * 命令式桥（单例）                                                            
 */

let messageCb: Listener | null = null;
let deadCb: DeadListener | null = null;
/** 页面是否已加载完成（host-loaded）。未加载前下行消息进入 pendingOutbox 排队 */
let pageLoaded = false;
let pageAlive = true;

/** 当前挂载的 WebView 实例（由 webViewHost.tsx 注册） */
interface Injectable {
  injectJavaScript(script: string): void;
}
let webViewInstance: Injectable | null = null;

/**
 * 待发消息队列（页面就绪前积压，host-loaded 后按序补发）。
 *
 * ============================================================================
 * 【为什么必须有这个队列 · 2026-10 审计 P0-1】
 *
 * WebView 承载的 `send` 原本在页面未加载时**静默丢弃**消息。而引擎的 bootstrap
 * 是在 `transport.start()` 之后立即下发的，而原生 WebView 的 HTML 加载必然是
 * 异步的：根布局 `useEffect` → `setTimeout(0)` → `init()` → `send(bootstrap)`，
 * 几乎必然跑在 `onMessage('host-loaded')` 之前。
 *
 * 后果是原生端**每一次都丢掉 bootstrap** → 20s BOOT_TIMEOUT_MS 到期 →
 * init 失败 → 永久降级到兜底 AI，而且 UI 仍显示"基础AI"，毫无提示。
 *
 * Web 端不受影响，因为 Dedicated Worker 的 postMessage 在 worker 脚本执行前
 * 由浏览器排队；WebView 没有这层保证，必须自己实现。
 *
 * ⚠️ 队列只积压**握手类**消息：bootstrap / stop / dispose。search 不排队——
 *     引擎未就绪时根本不该有 search（那由 BOOT_TIMEOUT 兜底成 init 失败）。
 */
const pendingOutbox: Array<HostInbound> = [];
/** 队列上限：异常情况下（页面永不加载）不至于无限堆积 */
const OUTBOX_MAX = 16;

/**
 * 承载实例是否已被**真正**判死。
 *
 * ⚠️ 这是本文件最关键的一个标志（2026-10 实测根因修复）。
 *
 * 之前的实现把「ref 回调收到 null」直接当成"承载加载失败"：
 *   pageAlive = false; pendingOutbox.length = 0; deadCb?.(...)
 * 而 React 的 `ref={(i) => registerWebView(i)}`（内联箭头函数）**每次重渲染都会
 * 先回调 null 再回调实例**——这是 React ref 的标准语义，不是卸载。
 * 于是每一次 re-render（OfflineEngineHost 的 useEffect、Provider 状态变化、
 * 屏幕旋转、AppState 切换…）都会：
 *   ① pageAlive=false → ② **清空 bootstrap 队列** → ③ 上报承载死亡
 * 而 `pageAlive` 只有 `host-loaded` 能设回 true，页面却只加载一次。
 * 结果：原生端引擎**永久失联** —— send() 第一行就 return，bootstrap 再也发不出去，
 * 界面上永远转"皮卡鱼启动中"。这与用户实机反馈完全一致。
 *
 * 现在把「ref 脱离」与「承载死亡」彻底分开：
 *   · ref(null)          → 只清实例引用（那才是"暂时没法注入"的真实含义），
 *                          **不动 pageAlive、不动队列**；
 *   · onError/onHttpError/onRenderProcessGone/onContentProcessDidTerminate/
 *     组件真卸载 → 才是承载死亡（dispatchWebViewDead）。
 */
let hostUnmounted = false;

function inject(msg: HostInbound | HostSearchMessage): void {
  webViewInstance?.injectJavaScript(
    `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(msg)}}));true;`
  );
}

/** pageLoaded 已经成立时，bootstrap 等消息应立即注入而不是排队 */
function isPageSettled(): boolean {
  return pageLoaded && pageAlive;
}

export const webViewBridge = {
  isReady: (): boolean => isPageSettled(),
  send(msg: HostInbound | HostSearchMessage): void {
    if (!pageAlive) return;
    // 页面已就绪但此刻拿不到注入句柄（React 重渲染的中间态，ref 短暂为 null）：
    // 直接 inject 会把消息丢进黑洞。必须**排队**，等下一次 registerWebView(instance)
    // 或 host-loaded 时补发 —— 否则正好撞上这个窗口的 bootstrap / search 会永久丢失，
    // 表现就是"引擎明明起来了却一直不出招"。
    if (!isPageSettled() || !webViewInstance) {
      // 页面还没加载完：握手类消息排队，等 host-loaded 后补发（见上方 P0-1 说明）
      if (msg.type === 'search') return;
      if (pendingOutbox.length < OUTBOX_MAX) {
        pendingOutbox.push(msg);
      } else {
        // 队列满：丢掉最旧的一条，保证最新的握手请求能被送达
        pendingOutbox.shift();
        pendingOutbox.push(msg);
      }
      return;
    }
    inject(msg);
  },
};

/**
 * 注入句柄重新可用时把队列里的消息立刻补发（不等下一次 host-loaded）。
 *
 * ⚠️ 这是上面"重渲染窗口"的补救：ref 从 null 变回实例的那一刻调用它。
 */
function flushOutbox(): void {
  if (!isPageSettled() || !webViewInstance) return;
  if (pendingOutbox.length === 0) return;
  const queued = pendingOutbox.splice(0, pendingOutbox.length);
  for (const m of queued) inject(m);
}

/** 供组件内部转发上行消息 */
export function dispatchWebViewMessage(msg: HostOutbound): void {
  if (msg.type === 'host-loaded') {
    pageLoaded = true;
    pageAlive = true;
    // 页面就绪：按序补发排队的握手消息（bootstrap 就在其中）
    flushOutbox();
  }
  messageCb?.(msg);
}

/** 供组件内部上报承载死亡（WebView 卸载/加载失败） */
export function dispatchWebViewDead(): void {
  pageAlive = false;
  pageLoaded = false;
  webViewInstance = null;
  pendingOutbox.length = 0;
  deadCb?.('WebView 引擎承载不可用');
}

/**
 * 供组件注册/注销真实 WebView 实例。
 *
 * ============================================================================
 * 【2026-10 实测根因修复：ref(null) 不等于承载死亡】
 *
 * 原实现在 `instance === null && pageAlive` 时直接判死并清空队列。React 的
 * `ref={(i) => registerWebView(i)}` 是内联箭头函数，**每次重渲染都会先传 null
 * 再传实例**（React ref 的标准语义）。于是任意一次 re-render 都会把承载打成"死亡"：
 * pageAlive=false、bootstrap 队列被清空、上报 onDead。
 * 而 pageAlive 只有页面唯一一次 `host-loaded` 能置回 true —— 之后再无恢复路径，
 * `send()` 首行 `if (!pageAlive) return` 永久丢弃一切消息。
 * 用户实机表现：象棋对局永远"皮卡鱼启动中"、AI 不动。
 *
 * 修复：`null` 只表示"此刻没有可注入的实例"（组件重渲染的中间态），
 * 承载死亡改由真正的失败回调（onError / onHttpError / 渲染进程被杀 /
 * 组件卸载）经 dispatchWebViewDead 上报，两者语义不再混用。
 * 队列也不在这里清：把"实例暂时没了"当成"会话该丢弃"，会让正好赶上
 * 重渲染的那一次 bootstrap 永久丢失。
 */
export function registerWebView(instance: Injectable | null): void {
  webViewInstance = instance;
  if (instance) {
    hostUnmounted = false;
    // 注入句柄回来了：把重渲染窗口里排队的消息立刻补发（否则那一次 bootstrap 会丢）
    flushOutbox();
    return;
  }
  // 卸载与"重渲染中间态"要区分：只有在**从未成功挂载过**时才认为宿主不存在。
  // 已经收到过 host-loaded 说明页面活着，只是此刻拿不到注入句柄 → 保留状态。
  if (!pageLoaded && !pageAlive) {
    hostUnmounted = true;
  }
}

/** 宿主是否已被卸载（渲染期可查，避免抛错打崩 App） */
export function isWebViewHostUnmounted(): boolean {
  return hostUnmounted;
}

/**
 * 重置桥状态（引擎重建时调用）。
 *
 * ⚠️【2026-10 审计 P1】这里**只清引擎会话的残留**（积压的握手消息），
 * 绝不能把 pageLoaded / pageAlive / webViewInstance 一并清空：
 *   · 它们描述的是**仍挂载、仍加载**的 WebView 视图，而不是某一次引擎会话；
 *   · 引擎重建时组件并未卸载（挂在根布局），宿主 ref 不会二次回调，
 *     一旦在此把 webViewInstance 置 null，新 transport 的 inject() 就永久空转；
 *   · 页面也早已加载完，`host-loaded` 不会二次上报，pageLoaded=false 会让
 *     bootstrap 一直躺在队列里等一个永不发生的 flush。
 * 两者叠加 → 原生端每次引擎重建都再也起不来（只能重启 App），
 * 与编排器"冷却后重试"的设计直接冲突。
 *
 * 真正"视图已死"的语义由 dispatchWebViewDead 负责（它才该清空全部状态）。
 */
export function resetWebViewBridge(): void {
  // 只丢弃上一会话的积压握手消息（bootstrap/stop/dispose 都可能残留）
  pendingOutbox.length = 0;
}

/**
 * 仅供测试：把模块级桥状态**整体**复位（含页面就绪标记与实例引用）。
 *
 * 为什么需要它单独存在：生产路径的 resetWebViewBridge 刻意**保留** pageLoaded /
 * webViewInstance（那是"引擎重建"而不是"页面重置"，见上方说明）；
 * 而单测之间必须回到"页面尚未加载"的初始态，否则上一个用例置过的 pageLoaded
 * 会串味到下一个用例（表现为消息不再排队、直接注入）。
 *
 * 生产代码不要调用它 —— 真要让承载回到未加载态，那是 dispatchWebViewDead 的语义
 *（视图已死）或重新挂载宿主组件。
 */
export function __resetWebViewBridgeForTest(): void {
  pageLoaded = false;
  pageAlive = true;
  webViewInstance = null;
  pendingOutbox.length = 0;
  hostUnmounted = false;
}

/* -------------------------------------------------------------------------- */
/* Transport 实现                                                              */
/* -------------------------------------------------------------------------- */

/**
 * WebView 版 transport。
 *
 * 启动本身没有"创建"动作（组件在根布局挂载），这里只做平台校验并触发 bootstrap；
 * 若组件尚未挂载，报错由上层捕获 → 降级到兜底引擎，绝不让对局卡住。
 *
 * ⚠️ binaryUrls：原生端页面**不再内联** wasm/nnue 的 base64（2026-10 真机性能/内存
 * 修复），改为与 Worker 同构的 fetch 两个独立二进制资源。因此 bootstrap 必须带上
 * 它们在原生端的 file:// URI，否则页面会因拿不到 URL 而无法启动引擎。
 */
export function createWebViewTransport(
  binaryUrls?: { wasmUrl: string; nnueUrl: string }
): EngineTransport {
  let started = false;
  /** 承载真正就绪后的回调（由 doBoot 传入，用于在其后下发 bootstrap） */
  let readyCb: (() => void) | null = null;
  /** 是否已回调过就绪（页面可能重复发 host-loaded） */
  let readyFired = false;

  return {
    kind: 'webview',

    start(onReady) {
      if (started) return;
      started = true;
      readyCb = onReady ?? null;
      readyFired = false;
      if (!supportsWebViewTransport()) {
        throw new TransportStartError(`平台 ${Platform.OS} 不支持 WebView 承载`);
      }
      // 页面可能**已经**加载完成（例如引擎在 WebView 挂载之后才首次 init），
      // 此时必须立刻补发就绪回调，否则 bootstrap 会一直等到超时。
      if (webViewBridge.isReady()) {
        readyFired = true;
        readyCb?.();
      }
    },

    bootstrapMessage() {
      // 原生端页面靠 fetch 拿二进制，与 Worker 承载同构。
      // 传 null 而不是空对象：页面会显式报「bootstrap 缺少 wasmUrl/nnueUrl」
      // 而不是拿着 undefined 去 fetch 出一个难以理解的报错。
      return binaryUrls
        ? { type: 'bootstrap', wasmUrl: binaryUrls.wasmUrl, nnueUrl: binaryUrls.nnueUrl }
        : { type: 'bootstrap' };
    },

    send(msg) {
      if (!started) throw new TransportStartError('WebView 承载未启动');
      webViewBridge.send(msg);
    },

    onMessage(cb) {
      messageCb = (msg: HostOutbound) => {
        // 页面就绪 → 通知启动层（bootstrap 会在此后下发）
        if (msg.type === 'host-loaded' && !readyFired) {
          readyFired = true;
          readyCb?.();
        }
        cb(msg);
      };
    },

    onDead(cb) {
      deadCb = cb;
    },

    dispose() {
      if (started) webViewBridge.send({ type: 'dispose' });
      started = false;
      readyCb = null;
      readyFired = false;
      resetWebViewBridge();
    },
  };
}
