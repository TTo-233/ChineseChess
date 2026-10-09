/**
 * 真实承载层的契约测试（2026-10 实测回归）
 *
 * ============================================================================
 * 【这次事故的教训】
 *
 * P0-1 修复引入了 `EngineTransport.start(onReady)` 契约，启动层
 * （PikafishOfflineEngine.doBoot）把 `bootstrap` 的下发挂在 onReady 里。
 * 当时更新了接口、WebView 承载、以及测试用的假承载，**唯独漏了真实的
 * Web Worker 承载** —— 它仍是 `start()` 且从不回调 onReady。
 *
 * 后果：Web 端 bootstrap 永远发不出去 → 引擎永不握手 → 20s 启动超时 →
 * 永久降级到兜底 AI（用户实测就是"基础AI"）。而全部单测都通过，
 * 因为假承载照契约回调了 onReady —— **测试覆盖了契约，却没覆盖实现**。
 *
 * 本文件因此改为直接测**真实实现**（用桩替掉 global.Worker），
 * 保证"契约在实现里 тоже 成立"，而不只是在假对象里成立。
 */

import { createWebWorkerTransport } from '../pikafish/webWorkerTransport';

// 桩：捕获 new Worker(...) 与 postMessage，并可手动回放上行消息
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly posted: unknown[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message?: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor(public readonly url: string) {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** 模拟承载上行消息 */
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const g = globalThis as unknown as { Worker?: unknown };

beforeEach(() => {
  FakeWorker.instances = [];
  g.Worker = FakeWorker as unknown as typeof Worker;
});

afterEach(() => {
  delete g.Worker;
});

describe('WebWorkerTransport 契约（真实实现）', () => {
  it('start(onReady) 必须回调 onReady —— 否则 bootstrap 永远发不出去', () => {
    const t = createWebWorkerTransport('/assets/?unstable_path=x.bin', {
      wasmUrl: '/assets/?unstable_path=x.wasm',
      nnueUrl: '/assets/?unstable_path=x.nnue',
    });

    let readyFired = false;
    t.onMessage(() => {
      /* noop */
    });
    t.onDead(() => {
      /* noop */
    });
    t.start(() => {
      readyFired = true;
      t.send({ type: 'bootstrap' });
    });

    // 这是本次事故的核心断言
    expect(readyFired).toBe(true);

    // 且 bootstrap 确实 postMessage 进了 Worker
    const w = FakeWorker.instances[0];
    expect(w).toBeDefined();
    expect(w.posted).toContainEqual({ type: 'bootstrap' });
  });

  it('不传 onReady 时不报错（兼容旧调用）', () => {
    const t = createWebWorkerTransport('/x.bin', { wasmUrl: '/x.wasm', nnueUrl: '/x.nnue' });
    t.onMessage(() => {
      /* noop */
    });
    expect(() => t.start()).not.toThrow();
  });

  it('bootstrapMessage 必须带上 wasm/nnue URL（Worker 靠它 fetch 二进制，不再内联 base64）', () => {
    const t = createWebWorkerTransport('/x.bin', {
      wasmUrl: '/a/pikafish.wasm',
      nnueUrl: '/a/pikafish.nnue',
    });
    expect(t.bootstrapMessage).toBeDefined();
    expect(t.bootstrapMessage?.()).toEqual({
      type: 'bootstrap',
      wasmUrl: '/a/pikafish.wasm',
      nnueUrl: '/a/pikafish.nnue',
    });
  });

  it('端到端：onReady 下发的 bootstrap 必须携带二进制 URL', () => {
    const t = createWebWorkerTransport('/x.bin', {
      wasmUrl: '/a/pikafish.wasm',
      nnueUrl: '/a/pikafish.nnue',
    });
    t.onMessage(() => {
      /* noop */
    });
    t.onDead(() => {
      /* noop */
    });
    // 模拟 doBoot：在 onReady 里下发承载自带的 bootstrap 消息
    t.start(() => {
      t.send(t.bootstrapMessage ? t.bootstrapMessage() : { type: 'bootstrap' });
    });

    expect(FakeWorker.instances[0].posted).toContainEqual({
      type: 'bootstrap',
      wasmUrl: '/a/pikafish.wasm',
      nnueUrl: '/a/pikafish.nnue',
    });
  });

  it('onMessage 在 start 之前注册时，能收到 Worker 上行消息', () => {
    const t = createWebWorkerTransport('/x.bin', { wasmUrl: '/x.wasm', nnueUrl: '/x.nnue' });
    const seen: unknown[] = [];
    t.onMessage((m) => seen.push(m));
    t.onDead(() => {
      /* noop */
    });
    t.start();

    FakeWorker.instances[0].emit({ type: 'host-loaded' });
    FakeWorker.instances[0].emit({ type: 'ready', banner: 'b', options: ['MultiPV'] });
    expect(seen).toEqual([
      { type: 'host-loaded' },
      { type: 'ready', banner: 'b', options: ['MultiPV'] },
    ]);
  });

  it('Worker 构造失败 → 抛 TransportStartError（平台/资源类，属永久不可用）', () => {
    g.Worker = function ThrowingWorker() {
      throw new TypeError('boom');
    } as unknown as typeof Worker;
    const t = createWebWorkerTransport('/x.bin', { wasmUrl: '/x.wasm', nnueUrl: '/x.nnue' });
    expect(() => t.start()).toThrow(/创建引擎 Worker 失败/);
  });

  it('Worker 运行期报错 → 上报 onDead', () => {
    const t = createWebWorkerTransport('/x.bin', { wasmUrl: '/x.wasm', nnueUrl: '/x.nnue' });
    let dead = '';
    t.onMessage(() => {
      /* noop */
    });
    t.onDead((r) => {
      dead = r;
    });
    t.start();
    FakeWorker.instances[0].onerror?.({ message: 'crashed' });
    expect(dead).toBe('crashed');
  });
});
