/**
 * 原生端打包资源解析 —— 把 Metro 资源 require 结果变成 **WebView 能真正加载** 的 URI
 *
 * ============================================================================
 * 【这是 2026-10 实机「引擎永远启动不了」的根因修复】
 *
 * 现象：打包后 APP 里象棋一直「皮卡鱼启动中」、揭棋一直「基础AI」，两个引擎
 * 在真机上从未真正跑起来；而 Web 端一切正常。
 *
 * 根因（已从 React Native 源码逐行核实，不是推测）：
 *   `require('assets/engines/pikafish.html')` 在原生端返回**数字资源 id**，
 *   交给 `Image.resolveAssetSource(id)` 后，RN 会走 AssetSourceResolver
 *   的 defaultAsset()：
 *
 *       · 开发态（Metro 在跑） → isLoadedFromServer() 为真
 *                             → 返回 `http://localhost:8081/assets/...`
 *                             → **是真 URL，WebView 能加载** ✅
 *       · 打包态               → 没有 serverUrl，且 jsbundleUrl 是 file://
 *                             → 走 resourceIdentifierWithoutScale()
 *                             → getAndroidResourceIdentifier(asset)
 *                             → 返回**裸资源名**（如 `engines_pikafish`）❌
 *
 *   那个返回值根本不是 URL —— 没有 `http:`/`file:`/`asset:` 任何 scheme，
 *   只是 Android `Resources.getIdentifier(name,"raw",pkg)` 的资源名。
 *   Android WebView 拿它去导航时，会把它当成**相对路径**去解析，
 *   必然加载失败：
 *     · `onMessage(host-loaded)` 永远不会触发（页面脚本压根没跑）；
 *     · 也不会触发 onError / onHttpError（"没有可加载的资源"不算网络错误），
 *       所以承载死亡回调也不会来；
 *     · 于是引擎只能干等到启动超时（45s）→ 永久降级到兜底 AI，
 *       界面就一直显示「皮卡鱼启动中 / 基础AI」，且**没有任何报错**。
 *
 * ⚠️ 为什么之前所有验证都是「假绿灯」——这一点必须写进文档：
 *   · Expo 开发态：资源走 http://localhost:8081，是真 URL，必然能加载；
 *   · verify-engine-in-chromium.mjs：把页面用**本地 http server** 喂给浏览器，
 *     等于又测了一遍「有可用 origin」的情况；
 *   两条路径都**没有**触及"打包态裸资源名"这一形态，
 *   于是产物再怎么验也证明不了真机能加载。这正是本 bug 能反复复现的原因。
 *
 * ============================================================================
 * 【2026-10 实机二次定位：为什么上一版修复在真机上依然完全无效】
 *
 * 上一版修了「拿到裸资源名」这一环，并改走 expo-asset 换 file://。
 * 在 Web 上、在 Chromium 探针上、在 861 个单测里，它都是对的。
 * 但真机仍然停在「皮卡鱼启动中 / 基础AI」——**一次都没起来过**。
 *
 * 真因：那一版依赖的 `expo-asset` **根本没被装进这个 APP**。
 *   · 它只是 `expo` 的**传递依赖**；
 *   · pnpm 的严格 node_modules 布局**不会**把它提升到 client/node_modules；
 *   · 于是 Metro 打包时 `require('expo-asset')` 直接 **MODULE_NOT_FOUND**；
 *   · 当时为了让它「类型上可用」，还给 package 补了一份 `declare module` shim，
 *     于是**类型检查全绿、单测全绿、构建成功**——只是那份 shim 把一个
 *     根本不存在的运行时依赖"声明"成了存在的。
 *
 * 这是本次排查里最值得记住的一点：
 *   **手写的 `declare module` 能骗过 tsc，却骗不过 Metro 和设备。**
 *   它把「模块缺失」从编译期错误降级成了运行期才炸、且被 try/catch 吞掉的静默降级。
 *
 * 设备侧证据（adb 抓取真机安装包）：
 *   · APK 的 JS bundle 里 `expo-asset` 只有一个 require 字符串；
 *   · 而它真正的原生模块标识 `expo.modules.asset.AssetModule` **完全不存在**；
 *   · 对比：`expo.modules.filesystem.FileSystemModule` 同样查不到 —— 说明
 *     连文件系统模块也不在（见下方"为什么不用 FileSystem"）。
 *   · 同一份 APK 里引擎资源本身是**齐全**的（assets_engines_* 六个资源都在
 *     resources.arsc 的 key pool 里，res/ 下文件大小也对得上），
 *     所以**问题不在资源有没有打进包，而在用什么去读它们**。
 *
 * 修复：`expo-asset` 现在是 client 的**直接依赖**（~12.0.12），
 * 它的原生模块（AssetModule.kt / ResourceAsset.kt）会随 prebuild 一起进 dex，
 * 而那份 `declare module` shim 已删除——让 tsc 重新对这个包负责。
 *
 * ============================================================================
 * 【2026-10 三次定位：expo-asset 保留扩展名 + WebView 按扩展名定 Content-Type】
 *
 * 换成 file:// 之后引擎仍起不来（真机 logcat：启动超时 45000ms 退避重试）。
 * CDP 连进真机 WebView 实测（PTP-AN10）：
 *   · 页面 URL 是 file://…/cache/ExponentAsset-<hash>.page —— **扩展名原样保留**；
 *   · document.contentType === 'text/plain'；
 *   · document.querySelectorAll('script').length === 0，正文是 <pre> 包着的 HTML 源码。
 * 即：expo-asset 复制资源进 cache 时**不改扩展名**，而 WebView（Chromium）导航
 * file:// 时**按扩展名**决定 Content-Type——`.page` 无注册 MIME → text/plain →
 * 页面脚本根本不执行 → host-loaded 永不到来 → 45s 启动超时。
 *
 * 修复：引擎页产物改名回 **.html**（gen-pikafish-host.mjs / gen-jieqi-host.mjs）。
 * `.html` 在 WebView 的 file:// 下按 text/html 渲染，脚本正常执行。
 * 当年弃用 .html 是因为旧产物与 pikafish.wasm 同 stem 撞 AAPT 资源名；
 * 现 wasm/nnue/worker 已各自改名（pikafish_wasm/…），stem 互异，可安全回 .html。
 * 教训：**给 WebView 导航的文件，扩展名必须是 WebView 认识的**——
 * 自造扩展名在 res/raw 阶段无害，到 file:// 导航这一步就成了致命伤。
 *
 * ============================================================================
 * 【为什么不用 expo-file-system 自己读字节】
 *
 * 直觉上"自己读文件再内联 {html}"更可控，但在这台设备上不可行：
 *   · `expo.modules.filesystem.FileSystemModule` 在同一份 APK 里**也不存在**
 *     （expo-file-system 虽然能 resolve，但没进 native 侧），
 *     走它只会把同一个坑换个包名再踩一次；
 *   · 就算能用，JS 侧还要自己再实现「读 4MB 二进制 → base64 → 拼进 HTML」，
 *     内存峰值比 expo-asset 的原生 copy 高得多，低端机更容易被 OOM 杀渲染进程。
 *   expo-asset 的原生实现正好补上缺的那一步，JS 侧只拿到一个短字符串 URI。
 *
 * ============================================================================
 * 【修法：借 expo-asset 的原生模块把资源名换成 file:// 缓存文件】
 *
 * expo-asset 的 Android 原生实现（AssetModule.kt / ResourceAsset.kt）做的正是
 * 缺的那一步：接收**裸资源名** → `resources.getIdentifier(name,"raw",pkg)`
 * → `openRawResource(resId)` 把字节流复制到应用 cache 目录 → 返回 `file://` URI。
 *
 * 那是一个 WebView **能**导航的 URI，且 `allowFileAccess*` 已开。
 *
 * 体积问题（原生端 6MB 内联页在低端机上的解析/OOM 风险）由**生成脚本**
 * 单独处理：原生页改为「小页面 + 旁边两个独立二进制资源」，与 Web 端 Worker
 * 走同一套 fetch 逻辑，不再内联 base64。
 */

/** 缓存已解析的 uri，避免每次渲染都重新触发原生 copy */
const uriCache = new Map<string, string>();

/**
 * 判断一个字符串「像不像一个 WebView 能直接导航的 URL」。
 *
 * ⚠️ 这不是可选的健壮性检查，而是**本次故障的核心判据**：
 * 打包态下 RN 给回来的就是裸资源名（无 scheme），必须识别出来并拒绝，
 * 否则会原样交给 WebView 并静默失败。宁可在这里显式报错，也不能把
 * 一个无法加载的字符串递给 WebView —— 那正是本次线上故障的形态。
 */
export function isNavigableUri(uri: string): boolean {
  const s = uri.trim();
  if (s.length === 0) return false;
  // 必须是 <scheme>:<...> 形态。裸资源名 / 相对路径一律视为「不可导航」。
  return /^[a-z][a-z0-9+.-]*:/i.test(s);
}

/**
 * 把 Metro 资源 require 的结果解析成 WebView 可加载的 URI（异步）。
 *
 * @param asset `require(...)` 的返回值（数字 id / 字符串 / {uri}）
 * @param type  资源类型后缀，仅用于日志/缓存键（如 'html'；缓存文件名由 expo-asset 决定）
 */
async function resolveViaExpoAsset(asset: number, type: string): Promise<string> {
  // expo-asset 现在是 client 的**直接依赖**（见 package.json），
  // 其原生模块随 prebuild 进入 dex。惰性 require 是为了不让纯逻辑单测
  // 在 Node/Jest 环境里被原生模块拖累，不影响打包产物的解析。
  //
  // ⚠️ 这里**故意不做** try/catch 兜底：模块缺失属于"打包配置坏了"，
  //  必须以可辨识的异常冒到上层，而不是伪装成一次普通降级 ——
  // 上一版就是因为缺依赖 + try/catch，症状永远是笼统的「引擎启动中」。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Asset } = require('expo-asset') as typeof import('expo-asset');
  // localUri 在下载完成后才有值，所以这里必须等 asset 真正就绪。
  const resolved = await Asset.fromModule(asset).downloadAsync();
  const uri = resolved.localUri;
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error(`expo-asset 未能为资源(${type})解析出本地 URI`);
  }
  return uri;
}

/**
 * 解析原生端资源为 WebView 可加载的 URI。
 *
 * @param asset    `require(...)` 的返回值
 * @param cacheKey 缓存键（同一资源跨次调用只解析一次）
 * @param type     资源类型后缀（原生缓存文件名用）
 * @returns 一个**保证带 scheme** 的 URI；无法保证时抛错（由上层降级）
 */
export async function resolveNativeAssetUri(
  asset: unknown,
  cacheKey: string,
  type: string
): Promise<string> {
  const cached = uriCache.get(cacheKey);
  if (cached) return cached;

  let uri: string | null = null;

  if (typeof asset === 'number') {
    // 原生（打包态与开发态都是数字 id）：必须经 expo-asset 换 file:// 本地缓存。
    // 直接把数字交给 Image.resolveAssetSource 在打包态会得到裸资源名（本次故障根因）。
    uri = await resolveViaExpoAsset(asset, type);
  } else if (typeof asset === 'string' && asset.length > 0) {
    uri = asset;
  } else if (asset && typeof asset === 'object') {
    const direct = (asset as { uri?: unknown }).uri;
    if (typeof direct === 'string' && direct.length > 0) uri = direct;
    else {
      const def = (asset as { default?: unknown }).default;
      if (typeof def === 'string') uri = def;
      else if (typeof def === 'number') uri = await resolveViaExpoAsset(def, type);
    }
  }

  if (!uri) {
    throw new Error(`无法解析原生资源（${cacheKey}）：资源缺失或未登记为 assetExt`);
  }
  // 交付前的最后一道闸：绝不放行「没有 scheme 的字符串」给 WebView。
  // 那正是打包态裸资源名 —— WebView 会静默加载失败且不报任何错，
  // 让引擎永远停在「启动中」。宁可抛错降级，也不要制造静默故障。
  if (!isNavigableUri(uri)) {
    throw new Error(
      `原生资源 ${cacheKey} 解析出的是不可导航的地址（无 scheme）：${JSON.stringify(uri)}。` +
        `打包态下 Image.resolveAssetSource 返回的是 Android 裸资源名，` +
        `WebView 无法导航；必须经 expo-asset 转成 file:// 本地 URI。`
    );
  }

  uriCache.set(cacheKey, uri);
  return uri;
}

/** 仅供测试：清空缓存 */
export function __resetNativeAssetCacheForTest(): void {
  uriCache.clear();
}