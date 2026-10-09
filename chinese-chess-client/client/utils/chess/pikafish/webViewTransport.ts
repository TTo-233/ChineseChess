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

/* -------------------------------------------------------------------------- */
/* 命令式桥（单例）                                                            */
/* -------------------------------------------------------------------------- */

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

function inject(msg: HostInbound | HostSearchMessage): void {
  webViewInstance?.injectJavaScript(
    `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(msg)}}));true;`
  );
}

export const webViewBridge = {
  isReady: (): boolean => pageLoaded && pageAlive,
  send(msg: HostInbound | HostSearchMessage): void {
    if (!pageAlive) return;
    if (!pageLoaded) {
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

/** 供组件内部转发上行消息 */
export function dispatchWebViewMessage(msg: HostOutbound): void {
  if (msg.type === 'host-loaded') {
    pageLoaded = true;
    pageAlive = true;
    // 页面就绪：按序补发排队的握手消息（bootstrap 就在其中）
    if (pendingOutbox.length > 0) {
      const queued = pendingOutbox.splice(0, pendingOutbox.length);
      for (const m of queued) inject(m);
    }
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

/** 供组件注册/注销真实 WebView 实例 */
export function registerWebView(instance: Injectable | null): void {
  webViewInstance = instance;
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
}

/* -------------------------------------------------------------------------- */
/* Transport 实现                                                              */
/* -------------------------------------------------------------------------- */

/**
 * WebView 版 transport。
 *
 * 启动本身没有"创建"动作（组件在根布局挂载），这里只做平台校验并触发 bootstrap；
 * 若组件尚未挂载，报错由上层捕获 → 降级到兜底引擎，绝不让对局卡住。
 */
export function createWebViewTransport(): EngineTransport {
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
