/**
 * 揭棋 WebView 承载层回归测试
 *
 * ============================================================================
 * 【为什么必须有这组测试】
 *
 * 揭棋在原生端此前**完全没有承载**（isJieqiHostAvailable 对 android/ios
 * 硬编码 return false），于是打包后揭棋永远走 TS 兜底。新增的 WebView 承载
 * 是一次性会话模型，与象棋的常驻握手完全不同，容易在这里写错：
 *
 *   · 页面未就绪时的请求必须**挂起**而不是丢弃（否则启动即预热的会话凭空消失）；
 *   · React ref 的 null 是重渲染中间态，**不是承载死亡**（象棋侧踩过这个坑，
 *     直接导致原生端永久失联）；
 *   · 挂起中的会话在承载死亡时必须**立刻失败**，不能干等到超时；
 *   · one-shot 引擎同一时刻只能跑一个会话，并发请求要明确拒绝。
 */

import {
  __resetJieqiBridgeForTest,
  dispatchJieqiDead,
  dispatchJieqiMessage,
  registerJieqiWebView,
  runSessionInWebView,
  type JieqiOutbound,
} from '../pikafish/jieqiWebViewBridge';

function makeFakeWebView() {
  const injected: string[] = [];
  return {
    injected,
    injectJavaScript: (script: string) => {
      injected.push(script);
    },
  };
}

/** 从注入脚本里取出消息（注入格式：...{data:<json>}));true;） */
function messagesIn(injected: string[]): Array<Record<string, unknown>> {
  const START = '{data:';
  const END = '}));true;';
  return injected.map((s) => {
    const i = s.indexOf(START);
    const j = s.lastIndexOf(END);
    if (i < 0 || j < 0 || j <= i) throw new Error(`无法解析注入脚本: ${s}`);
    return JSON.parse(s.slice(i + START.length, j)) as Record<string, unknown>;
  });
}

describe('揭棋 WebView 承载', () => {
  beforeEach(() => {
    __resetJieqiBridgeForTest();
  });

  afterEach(() => {
    __resetJieqiBridgeForTest();
  });

  it('页面未就绪时的会话被挂起，host-loaded 到达后立刻发起', async () => {
    const wv = makeFakeWebView();
    registerJieqiWebView(wv);

    // 模拟"App 启动即预热"：此时页面还没 host-loaded
    const p = runSessionInWebView(['uci', 'quit'], 5000);
    expect(wv.injected.length).toBe(0); // 还没注入（挂起中）

    dispatchJieqiMessage({ type: 'host-loaded' });

    // 页面就绪的瞬间应该已经把会话发出去了
    const msgs = messagesIn(wv.injected);
    expect(msgs.some((m) => m.type === 'session')).toBe(true);

    dispatchJieqiMessage({ type: 'done', banner: 'Pikafish', lines: ['bestmove h0g2'] });
    const res = (await p) as Extract<JieqiOutbound, { type: 'done' }>;
    expect(res.type).toBe('done');
    expect(res.lines).toContain('bestmove h0g2');
  });

  it('页面就绪后的会话直接下发并由 done 收尾', async () => {
    const wv = makeFakeWebView();
    registerJieqiWebView(wv);
    dispatchJieqiMessage({ type: 'host-loaded' });

    const p = runSessionInWebView(['uci', 'position startpos', 'go depth 4', 'quit'], 5000);
    const msgs = messagesIn(wv.injected);
    const session = msgs.find((m) => m.type === 'session');
    expect(session).toBeDefined();
    expect((session!.commands as string[]).includes('go depth 4')).toBe(true);

    dispatchJieqiMessage({ type: 'done', banner: 'b', lines: ['uciok', 'bestmove h0g2'] });
    const res = (await p) as Extract<JieqiOutbound, { type: 'done' }>;
    expect(res.banner).toBe('b');
  });

  it('error 消息以 done 同一条路径回传给调用方（由 runJieqiSession 转成 reject）', async () => {
    const wv = makeFakeWebView();
    registerJieqiWebView(wv);
    dispatchJieqiMessage({ type: 'host-loaded' });

    const p = runSessionInWebView(['uci', 'quit'], 5000);
    dispatchJieqiMessage({ type: 'error', message: 'engine busy' });
    // 桥层只负责把页面消息原样送出；"error 该不该算失败"由 runJieqiSession 判定
    // （它会 throw）。桥若在这里自己 reject，会把协议细节漏给协议外的调用方。
    const res = (await p) as Extract<JieqiOutbound, { type: 'error' }>;
    expect(res.type).toBe('error');
    expect(res.message).toBe('engine busy');
  });

  it('React ref(null) 是重渲染中间态，不得让挂起会话失败', async () => {
    const wv = makeFakeWebView();
    registerJieqiWebView(wv);
    dispatchJieqiMessage({ type: 'host-loaded' });

    const p = runSessionInWebView(['uci', 'quit'], 5000);

    // 模拟一次 re-render：ref(null) → ref(instance)
    registerJieqiWebView(null);
    registerJieqiWebView(wv);

    // 会话仍在挂起（没有失败），且恢复后引擎结果能正常收尾
    let settled = false;
    void p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    dispatchJieqiMessage({ type: 'done', banner: 'b', lines: ['bestmove h0g2'] });
    await expect(p).resolves.toBeDefined();
    expect(settled).toBe(true);
  });

  it('承载死亡时挂起的会话立刻失败（不干等到超时）', async () => {
    const wv = makeFakeWebView();
    registerJieqiWebView(wv);

    const p = runSessionInWebView(['uci', 'quit'], 60000); // 预算很长
    dispatchJieqiDead();
    await expect(p).rejects.toThrow(/承载不可用/);
  });

  it('承载死亡后再发起会话立即失败（不挂起）', async () => {
    const wv = makeFakeWebView();
    registerJieqiWebView(wv);
    dispatchJieqiMessage({ type: 'host-loaded' });
    dispatchJieqiDead();

    await expect(runSessionInWebView(['uci', 'quit'], 5000)).rejects.toThrow(/承载不可用/);
  });

  it('one-shot：并发会话被明确拒绝而不是排队', async () => {
    const wv = makeFakeWebView();
    registerJieqiWebView(wv);
    dispatchJieqiMessage({ type: 'host-loaded' });

    const first = runSessionInWebView(['uci', 'quit'], 5000);
    await expect(runSessionInWebView(['uci', 'quit'], 5000)).rejects.toThrow(/正忙/);

    dispatchJieqiMessage({ type: 'done', banner: 'b', lines: ['bestmove h0g2'] });
    await expect(first).resolves.toBeDefined();
  });

  it('超时兜底：页面永不返回 done 时按调用方预算拒绝', async () => {
    jest.useFakeTimers();
    try {
      const wv = makeFakeWebView();
      registerJieqiWebView(wv);
      dispatchJieqiMessage({ type: 'host-loaded' });

      const p = runSessionInWebView(['uci', 'quit'], 1000);
      const assertion = expect(p).rejects.toThrow(/会话超时（1000ms）/);
      jest.advanceTimersByTime(1100);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it('页面永不加载时挂起会话也按预算拒绝（不永久悬挂）', async () => {
    jest.useFakeTimers();
    try {
      const wv = makeFakeWebView();
      registerJieqiWebView(wv); // 从不 host-loaded

      const p = runSessionInWebView(['uci', 'quit'], 2000);
      const assertion = expect(p).rejects.toThrow(/会话超时（2000ms）/);
      jest.advanceTimersByTime(2100);
      await assertion;
      expect(wv.injected.length).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});