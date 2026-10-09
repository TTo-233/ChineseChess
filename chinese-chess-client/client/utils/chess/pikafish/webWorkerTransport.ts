/**
 * Web Worker 承载层（Web / Expo Web）
 *
 * Worker 用的是**构建期生成的单文件产物** assets/engines/pikafish.worker.js：
 * 它内联了服务端那份 Emscripten 加载器 + base64 的 WASM/NNUE + UCI 状态机，
 * 因此不需要 Metro 再往 worker 里注入任何东西——`new Worker(url)` 即可。
 *
 * 这也顺带避开了两个坑：
 *   · Metro 若把 6MB 的 .js 当源码转译，会把 base64 字符串塞进 Babel/JSX 管线，
 *     启动极慢且内存峰值高；
 *   · worker 里的 importScripts 是同步的，先载入 6MB 再执行逻辑最稳。
 *
 * ⚠️ 本地引擎是**单线程** WASM（未开 pthreads），不需要 SharedArrayBuffer，
 *    因此不需要 COOP/COEP 跨源隔离响应头。
 */

import type {
  EngineTransport,
  HostInbound,
  HostSearchMessage,
  HostOutbound,
} from './engineTransport';
import { TransportStartError } from './engineTransport';

/**
 * @param workerUrl 打包好的 Worker 脚本 URL（**小**：只有 loader + UCI 协议）
 * @param binaryUrls wasm / nnue 的 URL —— Worker 会 fetch 它们。
 *   不再 base64 内联：省 27.5% 传输量、省掉脚本解析与解码（见生成脚本说明）。
 */
export function createWebWorkerTransport(
  workerUrl: string,
  binaryUrls: { wasmUrl: string; nnueUrl: string }
): EngineTransport {
  let worker: Worker | null = null;
  let messageCb: ((msg: HostOutbound) => void) | null = null;
  let deadCb: ((reason: string) => void) | null = null;
  let started = false;

  return {
    kind: 'web-worker',

    /** Worker 需要二进制 URL；WebView 版本不需要（页面内联） */
    bootstrapMessage(): HostInbound {
      return {
        type: 'bootstrap',
        wasmUrl: binaryUrls.wasmUrl,
        nnueUrl: binaryUrls.nnueUrl,
      };
    },

    /**
     * 启动 Worker 承载。
     *
     * ⚠️ onReady 必须回调（2026-10 实测回归）：
     * 启动层（PikafishOfflineEngine.doBoot）把 `bootstrap` 的下发**挂在 onReady 里**，
     * 这里不调用它 → bootstrap 永远发不出去 → 引擎始终不握手 → 20s 启动超时
     * → 永久降级到兜底 AI（界面表现为"基础AI"）。这正是用户实测到的现象。
     *
     * 为什么创建后即可回调：浏览器会把 postMessage **排队**到 Worker 脚本开始执行
     * 之后投递，所以此时发 bootstrap 一定晚于 `self.onmessage` 的装配。
     * 注意 onMessage 必须已由调用方注册（doBoot 在执行顺序上先注册后 start）。
     */
    start(onReady?: () => void) {
      if (started) return;
      started = true;
      if (typeof Worker === 'undefined') {
        throw new TransportStartError('当前环境不支持 Web Worker');
      }
      try {
        worker = new Worker(workerUrl);
      } catch (err) {
        throw new TransportStartError(
          `创建引擎 Worker 失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      worker.onmessage = (ev: MessageEvent<HostOutbound>) => {
        messageCb?.(ev.data);
      };
      worker.onerror = (ev: ErrorEvent) => {
        deadCb?.(ev.message || '引擎 Worker 异常退出');
      };
      worker.onmessageerror = () => {
        deadCb?.('引擎 Worker 消息无法反序列化');
      };
      // 处理器已装好 → 通知启动层可以下发 bootstrap
      onReady?.();
    },

    send(msg: HostInbound | HostSearchMessage) {
      if (!worker) throw new TransportStartError('引擎承载未启动');
      worker.postMessage(msg);
    },

    onMessage(cb) {
      messageCb = cb;
    },

    onDead(cb) {
      deadCb = cb;
    },

    dispose() {
      if (worker) {
        try {
          worker.postMessage({ type: 'dispose' });
          worker.terminate();
        } catch {
          /* 忽略：进程可能已死 */
        }
      }
      worker = null;
      started = false;
    },
  };
}
