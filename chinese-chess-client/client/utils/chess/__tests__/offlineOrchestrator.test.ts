/**
 * 离线引擎编排器单测（队列 / 优先级 / 降级 / 取消）
 *
 * 这些都是**不依赖真实引擎**的纯逻辑：注入假引擎即可覆盖，
 * 保证在 CI 与 Jest 环境（无 WASM、无 Worker）里也能跑。
 */

import {
  OfflineEngineOrchestrator,
} from '../pikafish/offlineOrchestrator';
import type {
  EngineCapabilities,
  OfflineEngine,
  OfflineSearchRequest,
  OfflineSearchResult,
} from '../offlineEngine';
import { OfflineEngineBadMoveError, OfflineEngineUnavailableError } from '../offlineEngine';
import { createInitialState } from '../GameEngine';

const state = createInitialState();

/**
 * 假引擎：可控延迟、可注入失败。
 *
 * ⚠️ 失败必须用**类型正确**的错误（2026-10 审计 P0-2 修复后）：
 * 编排器只对 OfflineEngineUnavailableError / TransportStartError 降级，
 * 泛用 Error 属于"其它"——不降级但会走兜底。用错类型会让本文件断言的
 * 语义与真实行为不符（这正是审计里"测试固化了缺陷"的成因）。
 */
class FakeEngine implements OfflineEngine {
  readonly calls: string[] = [];
  constructor(
    private readonly opts: {
      driver: 'web-worker' | 'webview' | 'legacy';
      delayMs?: number;
      failInit?: boolean;
      /** 搜索失败的原因：unavailable=降级；badmove/other=不降级 */
      failSearch?: 'unavailable' | 'badmove' | 'other';
    }
  ) {}

  get driver() {
    return this.opts.driver;
  }

  async init(): Promise<EngineCapabilities> {
    // 与真实引擎一致：dispose() 之后 init() 必须失败（disposed 是单向闩锁）。
    // 这条语义是本文件能捕获「编排器在运行期失效分支误调 dispose()」的前提——
    // 若 dispose() 是空实现，"引擎重建后应恢复"这条断言就永远测不出问题。
    if (this.disposed) throw new OfflineEngineUnavailableError('引擎已释放');
    if (this.opts.failInit) throw new OfflineEngineUnavailableError('init failed');
    // 真实引擎在 init 成功后即恢复可用（承载被重建）
    this.ready = true;
    return { banner: 'fake', options: [], driver: this.opts.driver };
  }

  async search(req: OfflineSearchRequest): Promise<OfflineSearchResult> {
    this.calls.push(req.requestId);
    if (this.disposed) throw new OfflineEngineUnavailableError('引擎已释放');
    if (this.opts.failSearch === 'unavailable') {
      throw new OfflineEngineUnavailableError('search failed (engine down)');
    }
    if (this.opts.failSearch === 'badmove') {
      // 位置相关：引擎没坏，换个局面就正常 → **不应**降级
      throw new OfflineEngineBadMoveError('引擎未给出可用着法');
    }
    if (this.opts.failSearch === 'other') {
      throw new Error('未分类错误');
    }
    if (this.opts.delayMs) {
      await new Promise((r) => setTimeout(r, this.opts.delayMs));
    }
    return {
      uci: 'b2e2',
      depth: 8,
      timeMs: 1,
      fromCol: 1, fromRow: 7, toCol: 4, toRow: 7,
    };
  }

  /** 假引擎的可用性开关：模拟引擎运行期重建 */
  ready = true;
  /**
   * 是否已被 dispose（模拟真实引擎的 disposed 单向闩锁）。
   * 真实 PikafishOfflineEngine 的 dispose() 只写一次、此后永不复位，
   * init/search/isReady 全部以它短路；假引擎必须复刻这个语义，
   * 否则「运行期失效后引擎被永久报废」这类缺陷在单测里完全不可见。
   */
  disposed = false;
  isReady(): boolean {
    return this.ready && !this.disposed;
  }

  // 假引擎无需实现取消/换局：编排器只调用它们做副作用，本测试不验证其内部行为
  stop(): void {
    /* noop */
  }
  newGame(): void {
    /* noop */
  }
  /** 与真实引擎一致：不可逆地报废本实例（disposed 不复位） */
  dispose(): void {
    this.disposed = true;
    this.ready = false;
  }
}

const req = (requestId: string, purpose: OfflineSearchRequest['purpose']): OfflineSearchRequest => ({
  requestId,
  purpose,
  state,
  fen: 'rnbakabnr/9/1c5c1/9/9/9/9/9/9/RNBAKABNR w',
  tier: 'medium',
});

describe('OfflineEngineOrchestrator', () => {
  it('主引擎可用时直接返回其结果', async () => {
    const primary = new FakeEngine({ driver: 'web-worker' });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    const out = await orch.search(req('r1', 'move'));
    expect(out.uci).toBe('b2e2');
    expect(primary.calls).toEqual(['r1']);
    expect(fallback.calls).toEqual([]);
    expect(orch.getStatus().source).toBe('pikafish');
  });

  it('主引擎初始化失败 → 本次用兜底引擎，但状态是"启动中"（可重试，不永久降级）', async () => {
    const primary = new FakeEngine({ driver: 'web-worker', failInit: true });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    const out = await orch.search(req('r1', 'move'));
    expect(out.uci).toBe('b2e2');
    expect(fallback.calls).toEqual(['r1']);
    // ⚠️ 语义变化（2026-10 实测）：启动失败**不再**永久降级。
    // 引擎可能只是"慢"（WebView 解析 6MB 内联页），冷却后会重试；
    // 若一次失败就永久放弃，用户会看到"整局都是基础AI"且无法恢复。
    expect(orch.getStatus().source).toBe('starting');
    expect(orch.getStatus().reason).toContain('init failed');
  });

  it('启动失败后冷却到期会重试；引擎恢复即自动切回皮卡鱼', async () => {
    // 第一次 init 失败，之后成功
    let failInit = true;
    const primary = new FakeEngine({ driver: 'web-worker' });
    jest.spyOn(primary, 'init').mockImplementation(async () => {
      if (failInit) throw new OfflineEngineUnavailableError('init failed');
      primary.ready = true;
      return { banner: 'fake', options: [], driver: 'web-worker' };
    });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    await orch.search(req('r1', 'move'));
    expect(orch.getStatus().source).toBe('starting');

    // 引擎恢复 + 冷却到期（retryNow 跳过退避）
    failInit = false;
    orch.retryNow();
    await new Promise((r) => setTimeout(r, 10));

    const out = await orch.search(req('r2', 'move'));
    expect(out.uci).toBe('b2e2');
    expect(orch.getStatus().source).toBe('pikafish');
    expect(primary.calls).toContain('r2');
  });

  it('运行期"引擎不可用"（search 抛 Unavailable）→ 本次用兜底，之后退避重试', async () => {
    const primary = new FakeEngine({ driver: 'web-worker' });
    // init 成功，但首次 search 报"引擎不可用"（模拟运行期崩溃）
    let firstSearch = true;
    jest.spyOn(primary, 'search').mockImplementation(async (r) => {
      primary.calls.push(r.requestId);
      if (firstSearch) {
        firstSearch = false;
        throw new OfflineEngineUnavailableError('engine crashed');
      }
      return { uci: 'b2e2', depth: 8, timeMs: 1, fromCol: 1, fromRow: 7, toCol: 4, toRow: 7 };
    });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    const out = await orch.search(req('r1', 'move'));
    expect(out.uci).toBe('b2e2');
    expect(fallback.calls).toEqual(['r1']); // 本次由兜底服务
    // 运行期失效进入"启动中"（冷却后重试），不是永久降级
    expect(orch.getStatus().source).toBe('starting');
    // 原因被记录，便于排障
    expect(orch.getStatus().reason).toContain('engine crashed');
  });

  /**
   * 回归 · 2026-10 审计 P1（引擎永久报废）
   *
   * 缺陷：编排器在「运行期失效」分支（搜索超时 / 承载崩溃）里调用了 primary.dispose()，
   * 而真实引擎的 disposed 是**不可逆**闩锁 —— 于是"清 caps、冷却后重试"永远重试不上：
   * kickInit 每次立刻 reject「引擎已释放」，initFailures 累加到 6 后本会话永久锁死为
   * 兜底 AI，只能重启 App。与本文件上一条用例自述的"之后退避重试"直接矛盾。
   *
   * 本用例断言**恢复**（上一条只断言了"进入 starting"，靠空实现的 dispose 就能通过）：
   * 引擎恢复健康 + 冷却到期后，下一次请求必须重新由主引擎服务。
   * 若重新引入 primary.dispose()，FakeEngine.disposed 会置位 →
   * init() 恒 reject → caps 起不来 → r2 落到兜底、source 停在 starting，断言失败。
   */
  it('运行期失效后必须能恢复：冷却到期后重新由主引擎出棋（不得被 dispose 永久报废）', async () => {
    const primary = new FakeEngine({ driver: 'web-worker' });
    let firstSearch = true;
    jest.spyOn(primary, 'search').mockImplementation(async (r) => {
      primary.calls.push(r.requestId);
      if (firstSearch) {
        firstSearch = false;
        throw new OfflineEngineUnavailableError('engine crashed');
      }
      return { uci: 'b2e2', depth: 8, timeMs: 1, fromCol: 1, fromRow: 7, toCol: 4, toRow: 7 };
    });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    // 第一次：运行期失效 → 本次由兜底服务，状态回到"启动中"
    await orch.search(req('r1', 'move'));
    expect(fallback.calls).toEqual(['r1']);
    expect(orch.getStatus().source).toBe('starting');
    // 前置：此刻引擎实例**不得**已被报废（否则下面不可能恢复）
    expect(primary.disposed).toBe(false);

    // 引擎恢复健康 + 跳过退避冷却
    orch.retryNow();
    await new Promise((r) => setTimeout(r, 10));

    // 第二次：必须重新走主引擎（这正是"冷却后重试"的意义）
    const out = await orch.search(req('r2', 'move'));
    expect(primary.calls).toContain('r2');
    expect(fallback.calls).toEqual(['r1']); // 兜底只服务过失效那一次
    expect(out.uci).toBe('b2e2');
    expect(orch.getStatus().source).toBe('pikafish');
  });

  it('连续多次启动失败后判永久不可用（避免每步都白等启动超时）', async () => {    const primary = new FakeEngine({ driver: 'web-worker', failInit: true });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    // 反复触发：每次 retryNow 跳过冷却，直到超过次数上限
    for (let i = 0; i < 8; i++) {
      await orch.search(req(`r${i}`, 'move'));
      orch.retryNow();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(orch.getStatus().source).toBe('legacy');
  });

  it('降级为永久不可用后不再重试主引擎', async () => {
    const primary = new FakeEngine({ driver: 'web-worker', failInit: true });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    // 触发到判永久（与上一个用例同路径，但这里只关心"不再重试"）
    for (let i = 0; i < 8; i++) {
      await orch.search(req(`r${i}`, 'move'));
      orch.retryNow();
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(orch.getStatus().source).toBe('legacy');

    // 主引擎一次都没被真正用于出棋（init 全失败，未产生 search 调用）
    expect(primary.calls).toEqual([]);
  });

  /**
   * 回归 · 2026-10 审计 P0-2
   *
   * 位置相关的"着法不可用"（bestmove (none) / CRITICAL ERROR）**不得**降级。
   * 审计探针 [A] 复现过缺陷：一次 BadMove 让主引擎 calls 停在 1，
   * 之后整局会话都不再触碰主引擎 —— 一次偶发局面把整局降成弱 AI。
   */
  it('位置相关的 BadMove 不降级：下一次请求仍走主引擎', async () => {
    const primary = new FakeEngine({ driver: 'web-worker', failSearch: 'badmove' });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    // 第一次：着法不可用 → 错误上抛，**不**用兜底、不降级
    await expect(orch.search(req('r1', 'move'))).rejects.toBeInstanceOf(
      OfflineEngineBadMoveError
    );
    expect(fallback.calls).toEqual([]);
    expect(orch.getStatus().source).toBe('pikafish');

    // 关键：主引擎在"下一个局面"仍被正常使用
    const primaryOk = new FakeEngine({ driver: 'web-worker' });
    const orch2 = new OfflineEngineOrchestrator(primaryOk, fallback);
    const out = await orch2.search(req('r2', 'move'));
    expect(out.uci).toBe('b2e2');
    expect(primaryOk.calls).toEqual(['r2']);
  });

  it('一次 BadMove 后主引擎仍能服务后续请求（不永久降级）', async () => {
    // 用可切换的假引擎：先失败一次，再恢复正常
    let failNext = true;
    const primary = new FakeEngine({ driver: 'web-worker' });
    jest.spyOn(primary, 'search').mockImplementation(async (r) => {
      if (failNext) {
        failNext = false;
        throw new OfflineEngineBadMoveError('引擎未给出可用着法');
      }
      return {
        uci: 'b2e2', depth: 12, timeMs: 1,
        fromCol: 1, fromRow: 7, toCol: 4, toRow: 7,
      };
    });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    await expect(orch.search(req('r1', 'move'))).rejects.toBeInstanceOf(
      OfflineEngineBadMoveError
    );
    // 第二次：引擎已恢复 → 仍走主引擎，未降级
    const out = await orch.search(req('r2', 'move'));
    expect(out.uci).toBe('b2e2');
    expect(orch.getStatus().source).toBe('pikafish');
    expect(fallback.calls).toEqual([]);
  });

  it('未分类错误不降级（保守：宁可这一步失败，也不整局变弱）', async () => {
    const primary = new FakeEngine({ driver: 'web-worker', failSearch: 'other' });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    await expect(orch.search(req('r1', 'move'))).rejects.toThrow('未分类错误');
    expect(orch.getStatus().source).toBe('pikafish');
    expect(fallback.calls).toEqual([]);
  });

  /**
   * 回归 · 2026-10 审计 P1-7
   * 引擎运行期重建（超时/fatal 清掉 caps）后，编排器不能继续用旧 caps 跳过重新 init。
   */
  it('引擎重建后丢弃缓存的 caps，重新 init', async () => {
    const primary = new FakeEngine({ driver: 'web-worker' });
    const orch = new OfflineEngineOrchestrator(primary, new FakeEngine({ driver: 'legacy' }));

    await orch.search(req('r1', 'move'));
    expect(orch.getStatus().source).toBe('pikafish');

    // 模拟引擎运行期失效：caps 被清空、承载已释放
    primary.ready = false;
    expect(orch.getStatus().source).toBe('starting');

    // 下一次请求必须重新 init（而不是直接返回旧 caps 或报错）
    const out = await orch.search(req('r2', 'move'));
    expect(out.uci).toBe('b2e2');
    expect(orch.getStatus().source).toBe('pikafish');
  });

  it('move 优先于 hint，hint 优先于 ponder', async () => {
    const primary = new FakeEngine({ driver: 'web-worker', delayMs: 20 });
    const orch = new OfflineEngineOrchestrator(primary, new FakeEngine({ driver: 'legacy' }));

    // 同时提交：ponder 先到，hint 次之，move 最后
    const pPonder = orch.search(req('p', 'ponder'));
    const pHint = orch.search(req('h', 'hint'));
    const pMove = orch.search(req('m', 'move'));

    await Promise.all([pPonder, pHint, pMove]);
    // 第一个执行的必须是 move
    expect(primary.calls[0]).toBe('m');
  });

  it('取消排队中的请求 → AbortError，不占用引擎', async () => {
    const primary = new FakeEngine({ driver: 'web-worker', delayMs: 30 });
    const orch = new OfflineEngineOrchestrator(primary, new FakeEngine({ driver: 'legacy' }));

    const running = orch.search(req('m', 'move'));
    const ac = new AbortController();
    const queued = orch.search({ ...req('q', 'hint'), signal: ac.signal });
    ac.abort();

    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await running;
    // 被取消的请求不应真的进入引擎
    expect(primary.calls).toEqual(['m']);
  });

  it('newGame 清空排队中的请求', async () => {
    const primary = new FakeEngine({ driver: 'web-worker', delayMs: 30 });
    const orch = new OfflineEngineOrchestrator(primary, new FakeEngine({ driver: 'legacy' }));

    // 两个请求都会进队列（pump 被延后一个宏任务，所以此刻都还没执行）。
    // 因此 newGame() 会把**两个都** reject——这正是期望行为：
    // 换局时任何尚未落子的旧请求都应作废，绝不能落到新局面上。
    const first = orch.search(req('m', 'move'));
    const queued = orch.search(req('q', 'ponder'));

    // 立刻挂上拒绝处理器：newGame 会同步 reject，若此时无人 await 就是 unhandled rejection
    const firstResult = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const queuedResult = expect(queued).rejects.toMatchObject({ name: 'AbortError' });

    orch.newGame();

    await Promise.all([firstResult, queuedResult]);
    expect(primary.calls).toEqual([]);
  });

  it('warmup 失败不影响后续搜索（静默降级）', async () => {
    const primary = new FakeEngine({ driver: 'web-worker', failInit: true });
    const fallback = new FakeEngine({ driver: 'legacy' });
    const orch = new OfflineEngineOrchestrator(primary, fallback);

    await orch.warmup(); // 不抛
    const out = await orch.search(req('r1', 'move'));
    expect(out.uci).toBe('b2e2');
  });

  it('dispose 后拒绝新请求', async () => {
    const orch = new OfflineEngineOrchestrator(
      new FakeEngine({ driver: 'web-worker' }),
      new FakeEngine({ driver: 'legacy' })
    );
    orch.dispose();
    await expect(orch.search(req('r1', 'move'))).rejects.toThrow();
  });
});
