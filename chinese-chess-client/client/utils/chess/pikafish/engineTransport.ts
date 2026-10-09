/**
 * 引擎承载层 —— 把「Worker / WebView 两条消息通道」统一成同一个内部接口。
 *
 * 之所以抽出 Transport：Worker 与 WebView 的 API 完全不同
 * （`new Worker(...)` vs `<WebView onMessage>`），但它们说的话是同一套协议
 * （见 pikafishHost.worker.ts 与 pikafishHost.html，两者的消息类型刻意保持一致）。
 * 上层引擎实现因此不必关心当前跑在哪个平台上。
 */

import type { UciSearchResult } from '../pikafishUci';

export interface HostInbound {
  /**
   * 启动请求。
   *
   * ⚠️ wasmUrl/nnueUrl 只有 **Worker 承载**需要（它靠 fetch 拉二进制，
   * 收益见 gen-pikafish-host.mjs 的性能说明）；WebView 承载的页面把二进制
   * 内联在 HTML 里，会忽略这两个字段。
   */
  type: 'bootstrap' | 'stop' | 'dispose';
  wasmUrl?: string;
  nnueUrl?: string;
}

export interface HostSearchMessage {
  type: 'search';
  seq: number;
  commands: string[];
  randomPick: boolean;
}

/** 承载层上行消息（与 worker / html 两侧定义一致） */
export type HostOutbound =
  | { type: 'host-loaded' }
  | { type: 'ready'; banner: string; options: string[] }
  | { type: 'error'; message: string }
  | { type: 'result'; seq: number; result: UciSearchResult; fatal?: boolean }
  | { type: 'stopped'; seq: number };

/** 承载层统一接口 */
export interface EngineTransport {
  readonly kind: 'web-worker' | 'webview';
  /**
   * 启动承载（创建 Worker / 挂载 WebView 并加载离线页）
   *
   * @param onReady 承载真正就绪的回调。
   *   Worker 由浏览器在 worker 脚本执行前排队的 postMessage 天然就绪，无需回调；
   *   WebView 的 HTML 加载是异步的，必须等 onReady（页面 host-loaded）之后
   *   下发的消息才有效 —— 启动层据此决定何时发 bootstrap。
   *   不实现该参数时视为"立即就绪"（同步契约）。
   */
  start(onReady?: () => void): void;
  /**
   * 该承载的 bootstrap 消息（可带专属字段，如 Worker 需要的二进制 URL）。
   * 由启动层（doBoot）在 onReady 后原样下发。
   */
  bootstrapMessage?(): HostInbound;
  /** 下行发送 */
  send(msg: HostInbound | HostSearchMessage): void;
  /** 上行回调注册（承载层保证单线程回调） */
  onMessage(cb: (msg: HostOutbound) => void): void;
  /** 承载自身崩溃/被销毁（WebView 卸载、Worker 异常） */
  onDead(cb: (reason: string) => void): void;
  /** 释放 */
  dispose(): void;
}

/** 承载层启动失败（资源缺失、Worker 构造失败、WebView 不可用） */
export class TransportStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportStartError';
  }
}

/**
 * WebView 引擎页的加载来源。
 *
 * · `{ html }` —— 内联页面文本
 * · `{ uri }`  —— 交给 WebView 自行加载（原生端资源是数字 id，只能换 uri；
 *                 也避免 6MB 字符串过 RN 桥）
 *
 * 定义放在本模块（零依赖）而不是 pikafish/index.ts，是为了让
 * webViewHost.tsx 能引用它而不与 index.ts 形成循环依赖。
 */
export type EngineHostSource = { html: string } | { uri: string };
