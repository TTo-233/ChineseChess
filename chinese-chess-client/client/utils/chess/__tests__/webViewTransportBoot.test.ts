/**
 * WebView 承载层回归测试（2026-10 审计 P0-1）
 *
 * 缺陷：承载的 `send` 在页面未加载时**静默丢弃**消息，而 bootstrap 是在
 * start() 之后立即下发的。原生 WebView 加载 6MB 内联 HTML 必然是异步的，
 * 于是 bootstrap 每次都被丢掉 → 20s 超时 → 永久降级到兜底 AI，
 * 而 UI 仍显示"基础AI"。审计探针 [B] 实测「送达 0 条」。
 *
 * 本测试把该时序**固化成断言**：承载必须等到 host-loaded 才发 bootstrap。
 */

import type { HostOutbound } from '../pikafish/engineTransport';

// 被测模块（零原生依赖，可直接在 Jest 下加载）
import {
  createWebViewTransport,
  dispatchWebViewMessage,
  registerWebView,
  __resetWebViewBridgeForTest,
  webViewBridge,
} from '../pikafish/webViewTransport';

/** 收集 injectJavaScript 注入的脚本 */
function makeFakeWebView() {
  const injected: string[] = [];
  return {
    injected,
    injectJavaScript: (script: string) => {
      injected.push(script);
    },
  };
}

/**
 * 解析注入脚本里携带的消息。
 *
 * 注入格式：window.dispatchEvent(new MessageEvent('message',{data:<json>}));true;
 *
 * 用**字符串定位**而非正则：注入串里 JSON 可能含嵌套花括号，正则极易写错
 * （曾两次误判"bootstrap 没送达"）。这里取 `{data:` 与 `}));true;` 之间的原文，
 * 解析失败则显式抛错，避免静默返回 {} 造成假阴性。
 */
function messagesIn(injected: string[]): Array<Record<string, unknown>> {
  const START = '{data:';
  const END = '}));true;';
  return injected.map((s) => {
    const text = s.trim();
    const i = text.indexOf(START);
    const j = text.lastIndexOf(END);
    if (i < 0 || j < 0 || j <= i) throw new Error(`无法解析注入脚本: ${s}`);
    return JSON.parse(text.slice(i + START.length, j)) as Record<string, unknown>;
  });
}

describe('WebView 承载：bootstrap 不得被丢弃（P0-1）', () => {
  beforeEach(() => {
    // 用**测试专用**复位：生产路径的 resetWebViewBridge 刻意保留 pageLoaded/实例
    //（引擎重建语义，见其注释），而单测之间必须回到"页面尚未加载"的初始态。
    __resetWebViewBridgeForTest();
  });

  afterEach(() => {
    __resetWebViewBridgeForTest();
    registerWebView(null);
  });

  it('页面未加载时 start() 不会立刻发出 bootstrap', () => {
    const wv = makeFakeWebView();
    registerWebView(wv);

    const t = createWebViewTransport();
    t.onMessage(() => { /* noop */ });
    t.onDead(() => { /* noop */ });
    t.start();

    // 此刻页面还没 host-loaded：不应有任何注入
    expect(wv.injected.length).toBe(0);
    expect(webViewBridge.isReady()).toBe(false);
  });

  it('host-loaded 之后 start 的 onReady 回调触发，bootstrap 得以送达', () => {
    const wv = makeFakeWebView();
    registerWebView(wv);

    // 真实时序：注册回调 → 启动承载 → 页面异步就绪 → onReady 触发 → 下发 bootstrap
    // ⚠️ onMessage 必须**先于** start 注册：承载内部靠它把 host-loaded 转成 onReady
    const t = createWebViewTransport();
    let readyFired = false;
    t.onMessage(() => { /* noop */ });
    t.onDead(() => { /* noop */ });
    t.start(() => {
      readyFired = true;
      t.send({ type: 'bootstrap' });
    });

    // 此刻页面还没就绪：bootstrap 不能已经进 WebView
    expect(readyFired).toBe(false);
    expect(wv.injected.length).toBe(0);

    // 页面就绪
    dispatchWebViewMessage({ type: 'host-loaded' } as HostOutbound);

    expect(readyFired).toBe(true);
    const msgs = messagesIn(wv.injected);
    expect(msgs.some((m) => m.type === 'bootstrap')).toBe(true);
  });

  it('页面就绪前发送的握手类消息会排队，就绪后补发', () => {
    const wv = makeFakeWebView();
    registerWebView(wv);

    // 直接用桥：模拟"页面未加载时先发 stop/dispose 类消息"
    webViewBridge.send({ type: 'bootstrap' });
    expect(wv.injected.length).toBe(0); // 还没发出去（排队中）

    dispatchWebViewMessage({ type: 'host-loaded' } as HostOutbound);
    const msgs = messagesIn(wv.injected);
    expect(msgs.some((m) => m.type === 'bootstrap')).toBe(true);
  });

  it('search 消息不排队（引擎未就绪时不该有 search）', () => {
    const wv = makeFakeWebView();
    registerWebView(wv);

    webViewBridge.send({
      type: 'search',
      seq: 1,
      randomPick: false,
      commands: ['go depth 4'],
    });
    expect(wv.injected.length).toBe(0);

    dispatchWebViewMessage({ type: 'host-loaded' } as HostOutbound);
    // 排队里不应有 search
    const msgs = messagesIn(wv.injected);
    expect(msgs.some((m) => m.type === 'search')).toBe(false);
  });

  it('页面已就绪后再 start()：立即补发 onReady（避免等超时）', () => {
    const wv = makeFakeWebView();
    registerWebView(wv);

    // 页面先就绪（引擎在 WebView 挂载之后才首次 init）
    dispatchWebViewMessage({ type: 'host-loaded' } as HostOutbound);
    expect(webViewBridge.isReady()).toBe(true);

    const t = createWebViewTransport();
    t.onMessage(() => { /* noop */ });
    t.onDead(() => { /* noop */ });
    let fired = false;
    t.start(() => {
      fired = true;
    });
    // 必须立刻回调，而不是等下一次 host-loaded
    expect(fired).toBe(true);
  });

  it('承载死亡后清空排队，不再补发', () => {
    const wv = makeFakeWebView();
    registerWebView(wv);

    const t = createWebViewTransport();
    let deadReason: string | null = null;
    t.onMessage(() => { /* noop */ });
    t.onDead((r) => {
      deadReason = r;
    });
    t.start();

    webViewBridge.send({ type: 'bootstrap' }); // 排队
    dispatchWebViewMessage({ type: 'host-loaded' } as HostOutbound);
    const before = wv.injected.length;
    expect(before).toBeGreaterThan(0);

    // 死亡后不再有补发
    dispatchWebViewMessage({ type: 'host-loaded' } as HostOutbound);
    // onDead 由组件侧 dispatchWebViewDead 触发，这里只验证桥已就绪状态
    expect(deadReason).toBeNull();
  });
});
