/**
 * 本地引擎编排器：串行队列 + 优先级 + 兜底降级
 *
 * ============================================================================
 * 【为什么需要它】
 *
 * 本地只有**一个**引擎实例，且 WASM 搜索同步阻塞引擎线程。因此：
 *   · 同时刻只能有一次搜索 → 必须串行；
 *   · 谁先谁后必须有规则 → 按用途定优先级；
 *   · 引擎起不来 / 崩了 / 平台不支持 → 必须自动切到旧 TS AI，且**对调用方透明**。
 *
 * 优先级（与 services/pikafish 服务端「提示可插队」的既有约定一致）：
 *   move（轮到 AI 落子） > hint（用户点提示） > ponder（后台预计算）
 *
 * ============================================================================
 * 【降级策略：只在引擎真的不可用时降级，且一次会话只降一次】
 *
 * 触发降级的**只有**承载/初始化层面的失败（平台不支持、Worker 起不来、
 * WebView 页面永不加载、引擎崩溃、启动超时）。理由是这类问题不会自己好：
 * 反复重试只会让每一步都卡在初始化超时上，对局直接不可玩。
 * 因此同一会话内首次遇到就永久降级，并把原因暴露给 UI。
 *
 * ⚠️ 着法层面的失败**不降级**（2026-10 审计 P0-2）：
 * bestmove (none) / CRITICAL ERROR / 守卫拒收多半是位置相关的一次性事件，
 * 换个局面引擎就正常。此前把它们也算作"引擎不可用"，导致一次偶发局面
 * 让整局会话退回弱 AI 且不可恢复。现在只把错误抛给本次调用方。
 */

import {
  OfflineEngineUnavailableError,
  PURPOSE_PRIORITY,
  isEngineUnavailableError,
  isTransportStartError,
  type EngineCapabilities,
  type OfflineEngine,
  type OfflineSearchRequest,
  type OfflineSearchResult,
  type SearchPurpose,
} from '../offlineEngine';

export type LocalEngineSource = 'pikafish' | 'legacy' | 'starting';

export interface OfflineEngineStatus {
  /**
   * 当前状态：
   *   · 'pikafish'  —— 本地皮卡鱼已就绪，正在用
   *   · 'starting'  —— 引擎启动中/重试中，此刻用兜底 AI（可能马上就好）
   *   · 'legacy'    —— 判定为永久不可用（平台不支持/多次启动失败），一直用兜底
   */
  source: LocalEngineSource;
  /** 已就绪时的能力信息 */
  capabilities: EngineCapabilities | null;
  /** 非 'pikafish' 时的原因（启动中为最近一次失败原因），供 UI 提示与排障 */
  reason: string | null;
}

/** 启动尝试上限：超过即判永久不可用，避免每步都白等一次启动超时 */
const MAX_INIT_ATTEMPTS = 6;
/**
 * 引擎未就绪时，为本次走子最多等多久。
 *
 * 太短 → 开局第一步无谓地用弱 AI；太长 → 玩家点完棋子干等，手感变差。
 * 800ms 与"AI 思考"的观感同量级，且足以覆盖 Web Worker 的常见就绪时间。
 */
const BRIEF_INIT_WAIT_MS = 800;
/** 启动失败后的冷却：指数退避，封顶 30s（足够覆盖"WebView 被回收后重新加载"） */
function initBackoffMs(attempt: number): number {
  return Math.min(30000, 2000 * 2 ** Math.max(0, attempt - 1));
}

type QueueItem = {
  request: OfflineSearchRequest;
  resolve: (r: OfflineSearchResult) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
};

export class OfflineEngineOrchestrator {
  private primary: OfflineEngine;
  private fallback: OfflineEngine;

  /**
   * 永久不可用：**只**用于"平台/资源根本不支持"这类不会自愈的失败
   * （TransportStartError：无 Worker、WebView 组件缺失等）。
   */
  private permanentlyUnavailable = false;
  private permanentReason: string | null = null;

  /**
   * 启动期的**可重试**失败（超时、承载异常退出）。
   *
   * ⚠️ 为什么不能一次失败就永久放弃（2026-10 实测教训）：
   * 启动失败往往只是**慢**——原生 WebView 要解析 6MB 内联页、或容器被系统回收后
   * 重新挂载。一次超时就永久退回弱 AI，用户会看到"整局都是基础AI"且无法恢复。
   * 现在改为：失败后进入冷却，期间用兜底 AI 保证这一步能走，冷却结束自动重试。
   */
  private initFailures = 0;
  private nextInitAt = 0;
  private lastInitError: string | null = null;

  private caps: EngineCapabilities | null = null;
  private initPromise: Promise<EngineCapabilities> | null = null;

  private queue: QueueItem[] = [];
  private running = false;
  private disposed = false;

  constructor(primary: OfflineEngine, fallback: OfflineEngine) {
    this.primary = primary;
    this.fallback = fallback;
  }

  /** 当前状态（供 UI 展示"本地皮卡鱼/兜底 AI/启动中"） */
  getStatus(): OfflineEngineStatus {
    if (this.permanentlyUnavailable) {
      return { source: 'legacy', capabilities: null, reason: this.permanentReason };
    }
    // 引擎运行期重建期间 caps 会被清空，此时应报"未就绪"而非"就绪"
    if (!this.caps || (this.primary.isReady && !this.primary.isReady())) {
      // 启动中（可能正在重试）：把最近一次失败原因带上，便于排障
      return { source: 'starting', capabilities: null, reason: this.lastInitError };
    }
    return { source: 'pikafish', capabilities: this.caps, reason: null };
  }

  /** 预热：提前把引擎拉起来（后台进行，不阻塞调用方） */
  async warmup(): Promise<void> {
    this.kickInit();
    try {
      await this.initPromise;
    } catch {
      // 失败已记录到 lastInitError；真正的取着法路径会走兜底并在冷却后重试
    }
  }

  /**
   * 在后台把主引擎拉起来（不等待、不抛出）。
   *
   * 关键：**不阻塞当前这一步**。引擎没就绪时调用方直接用兜底 AI 出棋，
   * 引擎在后台就绪后，后续步骤会自动切换到它。
   */
  private kickInit(): void {
    if (this.permanentlyUnavailable || this.disposed) return;
    if (this.initPromise) return; // 已在启动中
    if (Date.now() < this.nextInitAt) return; // 冷却中
    if (this.initFailures >= MAX_INIT_ATTEMPTS) {
      // 连续多次起不来：判定为永久不可用（避免每步都白等一次启动超时）
      this.markPermanentlyUnavailable(
        this.lastInitError ?? `引擎连续 ${MAX_INIT_ATTEMPTS} 次启动失败`
      );
      return;
    }

    this.initPromise = this.primary.init().then(
      (c) => {
        this.caps = c;
        this.initFailures = 0;
        this.lastInitError = null;
        this.initPromise = null;
        return c;
      },
      (err) => {
        this.initPromise = null;
        this.caps = null;
        this.initFailures += 1;
        this.lastInitError = err instanceof Error ? err.message : String(err);
        if (isTransportStartError(err)) {
          // 平台/资源不支持：不会自愈，直接判永久
          this.markPermanentlyUnavailable(this.lastInitError);
        } else {
          // 超时/承载异常：冷却后重试
          this.nextInitAt = Date.now() + initBackoffMs(this.initFailures);
          console.warn(
            `[OfflineEngine] 本地引擎启动失败（第 ${this.initFailures}/${MAX_INIT_ATTEMPTS} 次），` +
              `${initBackoffMs(this.initFailures)}ms 后重试: ${this.lastInitError}`
          );
        }
        throw err;
      }
    );
    // 失败不应变成 unhandled rejection（调用方可能没 await 它）
    this.initPromise.catch(() => {
      /* 已在上面处理 */
    });
  }

  private markPermanentlyUnavailable(reason: string): void {
    if (this.permanentlyUnavailable) return;
    this.permanentlyUnavailable = true;
    this.permanentReason = reason;
    console.warn('[OfflineEngine] 本地皮卡鱼永久不可用，改用兜底 AI:', reason);
    try {
      this.primary.dispose();
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 提交一次搜索。
   *
   * 无论主引擎是否可用，调用方总能拿到结果（或明确的取消错误）：
   * 降级/启动中是**对调用方透明**的，这是本模块最重要的性质。
   */
  search(request: OfflineSearchRequest): Promise<OfflineSearchResult> {
    if (this.disposed) {
      return Promise.reject(new OfflineEngineUnavailableError('编排器已释放'));
    }
    return this.enqueue(request);
  }

  /** 引擎当前是否可直接使用 */
  private isPrimaryUsable(): boolean {
    if (this.permanentlyUnavailable || !this.caps) return false;
    // 引擎运行期重建后 isReady() 为 false，此时不可直接用
    return this.primary.isReady ? this.primary.isReady() : true;
  }

  private async enqueue(request: OfflineSearchRequest): Promise<OfflineSearchResult> {
    return new Promise<OfflineSearchResult>((resolve, reject) => {
      const item: QueueItem = { request, resolve, reject, enqueuedAt: Date.now() };
      this.queue.push(item);
      request.signal?.addEventListener(
        'abort',
        () => {
          const idx = this.queue.indexOf(item);
          if (idx >= 0) {
            // 还在排队：直接移除（尚未占用引擎，无需 stop）
            this.queue.splice(idx, 1);
            reject(abortError());
          }
          // 已在执行：由引擎侧监听同一 signal 负责中止
        },
        { once: true }
      );
      // ⚠️ 必须**延后一个宏任务**再 pump：
      //   同步 pump 会立刻把队首（可能是 ponder）取走执行，导致"同一 tick 内
      //   随后到达的高优先级请求（move/hint）无法插队"——优先级就形同虚设。
      //   现实调用链里 ponder 与 move 往往在同一个事件循环里连续入队，
      //   让出一次宏任务即可让队列先攒齐再按优先级取。
      setTimeout(() => void this.pump(), 0);
    });
  }

  /** 调度循环：取优先级最高的请求执行 */
  private async pump(): Promise<void> {
    if (this.running) return;
    if (this.queue.length === 0) return;
    this.running = true;
    try {
      // 每轮都重新按优先级取，而不是"一次取完"：
      // 若执行期间来了更高优先级的请求，下一轮就能优先处理。
      while (this.queue.length > 0) {
        const item = this.pickNext();
        if (!item) break;
        if (item.request.signal?.aborted) {
          item.reject(abortError());
          continue;
        }
        try {
          const result = await this.execute(item.request);
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** 优先级降序，其次先来先服务（与服务端 pickNextJob 同规则） */
  private pickNext(): QueueItem | null {
    if (this.queue.length === 0) return null;
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i];
      const b = this.queue[best];
      const pa = PURPOSE_PRIORITY[a.request.purpose];
      const pb = PURPOSE_PRIORITY[b.request.purpose];
      if (pa > pb || (pa === pb && a.enqueuedAt < b.enqueuedAt)) best = i;
    }
    const item = this.queue[best];
    this.queue.splice(best, 1);
    return item;
  }

  /**
   * 真正执行：主引擎可用就用它，否则**立刻**用兜底并在后台把引擎拉起来。
   *
   * ⚠️ 刻意**不** `await` 引擎启动（2026-10 实测教训）：
   * 启动可能耗时数十秒（原生 WebView 解析 6MB 内联页）。若在这一步 await，
   * 玩家每走一步都要干等整个启动过程，观感就是"卡死"。
   * 现在：这一步用兜底 AI 立刻出棋，引擎在后台就绪后，**下一步自动切换**。
   */
  private async execute(request: OfflineSearchRequest): Promise<OfflineSearchResult> {
    // 引擎没就绪：先启动，并**短暂**等一会儿
    if (!this.isPrimaryUsable()) {
      this.kickInit();
      // 为什么要等：引擎往往马上就绪（Web Worker 路径通常 <1s）。
      // 不等的话，开局第一步会无谓地用弱 AI 出棋，而玩家其实多等半秒就能拿到
      // 皮卡鱼的水准。等太久又会卡手，所以只给一个很短的上限。
      // ponder（后台预计算）不等 —— 它本来就该让位给正式走子。
      if (this.initPromise && request.purpose !== 'ponder') {
        await Promise.race([
          this.initPromise.catch(() => {
            /* 失败已在 kickInit 里处理 */
          }),
          new Promise<void>((r) => setTimeout(r, BRIEF_INIT_WAIT_MS)),
        ]);
      }
    }

    if (this.isPrimaryUsable()) {
      try {
        const served = await this.primary.search(request);
        // 盖章"本次由主引擎（皮卡鱼）服务"。与下方兜底路径的 servedBy:'legacy' 成对：
        // 只要两条路都显式盖章，上层就永远不必靠"事后查引擎状态"去猜谁算的这一步——
        // 那种猜法在"引擎恰好在兜底搜索期间启动完成"时会把兜底着法误标成皮卡鱼。
        return { ...served, servedBy: 'pikafish' };
      } catch (err) {
        // 取消不是"引擎不可用"，不该影响引擎状态
        if (isAbortError(err)) throw err;
        // 着法层面（BadMove / 守卫拒收）：只影响本次，引擎仍可继续用。
        // ⚠️ 也不能标成 pikafish 成功——这一步实际将由兜底出棋，在下方盖章。
        if (!isEngineUnavailableError(err)) throw err;
        // 运行期失效（搜索超时、承载崩溃）：清 caps，冷却后重试。
        //
        // ⚠️【2026-10 审计 P1】**绝不能在这里调 primary.dispose()**。
        // 本分支的语义是"可恢复的失效"——下面已经把 nextInitAt 设成冷却后的时刻，
        // 准备重新 init；而 PikafishOfflineEngine.dispose() 会把 disposed 置 true，
        // 该标志**全类只写一次、此后永不复位**（init/search/isReady 都以它短路），
        // 于是重试目标被永久报废：每次 kickInit 立刻 reject「引擎已释放」，
        // initFailures 累加到 MAX_INIT_ATTEMPTS 后永久锁定为兜底 AI，
        // 与"冷却后应恢复"的设计意图完全相反（且 WebView 被系统回收后本就能重建）。
        //
        // 引擎自己已经把可恢复状态清理干净了，不需要编排器代劳：
        //   · 搜索超时路径（pikafishLocalEngine.search 的墙钟兜底）已做
        //     caps=null / bootPromise=null / destroyTransport()；
        //   · 承载崩溃走 settleError(e, needRebuild=true)，同样清 caps 与承载。
        // 编排器只需维护自己的退避状态；dispose() 仅用于 markPermanentlyUnavailable
        // 与编排器自身 dispose() 这两个真正终止的场景。
        this.caps = null;
        this.initFailures += 1;
        this.lastInitError = err instanceof Error ? err.message : String(err);
        this.nextInitAt = Date.now() + initBackoffMs(this.initFailures);
        console.warn(
          `[OfflineEngine] 引擎运行期失效（第 ${this.initFailures} 次），` +
            `本次用兜底 AI，${initBackoffMs(this.initFailures)}ms 后重试: ${this.lastInitError}`
        );
      }
    }

    // 引擎仍未就绪（启动中/冷却中）：后台继续拉起来，这一步先用兜底。
    // ⚠️ 兜底结果必须盖 servedBy:'legacy'（2026-10 实测修复）：
    // 上层 UI 靠它区分"真皮卡鱼"与"引擎没起来时的 TS 兜底"——
    // 没有这个标记，界面会把 TS AI 的着法虚报成"本地皮卡鱼"。
    this.kickInit();
    const legacy = await this.fallback.search(request);
    return { ...legacy, servedBy: 'legacy' };
  }

  /** 换局：清空引擎跨局状态与排队中的预计算 */
  newGame(): void {
    const stale = this.queue.splice(0, this.queue.length);
    for (const item of stale) {
      item.reject(abortError());
    }
    try {
      this.primary.newGame();
      this.fallback.newGame();
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 立即重试启动（忽略冷却）。
   *
   * 供"已知引擎可能刚恢复"的时机调用：例如从后台回到前台、或用户手动重开。
   * 有冷却时不必等满退避，用户体验更好；仍受 MAX_INIT_ATTEMPTS 上限约束。
   */
  retryNow(): void {
    if (this.permanentlyUnavailable) return;
    this.nextInitAt = 0;
    this.kickInit();
  }

  /** 中止当前搜索（引擎实现各自处理） */
  stop(): void {
    try {
      this.primary.stop();
      this.fallback.stop();
    } catch {
      /* 忽略 */
    }
  }

  dispose(): void {
    this.disposed = true;
    const stale = this.queue.splice(0, this.queue.length);
    for (const item of stale) {
      item.reject(abortError());
    }
    try {
      this.primary.dispose();
      this.fallback.dispose();
    } catch {
      /* 忽略 */
    }
  }
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

export type { SearchPurpose };
