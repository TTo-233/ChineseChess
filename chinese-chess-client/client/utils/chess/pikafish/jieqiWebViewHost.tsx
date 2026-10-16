/**
 * 揭棋引擎宿主 —— 屏幕外 WebView 组件（仅 Android / iOS）
 *
 * ============================================================================
 * 【为什么必须单独一个 WebView，不能与皮卡鱼共用】
 *
 * 两个引擎的交互模型不同（详见 jieqiHost.ts 顶部说明）：皮卡鱼是常驻实例、
 * 一次握手后长期存活；揭棋是一次性批量会话，每次搜索都要新建实例。
 * 把它们塞进同一个 WebView 会让两个状态机互相踩（揭棋会话会打断皮卡鱼的
 * 常驻引擎，反之亦然），而且各自的超时预算完全不同。分开挂载虽然多一个
 * 原生视图，但换来的是互不干扰的语义与各自可调的失败判定。
 *
 * ⚠️ 揭棋页只有 0.57 MiB（glue + 内联 wasm），代价远小于多占一个视图的复杂度。
 *
 * ============================================================================
 * 【与 pikafish/webViewHost.tsx 共享的两条硬约束】
 *
 * 1. **ref 必须稳定**（useCallback）：内联箭头会让 React 每次重渲染都
 *    先回调 ref(null) 再回调 ref(instance)。
 * 2. **隐藏容器用 1×1 而不是 0×0**：Android 的 WebView 在 0 尺寸容器里
 *    可能被跳过布局、不执行页面渲染，表现为"页面永远不发 host-loaded"。
 *
 * 这两条都是实机踩出来的（象棋侧曾因此永远"皮卡鱼启动中"），别改回去。
 */

import { useCallback, useEffect } from 'react';
import type React from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import type { EngineHostSource } from './engineTransport';
import {
  dispatchJieqiDead,
  dispatchJieqiMessage,
  registerJieqiWebView,
  type JieqiOutbound,
} from './jieqiWebViewBridge';

/** 承载真的出问题了（加载失败 / 渲染进程被杀）：模块级稳定函数，无状态 */
function handleLoadError(..._args: unknown[]): void {
  dispatchJieqiDead();
}

/**
 * 屏幕外的揭棋引擎 WebView。挂在 App 根布局（渲染一次）即可。
 *
 * @param source 引擎页来源：`{ html }` 或 `{ uri }`（见 engineTransport）
 */
export function JieqiWebViewHost({ source }: { source: EngineHostSource }): React.ReactElement {
  const handleRef = useCallback((instance: WebView | null) => {
    // null 只表示"此刻没有可注入的句柄"（React ref 的重渲染中间态），
    // 不是承载死亡——真死亡由 handleLoadError / 组件卸载上报。
    registerJieqiWebView(instance);
  }, []);

  useEffect(() => {
    return () => {
      // 组件真卸载：承载确实没了，让挂起的会话立刻失败而不是干等超时
      registerJieqiWebView(null);
      dispatchJieqiDead();
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
        cacheEnabled={false}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        onMessage={(ev: WebViewMessageEvent) => {
          try {
            dispatchJieqiMessage(JSON.parse(ev.nativeEvent.data) as JieqiOutbound);
          } catch {
            // 非协议消息忽略
          }
        }}
        onError={handleLoadError}
        onHttpError={handleLoadError}
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
    // ⚠️ 1×1 而非 0×0：Android WebView 在 0 尺寸容器里可能被跳过布局与渲染
    width: 1,
    height: 1,
    position: 'absolute',
    opacity: 0,
    top: -100,
    left: -100,
  },
});