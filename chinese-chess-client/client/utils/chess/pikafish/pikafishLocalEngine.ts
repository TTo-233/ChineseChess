/**
 * 本地皮卡鱼引擎（OfflineEngine 实现）
 *
 * ============================================================================
 * 【职责边界】
 *
 * 本文件负责「一次搜索」的生命周期：
 *   组命令 → 下发 → 等结果 → 换算坐标 → 交给上层裁决
 * 它**不做**合法性判断（那是 aiDispatcher 的既有守卫链的事），也**不做**优先级排队
 * （那是 offlineOrchestrator 的事）。这样每一层都只有一件事可测。
 *
 * ============================================================================
 * 【串行化的必要性】
 *
 * 引擎实例只有一份，且 WASM 搜索是**同步阻塞**的（实测：send('go') 返回时
 * bestmove 已产生）。因此同一时刻只能有一次搜索：后续请求必须排队，
 * 等前一次结束后再下发。上层编排器用优先级决定排队顺序。
 *
 * ============================================================================
 * 【超时与重建】
 *
 * · 单次搜索有墙钟兜底（movetime），加上 depth，正常必然收敛；
 * · 仍超时 → 判定引擎卡死，destroy + 重建（最多 1 次），再失败抛
 *   OfflineEngineUnavailableError，由上层切兜底引擎。
 * · 引擎输出 CRITICAL ERROR（非法局面导致它自己退出）时同样必须重建。
 */

import {
  CMD_UCINEW_GAME,
  buildGo,
  buildPosition,
  buildSetOption,
  uciToInternal,
  isValidUciMoveList,
  type UciSearchSpec,
} from '../pikafishUci';
import { getPikafishTier } from '../pikafishDifficulty';
import {
  OfflineEngineBadMoveError,
  OfflineEngineUnavailableError,
  type EngineCapabilities,
  type OfflineEngine,
  type OfflineSearchRequest,
  type OfflineSearchResult,
} from '../offlineEngine';
import type { EngineTransport, HostOutbound } from './engineTransport';
import { TransportStartError } from './engineTransport';

/** 承载就绪（启动 + 引擎握手）整体超时 —— Worker 路径 */
const BOOT_TIMEOUT_MS = 20000;
/**
 * WebView 路径的启动超时（2026-10 审计 P0-1 配套）。
 *
 * 原生端要加载 6MB 内联 HTML 并实例化 WASM，WebView 首次渲染在低端 Android 上
 * 实测可能十几秒；用 Worker 的 20s 会在低配机上误判为"引擎不可用"并永久降级。
 * 这里放宽到 45s：超时的代价只是"这一局用弱 AI"，而误降级的代价是**整局会话**
 * 都用弱 AI（编排器不重试）。
 */
const WEBVIEW_BOOT_TIMEOUT_MS = 45000;
/** 单次搜索的墙钟兜底：在 tier.movetimeMs 之外再加的余量（覆盖通信与排队） */
const SEARCH_TIMEOUT_SLACK_MS = 4000;

type Pending = {
  seq: number;
  resolve: (r: OfflineSearchResult) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
};

export class PikafishOfflineEngine implements OfflineEngine {
  private transportFactory: () => EngineTransport | Promise<EngineTransport>;

  private transport: EngineTransport | null = null;
  private caps: EngineCapabilities | null = null;
  private bootPromise: Promise<EngineCapabilities> | null = null;
  /** 递增序号：用于丢弃迟到结果 */
  private seq = 0;
  private pending: Pending | null = null;
  private disposed = false;

  constructor(transportFactory: () => EngineTransport | Promise<EngineTransport>) {
    this.transportFactory = transportFactory;
  }

  get driver(): EngineCapabilities['driver'] {
    const t = this.transport;
    if (t) return t.kind;
    // 还没启动：按承载工厂的类型猜（用于 UI 展示，不参与逻辑）
    return 'web-worker';
  }

  init(): Promise<EngineCapabilities> {
    if (this.disposed) {
      return Promise.reject(new OfflineEngineUnavailableError('引擎已释放'));
    }
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = this.doBoot().catch((err) => {
      // 失败后清空缓存，允许上层重试（重建）
      this.bootPromise = null;
      throw err;
    });
    return this.bootPromise;
  }

  private doBoot(): Promise<EngineCapabilities> {
    // ⚠️ 不用 async Promise executor（no-async-promise-executor）：
    //   async executor 里抛出的异常会变成一个**永不被观察**的悬空 rejected
    //   promise（外层 Promise 已经构造完，不会再捕获它），故障就此静默丢失。
    //   这里改用同步 executor + 内层 async IIFE，并显式 catch 兜住所有出口。
    return new Promise<EngineCapabilities>((resolve, reject) => {
      let settled = false;
      // 超时预算随承载类型而定（WebView 路径更慢），
      // 但定时器必须在**知道承载类型之后**才能设，所以先建承载再起表。
      let timer: ReturnType<typeof setTimeout> | null = null;
      let bootBudgetMs = BOOT_TIMEOUT_MS;
      const armTimer = () => {
        if (timer) return;
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.destroyTransport();
          reject(new OfflineEngineUnavailableError(`引擎启动超时（${bootBudgetMs}ms）`));
        }, bootBudgetMs);
      };
      const stopTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const markReady = (c: EngineCapabilities) => {
        if (settled) return;
        settled = true;
        stopTimer();
        resolve(c);
      };
      const markBootError = (e: unknown) => {
        if (settled) return;
        settled = true;
        stopTimer();
        reject(e);
      };

      /**
       * ⚠️ armTimer() 必须在本 IIFE 的第一个 await **之前**调用。
       *
       * 承载工厂现在是异步的（原生端要经 expo-asset 把 wasm/nnue 资源解析成
       * file:// URI 才能下发给页面）。若把起表放在 await 之后，一旦工厂挂起就
       * **永远不会有超时**——Promise 悬空，对局卡在「AI 回合」，比超时降级严重得多。
       */
      armTimer();

      // 内层 async IIFE：承载工厂可能是异步的（见上方说明）。
      // 显式 catch 兜住所有出口，确保任何意外都不会变成悬空的 rejected promise。
      void (async () => {
      let t: EngineTransport;
      try {
        /**
         * 承载工厂现在**可能是异步的**（原生端要经 expo-asset 把 wasm/nnue 资源
         * 解析成 file:// URI 才能下发给页面）。同步工厂用 await 也能正常拿到值。
         */
        t = await this.transportFactory();
        this.transport = t;
        bootBudgetMs =
          t.kind === 'webview' ? WEBVIEW_BOOT_TIMEOUT_MS : BOOT_TIMEOUT_MS;
      } catch (err) {
        settled = true;
        reject(
          err instanceof TransportStartError
            ? err
            : new OfflineEngineUnavailableError(
                `引擎承载创建失败: ${err instanceof Error ? err.message : String(err)}`
              )
        );
        return;
      }

      t.onMessage((msg) => this.onHostMessage(msg, markReady, markBootError));
      t.onDead((reason) => {
        markBootError(new OfflineEngineUnavailableError(`引擎承载异常: ${reason}`));
      });

      try {
        // bootstrap 必须等承载**真正就绪**后才下发（2026-10 审计 P0-1）：
        //   · Worker：浏览器在 worker 脚本执行前排队的 postMessage，start() 即可发；
        //   · WebView：HTML 加载是异步的，且要解析 6MB 内联脚本（低配机可能十几秒），
        //     start() 时页面还没就绪，消息会被承载排队/丢弃 → 20s 超时 → 永久降级。
        // 因此把 onReady 交给承载：Worker 同步回调，WebView 在 host-loaded 时回调。
        t.start(() => {
          if (settled) return;
          try {
            // bootstrap 内容由承载决定：Worker 需要带上 wasm/nnue 的 URL
            // （它靠 fetch 拉二进制，而不是把 base64 内联进脚本）。
            t.send(t.bootstrapMessage ? t.bootstrapMessage() : { type: 'bootstrap' });
          } catch (err) {
            markBootError(
              new OfflineEngineUnavailableError(
                `引擎 bootstrap 下发失败: ${err instanceof Error ? err.message : String(err)}`
              )
            );
          }
        });
      } catch (err) {
        markBootError(
          err instanceof TransportStartError
            ? err
            : new OfflineEngineUnavailableError(
                `引擎承载启动失败: ${err instanceof Error ? err.message : String(err)}`
              )
        );
      }
      })().catch((err) => {
        // 兜底：IIFE 内任何未预期异常都不能悬空，必须转成启动失败让上层降级。
        markBootError(
          new OfflineEngineUnavailableError(
            `引擎启动过程异常: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      });
    });
  }

  /** 承载上行消息统一入口（启动期与搜索期共用） */
  private onHostMessage(
    msg: HostOutbound,
    markReady: (c: EngineCapabilities) => void,
    markBootError: (e: unknown) => void
  ): void {
    if (msg.type === 'host-loaded') {
      // 脚本已就位，引擎还在握手；此时不发 ready
      return;
    }
    if (msg.type === 'ready') {
      this.caps = {
        banner: msg.banner,
        options: msg.options,
        driver: this.transport?.kind ?? 'web-worker',
      };
      markReady(this.caps);
      return;
    }
    if (msg.type === 'error') {
      if (!this.pending) {
        // 启动期错误：交给 boot 的 reject；搜索期无 pending 说明是空闲态异常
        if (this.bootPromise) markBootError(new OfflineEngineUnavailableError(msg.message));
        return;
      }
      /**
       * 'engine busy' 是**占用中**，不是坏掉了（2026-10 实测修复）。
       *
       * 场景：后台 ponder 被取消时，JS 侧的 promise 立即作废，但 Worker 里那次
       * 同步搜索还在跑；此时正式走子的 search 会被拒为 busy。旧分类把它当成
       * "引擎不可用"→ 销毁重建 → 重拉 4.5MB 资源，手机上首步雪崩。
       * 正确语义：本步交给兜底 AI（runOffline 的下一层），引擎原样保留，
       * 当前搜索跑完自然空闲。
       */
      if (/engine busy/i.test(msg.message)) {
        this.settleError(new OfflineEngineBadMoveError('引擎正忙（上一次搜索未结束）'), false);
        return;
      }
      this.settleError(new OfflineEngineUnavailableError(msg.message));
      return;
    }
    if (msg.type === 'result') {
      this.onResult(msg.seq, msg.result, !!msg.fatal);
      return;
    }
    if (msg.type === 'stopped') {
      // 引擎已自行收尾，bestmove 结果行紧随其后；这里无需动作
      return;
    }
  }

  private onResult(seq: number, result: { uci: string; depth: number; candidates: string[]; timeMs: number }, fatal: boolean): void {
    const p = this.pending;
    if (!p) return; // 无人等待（例如已超时），丢弃
    if (p.seq !== seq) return; // 迟到结果，丢弃

    if (fatal || !result.uci || !isValidUciMoveList([result.uci])) {
      this.settleError(
        new OfflineEngineBadMoveError(
          fatal ? '引擎报告致命错误（局面非法或引擎已退出）' : '引擎未给出可用着法'
        ),
        // 致命错误说明引擎实例已不可信 → 重建
        fatal
      );
      return;
    }

    const internal = uciToInternal(result.uci);
    if (!internal) {
      this.settleError(new OfflineEngineBadMoveError(`无法解析引擎着法: ${result.uci}`), false);
      return;
    }
    this.settleResolve({
      uci: result.uci,
      depth: result.depth,
      timeMs: result.timeMs,
      ...internal,
    });
  }

  private settleResolve(r: OfflineSearchResult): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(r);
  }

  /** @param needRebuild true 表示实例已不可信，需要重建 */
  private settleError(e: unknown, needRebuild = false): void {
    const p = this.pending;
    if (p) {
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(e);
    }
    if (needRebuild) {
      this.caps = null;
      this.bootPromise = null;
      this.destroyTransport();
    }
  }

  private destroyTransport(): void {
    try {
      this.transport?.dispose();
    } catch {
      /* 忽略 */
    }
    this.transport = null;
  }

  /**
   * 计算一步棋。
   *
   * 注意：本引擎自身**不排队**——调用方（编排器）必须保证同一时刻只有一个
   * search 在飞。这里若发现已有搜索在进行，直接抛错而不是默默排队，
   * 因为"排队"会掩盖编排层的优先级 bug。
   */
  search(request: OfflineSearchRequest): Promise<OfflineSearchResult> {
    if (this.disposed) {
      return Promise.reject(new OfflineEngineUnavailableError('引擎已释放'));
    }
    if (!this.transport || !this.caps) {
      return Promise.reject(new OfflineEngineUnavailableError('引擎尚未初始化'));
    }
    if (this.pending) {
      return Promise.reject(
        new OfflineEngineUnavailableError('引擎正忙（编排器应保证串行调用）')
      );
    }

    const spec = this.buildSpec(request);
    this.seq += 1;
    const seq = this.seq;

    return new Promise<OfflineSearchResult>((resolve, reject) => {
      const budget =
        spec.movetimeMs + SEARCH_TIMEOUT_SLACK_MS;
      const timer = setTimeout(() => {
        if (this.pending && this.pending.seq === seq) {
          this.pending = null;
          // 超时：引擎大概率卡死，重建实例
          this.caps = null;
          this.bootPromise = null;
          this.destroyTransport();
          reject(new OfflineEngineUnavailableError(`引擎搜索超时（${budget}ms）`));
        }
      }, budget);

      this.pending = { seq, resolve, reject, timer, startedAt: Date.now() };

      // 取消信号：不等结果，直接让这次请求作废
      if (request.signal) {
        if (request.signal.aborted) {
          this.settleError(abortError(), false);
          return;
        }
        request.signal.addEventListener(
          'abort',
          () => {
            if (this.pending && this.pending.seq === seq) {
              this.settleError(abortError(), false);
              this.stop();
            }
          },
          { once: true }
        );
      }

      try {
        this.transport?.send({
          type: 'search',
          seq,
          randomPick: spec.randomPick,
          commands: [
            CMD_UCINEW_GAME,
            buildSetOption('MultiPV', spec.multiPV),
            buildPosition(spec.startFen, spec.moves),
            buildGo(spec),
          ],
        });
      } catch (err) {
        this.settleError(
          new OfflineEngineUnavailableError(
            `引擎指令下发失败: ${err instanceof Error ? err.message : String(err)}`
          ),
          true
        );
      }
    });
  }

  /** 把「难度档位 + 历史 + 白名单」翻译成一次 UCI 搜索参数 */
  private buildSpec(request: OfflineSearchRequest): UciSearchSpec {
    const tier = getPikafishTier(request.tier);

    // 优先用历史（startFen + moves）：引擎据此感知重复局面（长将/长捉/不变循环）。
    // 注意历史里的 moves 必须是合法 UCI，否则引擎会拒绝重放。
    let startFen = request.fen;
    let moves: string[] = [];
    const h = request.history;
    if (h && typeof h.startFen === 'string' && h.startFen.length > 0) {
      const list = Array.isArray(h.moves) ? h.moves : [];
      if (isValidUciMoveList(list)) {
        startFen = h.startFen;
        moves = list;
      } else {
        console.warn('[PikafishLocal] 历史含非法 UCI，改为只按 fen 搜索');
      }
    }

    // 白名单：只保留合法 UCI（传非法值引擎会直接 CRITICAL ERROR 退出）
    const raw = request.searchmoves ?? [];
    const searchmoves = raw.filter((m) => isValidUciMoveList([m]));
    if (raw.length > 0 && searchmoves.length === 0) {
      console.warn('[PikafishLocal] searchmoves 全部非法，已放弃白名单');
    }

    // ⚠️ 历史重放与 searchmoves 白名单**不能同时给**（2026-10 审计 P1-3）。
    //
    // 原因：走历史时引擎是按 startFen+moves **重建**局面的，而白名单是调用方
    // 按**当前** GameState 算出来的。仓库已记录过：历史里含送将着法时皮卡鱼
    // 会**拒绝重放**，于是停在送将之前的面子上。此时白名单里的着法属于
    // 另一个局面 —— 轻则被引擎滤空，重则给出对方着法/非法着法，
    // 最终被三重守卫拒收，再叠加"着法失败不降级"的新逻辑就会**这一步走不动**。
    //
    // 因此：带历史时不做根节点白名单，合法性交给引擎自身 + 调用方守卫；
    // 只有纯 fen 搜索（无历史）才用白名单收紧根节点。
    const useSearchmoves = moves.length === 0 && searchmoves.length > 0;

    return {
      startFen,
      moves,
      multiPV: tier.multiPV,
      depth: tier.depth,
      // ponder 等低价值请求可带墙钟上限：引擎同步且单实例，
      // 长预算会卡住随后排队进来的正式走子（详见 OfflineSearchRequest.movetimeCapMs）
      movetimeMs: request.movetimeCapMs
        ? Math.min(tier.movetimeMs, request.movetimeCapMs)
        : tier.movetimeMs,
      randomPick: tier.randomPick,
      searchmoves: useSearchmoves ? searchmoves : undefined,
    };
  }

  stop(): void {
    try {
      this.transport?.send({ type: 'stop' });
    } catch {
      /* 忽略 */
    }
  }

  newGame(): void {
    // 清置换表是每次搜索前必做的（search 里已带 ucinewgame）；
    // 这里只把"引擎状态脏了"标记为需要重握手之外无需额外处理。
  }

  /**
   * 实例是否仍可用。
   *
   * 搜索超时 / fatal 错误会清掉 caps 并释放承载（此时为 false），
   * 编排器据此重新 init —— 否则它会一直以为引擎就绪而跳过初始化。
   */
  isReady(): boolean {
    return !this.disposed && this.transport !== null && this.caps !== null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(new OfflineEngineUnavailableError('引擎已释放'));
    }
    this.destroyTransport();
    this.caps = null;
    this.bootPromise = null;
  }
}

/** 取消错误：与"引擎不可用"区分开，上层据此不计入熔断/不弹错误 */
export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** 是否是取消错误 */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}
