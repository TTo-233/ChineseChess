/**
 * 揭棋引擎的 WebView 承载层 —— 命令式部分（零原生依赖，可单测）
 *
 * ============================================================================
 * 【为什么揭棋需要自己一套承载，而不直接复用 pikafish/webViewTransport.ts】
 *
 * 两个引擎的交互模型根本不同（详见 jieqiHost.ts 顶部说明）：
 *   · 皮卡鱼：**常驻可交互**实例，bootstrap 一次，之后逐条 send_command；
 *     引擎会先回 ready，transport 才认为可用。
 *   · 揭棋：**一次性批量会话**——每次搜索 = 一个完整 WASM 实例生命周期，
 *     喂完整命令序列（含 quit），收集输出，实例结束。没有"ready"这个状态，
 *     也就没有"握手"可言。
 *
 * 强行塞进常驻 transport 会带来两个坏处：要么给揭棋造一个假的 ready 握手，
 * 要么让同一个 send() 在两种语义间分叉。分开写更直白，也让两边的超时预算
 * 可以各自按实测调（揭棋会话 ~80ms + 搜索，卡死判定可以短得多）。
 *
 * ============================================================================
 * 【与 Worker 路径的对称关系】
 *
 *   Web（Worker）                原生（WebView）
 *   ────────────────────────    ──────────────────────────
 *   new Worker(url)             根布局挂载 JieqiWebViewHost（单例）
 *   postMessage({session})      injectJavaScript(dispatchEvent)
 *   onmessage({done})           onMessage → dispatchJieqiMessage
 *   terminate()                  丢弃（页面常驻，实例本来就一次性）
 *
 * 页面协议由 scripts/gen-jieqi-host.mjs 生成，两端共用同一份页面逻辑：
 *   in : { type:'session', commands:string[] } | { type:'dispose' }
 *   out: { type:'host-loaded' } | { type:'done', banner, lines } | { type:'error', message }
 */

import { Platform } from 'react-native';

type Listener = (msg: JieqiOutbound) => void;

/** 揭棋引擎页的下行协议 */
export type JieqiInbound =
  | { type: 'session'; commands: string[] }
  | { type: 'dispose' };

/** 揭棋引擎页的上行协议 */
export type JieqiOutbound =
  | { type: 'host-loaded' }
  | { type: 'done'; banner: string; lines: string[] }
  | { type: 'error'; message: string };

/** 平台是否支持 WebView 承载 */
export function supportsJieqiWebView(): boolean {
  return Platform.OS === 'android' || Platform.OS === 'ios';
}

interface Injectable {
  injectJavaScript(script: string): void;
}

/** 页面是否已就绪（收到过 host-loaded） */
let pageLoaded = false;
/** 承载是否已被真死亡回调上报 */
let pageAlive = true;
let instance: Injectable | null = null;
let listener: Listener | null = null;

/**
 * 等待页面就绪的等待者。
 *
 * ⚠️ 原生 WebView 加载离线页必然是异步的，而会话请求可能在页面 ready 前就到了
 * （App 启动即预热）。此时必须**挂起请求**而不是抛错或丢弃：
 * 揭棋引擎页很小（0.57 MiB），等待通常只有几百毫秒。
 */
type PendingSession = {
  commands: string[];
  resolve: (msg: JieqiOutbound) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
let waiting: PendingSession | null = null;

function inject(msg: JieqiInbound): void {
  instance?.injectJavaScript(
    `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(msg)}}));true;`
  );
}

/** 会话超时：揭棋是一次性会话，卡死只需重开会话，不必重建整个承载 */
const DEFAULT_TIMEOUT_MS = 20000;

/**
 * 在原生 WebView 里跑一次揭棋 UCI 会话。
 *
 * @param commands  完整命令序列（最后应含 `quit`）
 * @param timeoutMs 墙钟上限
 */
export function runSessionInWebView(
  commands: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<JieqiOutbound> {
  return new Promise((resolve, reject) => {
    if (!pageAlive) {
      reject(new Error('揭棋引擎 WebView 承载不可用'));
      return;
    }
    if (waiting) {
      // 引擎同一时刻只能跑一个实例（one-shot），并发请求直接拒绝而不是排队：
      // 揭棋每步只会有一次搜索，排队只会把超时推给调用方。
      reject(new Error('揭棋引擎正忙（上一次会话未结束）'));
      return;
    }
    // 两种情况都先排上队（页面就绪前的挂起、以及真正发起）：
    //   · 页面已就绪 → dispatch 路径不会碰 waiting，注入后由 done/error 收尾；
    //   · 页面未就绪 → host-loaded 到达时再真正注入。
    // timer 从**请求时刻**起算，保证"页面永不加载"不会永久悬挂，
    // 且调用方给的预算不会被悄悄放大。
    const timer = setTimeout(() => {
      if (waiting === entry) waiting = null;
      reject(new Error(`揭棋引擎会话超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const entry: PendingSession = { commands, resolve, reject, timer };
    waiting = entry;

    if (pageLoaded && instance) {
      inject({ type: 'session', commands });
    }
    // 否则等 dispatchJieqiMessage 收到 host-loaded 再发起
  });
}

/** 供组件转发页面上行消息 */
export function dispatchJieqiMessage(msg: JieqiOutbound): void {
  if (msg.type === 'host-loaded') {
    const firstLoad = !pageLoaded;
    pageLoaded = true;
    pageAlive = true;
    // 挂起的会话：页面就绪的瞬间立刻发起（一次性会话，无需再握手）
    if (firstLoad && waiting) {
      const w = waiting;
      inject({ type: 'session', commands: w.commands });
    }
  }
  if ((msg.type === 'done' || msg.type === 'error') && waiting) {
    const w = waiting;
    waiting = null;
    clearTimeout(w.timer);
    w.resolve(msg);
  }
  listener?.(msg);
}

/** 供组件上报承载死亡（加载失败 / 渲染进程被杀 / 组件卸载） */
export function dispatchJieqiDead(): void {
  pageAlive = false;
  pageLoaded = false;
  instance = null;
  if (waiting) {
    const w = waiting;
    waiting = null;
    clearTimeout(w.timer);
    w.reject(new Error('揭棋引擎 WebView 承载不可用'));
  }
}

/**
 * 供组件注册/注销 WebView 实例。
 *
 * ⚠️ 与 webViewTransport.registerWebView 同理：`null` 只表示"此刻没有可注入的
 * 句柄"（React ref 在重渲染时的中间态），**不是承载死亡**。
 * 真死亡一律走 dispatchJieqiDead（由 onError / onHttpError /
 * onRenderProcessGone / onContentProcessDidTerminate 触发）。
 */
export function registerJieqiWebView(next: Injectable | null): void {
  instance = next;
}

/** 仅供测试：整体复位 */
export function __resetJieqiBridgeForTest(): void {
  pageLoaded = false;
  pageAlive = true;
  instance = null;
  listener = null;
  if (waiting) {
    clearTimeout(waiting.timer);
    waiting = null;
  }
}

/** 设置上行监听（诊断用） */
export function setJieqiListener(next: Listener | null): void {
  listener = next;
}