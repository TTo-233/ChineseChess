/**
 * 原生引擎资源解析 —— 打包态根因回归测试（2026-10）
 *
 * ============================================================================
 * 【这个测试为什么必须存在：它守的是"所有既有测试都看不见"的那一层】
 *
 * 实机故障：打包后的 APP 里象棋永远「皮卡鱼启动中」、揭棋永远「基础AI」，
 * 而 Web 端与 Chromium 探针**全绿**。原因是：
 *
 *   `Image.resolveAssetSource(资源id)` 在
 *     · 开发态 → `http://localhost:8081/...`（真 URL，恰好能加载）
 *     · 打包态 → **Android 裸资源名**（如 `engines_pikafish`，无任何 scheme）
 *
 *   裸资源名不是 URL。Android WebView 拿它导航必然失败，而且
 *   **不会触发 onError / onHttpError**（"没有可加载的资源"不算网络错误），
 *   于是引擎只能干等到 45s 启动超时 → 永久降级，且全程无任何报错。
 *
 * 所以"产物能不能跑"的校验（verify-engine-in-chromium）**原理上**证明不了
 * 真机可用：它连的都是 http URL。而本测试直接把**打包态会产生的那个字符串**
 * 摆到判据面前，断言它必须被拒绝——只要有人再把裸资源名递给 WebView，
 * 这里立刻红。
 *
 * ⚠️ 第二条教训（真机二次定位才发现）：上面这道闸**当时是绿的，但真机仍然全废**，
 * 因为把裸资源名换成 file:// 所依赖的 `expo-asset` **根本没装进 APP**
 * （只被手写 `declare module` 声明成了存在的）。所以本文件末尾还有一组
 * "运行时依赖必须真的存在"的断言，专门守这一层。
 */

import {
  isNavigableUri,
  __resetNativeAssetCacheForTest,
} from '../pikafish/nativeAsset';

describe('原生引擎资源：可导航性判据（打包态根因）', () => {
  beforeEach(() => {
    __resetNativeAssetCacheForTest();
  });

  /**
   * 这些是**打包态** `Image.resolveAssetSource` 真实会返回的形态。
   *
   * 资源名由 @react-native/assets-registry 的 getAndroidResourceIdentifier
   * 生成：路径去掉扩展名 → 小写 → 分隔符换 '_' → 去掉 assets_ 前缀 →
   * 再剔除所有非 [a-z0-9_] 字符。所以它们都**没有 scheme**。
   */
  const PACKAGED_RESOURCE_NAMES = [
    'engines_pikafish',
    'engines_jieqi',
    'engines_pikafish_wasm',
    'engines_pikafish_nnue',
  ];

  it.each(PACKAGED_RESOURCE_NAMES)(
    '打包态裸资源名 %s 必须被判为「不可导航」',
    (name) => {
      // 断言前提：这个形态确实没有 scheme（即它就是那个致命输入）
      expect(name).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      expect(isNavigableUri(name)).toBe(false);
    }
  );

  it('WebView 真正能导航的形态必须判为「可导航」', () => {
    // 修复后 expo-asset 交出来的 file:// 缓存 URI（扩展名必须是 .html，
    // WebView 按扩展名定 Content-Type——.page 曾导致 text/plain 渲染、脚本不执行）
    expect(isNavigableUri('file:///data/user/0/com.x/cache/ExponentAsset-abc.html')).toBe(true);
    // 开发态 Metro 的 http 形态
    expect(isNavigableUri('http://localhost:8081/assets/engines/pikafish.html')).toBe(true);
    // https
    expect(isNavigableUri('https://example.com/a.html')).toBe(true);
    // content:// 与 android.resource:// 也是合法 scheme
    expect(isNavigableUri('content://com.x/raw/engines_pikafish')).toBe(true);
    expect(isNavigableUri('android.resource://com.x/raw/engines_pikafish')).toBe(true);
  });

  it('空串与纯空白必须判为不可导航', () => {
    expect(isNavigableUri('')).toBe(false);
    expect(isNavigableUri('   ')).toBe(false);
  });

  it('前导空白的合法 URL 仍应可导航（判据要容忍 trim）', () => {
    expect(isNavigableUri('  file:///a.html  ')).toBe(true);
  });

  /**
   * 关键回归：`.html` 这类"看起来像文件"的后缀不能被误判成 scheme。
   *
   * 判据用 `<scheme>:<...>`，而不是"有没有点"。若哪天有人把它写成
   * "只要不是 http 就当路径"之类的启发式，这条例子里 'a.html:b' 这种
   * 会被错判 —— 这里把边界钉死。
   */
  it('单字符 scheme 合法；不含冒号的一律不可导航', () => {
    expect(isNavigableUri('x:opaque')).toBe(true);
    expect(isNavigableUri('engines.pikafish')).toBe(false);
    expect(isNavigableUri('./engines/pikafish.html')).toBe(false);
    expect(isNavigableUri('../pikafish.html')).toBe(false);
  });
});

/**
 * ============================================================================
 * 【第二道闸：expo-asset 必须在运行时真的存在】
 *
 * 上一版实机故障的**直接**原因就是这个：`expo-asset` 当时只是 expo 的传递依赖，
 * pnpm 严格布局下没被提升到 client/node_modules，Metro 打包时
 * `require('expo-asset')` 直接 MODULE_NOT_FOUND。
 *
 * 之所以能一路绿灯跑到真机才炸，是因为当时给这个包补了一份
 * `declare module 'expo-asset'` shim —— 手写声明能骗过 tsc 和单测，
 * 却骗不过 Metro 与设备。这组断言就是钉死这个教训：
 * 只要有人再把依赖"声明"成存在的、而不在 package.json 里真正装上，立刻红。
 */
describe('原生引擎资源：expo-asset 必须真实可解析', () => {
  it('expo-asset 是 package.json 的直接依赖', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../../package.json');
    expect(pkg.dependencies?.['expo-asset']).toBeTruthy();
  });

  it('require.resolve("expo-asset") 真的能解析（不是只存在于类型里）', () => {
    // 这条正是上一版缺的那条断言：require.resolve 会按 Metro 的规则真实查找。
    expect(() => require.resolve('expo-asset')).not.toThrow();
  });

  it('不需要任何 declare module shim 也能拿到 Asset 句柄的类型', () => {
    // 若有人把 shim 加回来，这里会因为拿到 ambient 声明而"看起来没事"，
    // 但上面的 require.resolve 断言才是真判据（shim 不影响运行时解析）。
    const asset = require('expo-asset');
    expect(typeof asset.Asset).toBe('function');
    expect(typeof asset.Asset.fromModule).toBe('function');
  });
});