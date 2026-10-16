/**
 * 本地皮卡鱼引擎 ↔ 承载层的接缝测试
 *
 * 用假 Transport 驱动**真实的** PikafishOfflineEngine，验证：
 *   1. init 握手（bootstrap → ready）与能力解析；
 *   2. 下发的 UCI 命令序列与档位**逐字段对应**（easy 必须是 MultiPV 2，其余 1）；
 *   3. 结果解析（bestmove → 内部坐标）与 depth/timeMs 透传；
 *   4. 迟到结果（seq 不匹配）被丢弃；
 *   5. 致命错误 / bestmove 缺失 → 报错并标记需重建；
 *   6. 历史优先于 fen；非法 UCI 历史降级为只按 fen 搜；
 *   7. 取消（abort）使本次请求作废并下发 stop；
 *   8. 承载启动失败 / 启动超时 → OfflineEngineUnavailableError。
 *
 * 真实 WASM 引擎的运行验证由 scripts 下的产物校验 + 手工冒烟覆盖，
 * 这里聚焦"协议与调度"，因此可在 Jest（无 WASM/Worker）下运行。
 */

import { PikafishOfflineEngine } from '../pikafish/pikafishLocalEngine';
import type { EngineTransport, HostInbound, HostOutbound, HostSearchMessage } from '../pikafish/engineTransport';
import { TransportStartError } from '../pikafish/engineTransport';
import { createInitialState } from '../GameEngine';
import { OfflineEngineBadMoveError, OfflineEngineUnavailableError } from '../offlineEngine';
import type { AIDifficulty } from '../types';

const state = createInitialState();
const FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

/** 可编程的假承载：记录下行消息，可主动回放上行消息 */
class FakeTransport implements EngineTransport {
  readonly kind = 'web-worker' as const;
  readonly sent: Array<HostInbound | HostSearchMessage> = [];
  started = false;
  disposed = false;
  msgCb: ((m: HostOutbound) => void) | null = null;
  deadCb: ((reason: string) => void) | null = null;
  /** 构造时抛错，模拟"平台不支持" */
  failOnStart: string | null = null;
  /** 构造时抛错，模拟资源缺失 */
  throwOnCreate: Error | null = null;

  start(onReady?: () => void): void {
    if (this.failOnStart) throw new TransportStartError(this.failOnStart);
    this.started = true;
    // ⚠️ 必须遵守 start(onReady) 契约（2026-10 审计 P0-1 修复）：
    //    启动层把 bootstrap 的下发挂在 onReady 上，承载不回调就永远发不出去。
    //    这里模拟 Worker：脚本已在浏览器的 postMessage 队列中，立即就绪。
    onReady?.();
  }
  /** 与真实 Worker 承载同构：bootstrap 携带 wasm/nnue URL（假实现给可辨识的 mock 值） */
  bootstrapMessage(): HostInbound {
    return {
      type: 'bootstrap',
      wasmUrl: 'mock://pikafish.wasm',
      nnueUrl: 'mock://pikafish.nnue',
    };
  }
  send(msg: HostInbound | HostSearchMessage): void {
    this.sent.push(msg);
  }
  onMessage(cb: (m: HostOutbound) => void): void {
    this.msgCb = cb;
  }
  onDead(cb: (reason: string) => void): void {
    this.deadCb = cb;
  }
  dispose(): void {
    this.disposed = true;
  }

  /** 回放上行消息 */
  emit(m: HostOutbound): void {
    this.msgCb?.(m);
  }

  /** 取最后一次 search 的命令序列 */
  lastCommands(): string[] {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i] as HostSearchMessage;
      if (m.type === 'search') return m.commands;
    }
    return [];
  }
}

/** 创建一个已握手就绪的引擎（自动回 host-loaded + ready） */
async function bootEngine(): Promise<{ engine: PikafishOfflineEngine; t: FakeTransport }> {
  const t = new FakeTransport();
  const engine = new PikafishOfflineEngine(() => t);
  const p = engine.init();
  // bootstrap 已在 start() 后下发；模拟承载回握手成功
  await Promise.resolve();
  t.emit({ type: 'host-loaded' });
  t.emit({ type: 'ready', banner: 'Pikafish test', options: ['MultiPV', 'Threads', 'Hash'] });
  await p;
  return { engine, t };
}

const searchReq = (tier: AIDifficulty | 'hint') => ({
  requestId: 'r1',
  purpose: (tier === 'hint' ? 'hint' : 'move') as 'move' | 'hint',
  state,
  fen: FEN,
  tier,
});

describe('PikafishOfflineEngine：握手与能力', () => {
  it('init：下发 bootstrap 并解析 banner/options/driver', async () => {
    const { engine, t } = await bootEngine();
    // doBoot 会用承载的 bootstrapMessage()（若实现）——假承载返回带 URL 的完整消息，
    // 因此这里断言的是"契约形状"，而不是写死 {type:'bootstrap'}。
    expect(t.sent[0]).toEqual({
      type: 'bootstrap',
      wasmUrl: 'mock://pikafish.wasm',
      nnueUrl: 'mock://pikafish.nnue',
    });
    const caps = await engine.init();
    expect(caps.banner).toBe('Pikafish test');
    expect(caps.options).toEqual(['MultiPV', 'Threads', 'Hash']);
    expect(caps.driver).toBe('web-worker');
    engine.dispose();
  });

  it('承载启动失败 → TransportStartError（保留原类型，便于上层区分"平台不支持"与"引擎崩了"）', async () => {
    const t = new FakeTransport();
    t.failOnStart = 'Worker 不可用';
    const engine = new PikafishOfflineEngine(() => t);
    await expect(engine.init()).rejects.toBeInstanceOf(TransportStartError);
  });

  it('承载工厂抛错 → 包装为 OfflineEngineUnavailableError', async () => {
    const engine = new PikafishOfflineEngine(() => {
      throw new Error('资产缺失');
    });
    await expect(engine.init()).rejects.toBeInstanceOf(OfflineEngineUnavailableError);
  });

  it('承载在握手前死亡 → 报错', async () => {
    const t = new FakeTransport();
    const engine = new PikafishOfflineEngine(() => t);
    const p = engine.init();
    // ⚠️ 承载工厂现在是**异步**的（原生端要经 expo-asset 把 wasm/nnue 资源
    //    解析成 file:// URI），onDead 回调是在 await 之后才注册的。
    //    所以"承载刚建好就死亡"必须让出一个微任务再触发，否则回调还没接上、
    //    死亡事件会被静默丢失（这正是本用例要防的丢事件场景）。
    await Promise.resolve();
    t.deadCb?.('Worker 崩溃');
    await expect(p).rejects.toBeInstanceOf(OfflineEngineUnavailableError);
  });

  it('承载工厂是异步的：await 之后才建承载，握手仍能正常完成', async () => {
    const t = new FakeTransport();
    // 异步工厂：模拟原生端"先经 expo-asset 解析 file:// URI、再建承载"的真实时序
    const engine = new PikafishOfflineEngine(async () => {
      await Promise.resolve();
      return t;
    });
    const p = engine.init();
    // 工厂尚未 resolve：此刻引擎还没注册 onMessage/onDead，
    // 过早触发的消息理应被忽略（不应让它把启动带崩）。
    t.emit({ type: 'ready', banner: '过早的 ready', options: [] });

    // 等工厂 resolve、引擎注册好回调并 start（Worker 承载 start 即就绪 →
    // onReady 触发 → 下发 bootstrap）。此时承载已准备好，回一个真正的 ready。
    await new Promise((r) => setTimeout(r, 0));
    t.emit({ type: 'ready', banner: 'Pikafish async', options: [] });

    const caps = await p;
    // 必须是工厂 resolve 之后那一条 ready。早发的那条若被误接收会拿到错 banner。
    expect(caps.banner).toBe('Pikafish async');
    engine.dispose();
  });
});

describe('PikafishOfflineEngine：命令序列与档位对应', () => {
  it('easy 档下发 MultiPV 2 且 randomPick=true', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search(searchReq('easy'));
    const search = t.sent.find((m) => m.type === 'search') as HostSearchMessage;
    expect(search.randomPick).toBe(true);
    expect(search.commands).toContain('setoption name MultiPV value 2');
    expect(search.commands[0]).toBe('ucinewgame');
    t.emit({ type: 'result', seq: 1, result: { uci: 'b2e2', depth: 4, candidates: ['b2e2'], timeMs: 5 } });
    const r = await p;
    expect(r.depth).toBe(4);
    engine.dispose();
  });

  it('medium/hard/hint 档下发 MultiPV 1 且 randomPick=false', async () => {
    for (const tier of ['medium', 'hard', 'hint'] as const) {
      const { engine, t } = await bootEngine();
      const p = engine.search(searchReq(tier));
      const search = t.sent.find((m) => m.type === 'search') as HostSearchMessage;
      expect(search.randomPick).toBe(false);
      expect(search.commands).toContain('setoption name MultiPV value 1');
      t.emit({ type: 'result', seq: 1, result: { uci: 'b2e2', depth: 8, candidates: ['b2e2'], timeMs: 1 } });
      await p;
      engine.dispose();
    }
  });

  it('档位 depth 逐档对应（与服务端同源）', async () => {
    const expected: Record<string, number> = { easy: 4, medium: 8, hard: 12, hint: 8 };
    for (const [tier, depth] of Object.entries(expected)) {
      const { engine, t } = await bootEngine();
      const p = engine.search(searchReq(tier as AIDifficulty | 'hint'));
      const search = t.sent.find((m) => m.type === 'search') as HostSearchMessage;
      expect(search.commands.join(' ')).toContain(`depth ${depth}`);
      t.emit({ type: 'result', seq: 1, result: { uci: 'b2e2', depth, candidates: ['b2e2'], timeMs: 1 } });
      await p;
      engine.dispose();
    }
  });

  it('go 命令同时带 depth 与 movetime（墙钟兜底）', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search(searchReq('hard'));
    const go = t.lastCommands().find((c) => c.startsWith('go '));
    expect(go).toMatch(/depth 12/);
    expect(go).toMatch(/movetime \d+/);
    t.emit({ type: 'result', seq: 1, result: { uci: 'b2e2', depth: 12, candidates: ['b2e2'], timeMs: 1 } });
    await p;
    engine.dispose();
  });

  it('searchmoves 白名单原样下发', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search({
      ...searchReq('medium'),
      searchmoves: ['h2e2', 'b2e2'],
    });
    expect(t.lastCommands().join(' ')).toContain('searchmoves h2e2 b2e2');
    t.emit({ type: 'result', seq: 1, result: { uci: 'b2e2', depth: 8, candidates: ['b2e2'], timeMs: 1 } });
    await p;
    engine.dispose();
  });
});

describe('PikafishOfflineEngine：局面与历史', () => {
  it('无历史时只按 fen 设置局面', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search(searchReq('medium'));
    expect(t.lastCommands().some((c) => c === `position fen ${FEN}`)).toBe(true);
    t.emit({ type: 'result', seq: 1, result: { uci: 'b2e2', depth: 8, candidates: ['b2e2'], timeMs: 1 } });
    await p;
    engine.dispose();
  });

  it('有合法历史时用 startFen + moves（不再带 fen）', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search({
      ...searchReq('medium'),
      history: { startFen: FEN, moves: ['h2e2', 'h9g7'] },
    });
    const pos = t.lastCommands().find((c) => c.startsWith('position ')) as string;
    expect(pos).toBe(`position fen ${FEN} moves h2e2 h9g7`);
    t.emit({ type: 'result', seq: 1, result: { uci: 'b0c2', depth: 8, candidates: ['b0c2'], timeMs: 1 } });
    await p;
    engine.dispose();
  });

  it('历史含非法 UCI → 降级为只按 fen 搜（不把脏数据喂给引擎）', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search({
      ...searchReq('medium'),
      history: { startFen: FEN, moves: ['h2e2', 'BAD!!'] },
    });
    expect(t.lastCommands().some((c) => c === `position fen ${FEN}`)).toBe(true);
    t.emit({ type: 'result', seq: 1, result: { uci: 'b2e2', depth: 8, candidates: ['b2e2'], timeMs: 1 } });
    await p;
    engine.dispose();
  });
});

describe('PikafishOfflineEngine：结果解析与异常', () => {
  it('bestmove 换算为内部坐标并透传 depth/timeMs', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search(searchReq('medium'));
    // h2e2 → fromCol 7, fromRow 9-2=7; toCol 4, toRow 9-2=7
    // （UCI rank 2 是红方第三横线，对应内部 row 7；不是 row 4）
    t.emit({ type: 'result', seq: 1, result: { uci: 'h2e2', depth: 8, candidates: ['h2e2'], timeMs: 33 } });
    const r = await p;
    expect(r).toEqual({
      uci: 'h2e2',
      depth: 8,
      timeMs: 33,
      fromCol: 7, fromRow: 7, toCol: 4, toRow: 7,
    });
    engine.dispose();
  });

  it('迟到的结果（seq 不匹配）被丢弃，不会误结算', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search(searchReq('medium'));
    // 先来一条 seq=99 的过期结果
    t.emit({ type: 'result', seq: 99, result: { uci: 'a0a1', depth: 1, candidates: ['a0a1'], timeMs: 1 } });
    // 再来正确的
    t.emit({ type: 'result', seq: 1, result: { uci: 'h2e2', depth: 8, candidates: ['h2e2'], timeMs: 1 } });
    const r = await p;
    expect(r.uci).toBe('h2e2');
    engine.dispose();
  });

  it('fatal（CRITICAL ERROR）→ OfflineEngineBadMoveError 且实例被丢弃', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search(searchReq('medium'));
    t.emit({ type: 'result', seq: 1, result: { uci: '', depth: 0, candidates: [], timeMs: 0 }, fatal: true });
    await expect(p).rejects.toBeInstanceOf(OfflineEngineBadMoveError);
    expect(t.disposed).toBe(true); // 实例已重建/释放
    engine.dispose();
  });

  it('bestmove 为空（无候选）→ 报错，不凭空造落点', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search(searchReq('medium'));
    t.emit({ type: 'result', seq: 1, result: { uci: '', depth: 3, candidates: [], timeMs: 1 } });
    await expect(p).rejects.toBeInstanceOf(OfflineEngineBadMoveError);
    engine.dispose();
  });

  /**
   * 回归 · 2026-10 实测（"开局首步太慢"的深层原因）
   *
   * 'engine busy' 是**占用中**（上一次同步搜索还在跑），不是引擎坏了。
   * 曾被当成"不可用"→ 销毁重建 → 手机上重拉 4.5MB 资源，首步雪崩。
   */
  it("'engine busy' → BadMove（不重建实例），引擎保留待下一次", async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search(searchReq('medium'));
    t.emit({ type: 'error', message: 'engine busy' });
    await expect(p).rejects.toBeInstanceOf(OfflineEngineBadMoveError);
    // 关键：没有销毁承载（disposed 仍为 false），下次搜索还能用同一实例
    expect(t.disposed).toBe(false);
    // 下一次 search 仍能正常下发
    const p2 = engine.search(searchReq('medium'));
    expect(t.sent.filter((m) => m.type === 'search')).toHaveLength(2);
    t.emit({ type: 'result', seq: 2, result: { uci: 'h2e2', depth: 8, candidates: ['h2e2'], timeMs: 1 } });
    await expect(p2).resolves.toBeDefined();
    engine.dispose();
  });

  it('movetimeCapMs 会压低 go 的 movetime（ponder 预算），但不超过档位值', async () => {
    const { engine, t } = await bootEngine();
    // hint 档 movetimeMs=8000，cap 2500 → 取 2500
    const p = engine.search({ ...searchReq('hint'), purpose: 'ponder', movetimeCapMs: 2500 });
    const go = t.lastCommands().find((c) => c.startsWith('go ')) as string;
    expect(go).toContain('movetime 2500');
    t.emit({ type: 'result', seq: 1, result: { uci: 'h2e2', depth: 8, candidates: ['h2e2'], timeMs: 1 } });
    await p;

    // cap 比档位还大时不放大（easy 档 5000，cap 99999 → 仍 5000）
    const p2 = engine.search({ ...searchReq('easy'), movetimeCapMs: 99999 });
    const go2 = t.lastCommands().find((c) => c.startsWith('go ')) as string;
    expect(go2).toContain('movetime 5000');
    t.emit({ type: 'result', seq: 2, result: { uci: 'h2e2', depth: 4, candidates: ['h2e2'], timeMs: 1 } });
    await p2;
    engine.dispose();
  });

  it('非法 UCI → 报错', async () => {
    const { engine, t } = await bootEngine();
    const p = engine.search(searchReq('medium'));
    t.emit({ type: 'result', seq: 1, result: { uci: 'ZZ9ZZ', depth: 1, candidates: ['ZZ9ZZ'], timeMs: 1 } });
    await expect(p).rejects.toBeInstanceOf(OfflineEngineBadMoveError);
    engine.dispose();
  });

  it('未初始化就 search → 拒绝', async () => {
    const engine = new PikafishOfflineEngine(() => new FakeTransport());
    await expect(engine.search(searchReq('medium'))).rejects.toBeInstanceOf(
      OfflineEngineUnavailableError
    );
  });

  it('并发第二次 search 被拒（编排器应保证串行）', async () => {
    const { engine, t } = await bootEngine();
    const first = engine.search({ ...searchReq('medium'), requestId: 'a' });
    await expect(engine.search({ ...searchReq('medium'), requestId: 'b' })).rejects.toBeInstanceOf(
      OfflineEngineUnavailableError
    );
    t.emit({ type: 'result', seq: 1, result: { uci: 'h2e2', depth: 8, candidates: ['h2e2'], timeMs: 1 } });
    await first;
    engine.dispose();
  });
});

describe('PikafishOfflineEngine：取消与释放', () => {
  it('abort：请求作废并下发 stop', async () => {
    const { engine, t } = await bootEngine();
    const ac = new AbortController();
    const p = engine.search({ ...searchReq('medium'), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.sent.some((m) => m.type === 'stop')).toBe(true);
    engine.dispose();
  });

  it('已 aborted 的 signal：立即拒绝且不下发搜索', async () => {
    const { engine, t } = await bootEngine();
    const ac = new AbortController();
    ac.abort();
    await expect(
      engine.search({ ...searchReq('medium'), signal: ac.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.sent.some((m) => m.type === 'search')).toBe(false);
    engine.dispose();
  });

  it('dispose：释放承载；此后 search 拒绝', async () => {
    const { engine, t } = await bootEngine();
    engine.dispose();
    expect(t.disposed).toBe(true);
    await expect(engine.search(searchReq('medium'))).rejects.toBeInstanceOf(
      OfflineEngineUnavailableError
    );
  });
});
