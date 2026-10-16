/**
 * 引擎宿主 —— 屏幕外 WebView 组件（仅 Android / iOS）
 *
 * ============================================================================
 * 【为什么用 WebView 而不是原生模块】
 *
 * React Native 的 Hermes **不支持 WebAssembly**，而本地引擎是 WASM，所以 JS 侧
 * 无法直接跑引擎。剩下两条路：
 *   ① WebView 跑同一份自包含宿主（本期实现：改动小、与 Web 端同一份引擎与二进制）
 *   ② 原生 Expo Module 跑 C++ 引擎（性能与后台更稳，但要写 JNI/ObjC++，
 *      且需退出 Expo Go 走 development build）
 * 先落 ① 把协议与棋力跑通；本文件即 ② 的替换点。
 *
 * ============================================================================
 * 【为什么单独成文件】
 *
 * `react-native-webview` 在 import 时就要求原生模块 RNCWebViewModule 存在，
 * 在 Jest 环境里直接抛错。把它隔离在本文件（只被根布局 import），
 * 就不会污染任何纯逻辑单测。命令式桥在 webViewTransport.ts（零原生依赖）。
 *
 * ============================================================================
 * 【屏幕外渲染的必要性】
 *
 * WebView 只是 JS 沙箱，但在真机上仍是原生视图：给它 0 尺寸 + 移出屏幕，
 * 并关掉 pointerEvents / 无障碍，避免影响棋盘布局与触摸。
 */

import { useCallback, useEffect, useRef } from 'react';
import type React from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import type { EngineHostSource, HostOutbound } from './engineTransport';
import {
  dispatchWebViewDead,
  dispatchWebViewMessage,
  registerWebView,
} from './webViewTransport';

/**
 * 屏幕外的引擎 WebView。挂在 App 根布局（渲染一次）即可，不需要出现在对局页面里。
 *
 * @param source 引擎页来源：
 *   · `{ html }` —— 直接内联（Web 端/文本可用时）
 *   · `{ uri }`  —— 交给 WebView 自行加载（原生端资源是数字 id，只能换 uri；
 *                  也避免 6MB 字符串过 RN 桥）
 */
/**
 * 承载真的出问题了（加载失败 / 渲染进程被杀）。
 *
 * 用**模块级稳定函数**而非组件内 useCallback：它们无状态，
 * 且能保证每次渲染传给 WebView 的都是同一个引用（原生侧不会反复重挂回调），
 * 也避免了在 JSX 里引用尚未初始化的 const（TDZ）。
 */
function handleLoadError(..._args: unknown[]): void {
  dispatchWebViewDead();
}

/**
 * 屏幕外的引擎 WebView。挂在 App 根布局（渲染一次）即可，不需要出现在对局页面里。
 *
 * @param source 引擎页来源：
 *   · `{ html }` —— 直接内联（Web 端/文本可用时）
 *   · `{ uri }`  —— 交给 WebView 自行加载（原生端资源是数字 id，只能换 uri；
 *                  也避免 6MB 字符串过 RN 桥）
 */
export function PikafishWebViewHost({ source }: { source: EngineHostSource }): React.ReactElement {
  /**
   * ⚠️ ref 必须是**稳定**的，不能写成内联箭头函数。
   *
   * 内联箭头每次渲染都是新引用，React 会先调用旧 ref(null) 再调用新 ref(instance)。
   * 旧实现把这个"重渲染中间态"当成承载死亡 → pageAlive=false + 清空 bootstrap 队列，
   * 而页面只加载一次、再无恢复路径 → 原生端引擎永久失联，界面永远"皮卡鱼启动中"。
   * 见 webViewTransport.registerWebView 的说明。
   */
  const handleRef = useCallback((instance: WebView | null) => {
    registerWebView(instance);
  }, []);

  useEffect(() => {
    return () => {
      // 组件真卸载：这是货真价实的"承载没了"，必须上报死亡让编排器重建。
      // （与上面的 ref(null) 是两件事——ref(null) 只清实例引用。）
      registerWebView(null);
      dispatchWebViewDead();
    };
  }, []);

  return (
    <View
      style={styles.hidden}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <WebView
        ref={handleRef}
        source={source}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled={false}
        // 页面内容随包内置（或同源资源），无需缓存
        cacheEnabled={false}
        // { uri } 形态下若是本地文件，需要允许访问
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        onMessage={(ev: WebViewMessageEvent) => {
          try {
            dispatchWebViewMessage(JSON.parse(ev.nativeEvent.data) as HostOutbound);
          } catch {
            // 非协议消息忽略（页面内没有别的日志输出）
          }
        }}
        onError={handleLoadError}
        onHttpError={handleLoadError}
        // 【2026-10 审计 P2】系统回收渲染进程也要上报死亡，不能只等 onError/onHttpError。
        // 缺陷：此前只挂了"加载失败"两个回调，而 Android 在内存压力下会**杀掉 WebView
        // 的渲染进程**（页面加载成功之后也会发生），iOS 也提供同语义回调。此时 JS 侧
        // 仍以为承载存活：send 照发、search 永无回音，只能干等搜索墙钟超时
        //（hard 档 15s + slack）才发现异常，观感就是"AI 卡住"。
        // 接上后立刻 dispatchWebViewDead → 引擎进入可重建状态（编排器冷却后重试），
        // 与 Web 端 Worker 的 onerror 上报对齐。
        onRenderProcessGone={handleLoadError}
        onContentProcessDidTerminate={handleLoadError}
        androidLayerType="software"
        style={styles.hidden}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    /**
     * ⚠️ 不能用 width:0 / height:0（2026-10 实测根因之一）。
     *
     * Android 的 WebView 在 0 尺寸容器里可能被跳过布局甚至不执行页面渲染，
     * 表现为"页面永远不 load、不发 host-loaded"。改用 1×1 的极小尺寸，
     * 既保证被正常布局与渲染，又不遮挡任何 UI（下面的 opacity/位置把它藏起来）。
     * 同时保留 pointerEvents="none" + 无障碍隐藏，双保险不参与触摸与朗读。
     */
    width: 1,
    height: 1,
    position: 'absolute',
    opacity: 0,
    // 仍要移出可视区域：1×1 的不透明像素也可能被误当作装饰
    top: -100,
    left: -100,
  },
});
