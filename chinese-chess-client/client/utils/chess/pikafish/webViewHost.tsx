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

import { useEffect } from 'react';
import type React from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import type { EngineHostSource, HostOutbound } from './engineTransport';
import { dispatchWebViewDead, dispatchWebViewMessage, registerWebView } from './webViewTransport';

/**
 * 屏幕外的引擎 WebView。挂在 App 根布局（渲染一次）即可，不需要出现在对局页面里。
 *
 * @param source 引擎页来源：
 *   · `{ html }` —— 直接内联（Web 端/文本可用时）
 *   · `{ uri }`  —— 交给 WebView 自行加载（原生端资源是数字 id，只能换 uri；
 *                  也避免 6MB 字符串过 RN 桥）
 */
export function PikafishWebViewHost({ source }: { source: EngineHostSource }): React.ReactElement {
  useEffect(() => {
    return () => {
      // 页面卸载：清空实例引用，避免向已销毁的 WebView 注入脚本
      registerWebView(null);
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
        ref={(instance) => registerWebView(instance)}
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
        onError={dispatchWebViewDead}
        onHttpError={dispatchWebViewDead}
        // 【2026-10 审计 P2】系统回收渲染进程也要上报死亡，不能只等 onError/onHttpError。
        // 缺陷：此前只挂了"加载失败"两个回调，而 Android 在内存压力下会**杀掉 WebView
        // 的渲染进程**（页面加载成功之后也会发生），iOS 也提供同语义回调。此时 JS 侧
        // 仍以为承载存活：send 照发、search 永无回音，只能干等搜索墙钟超时
        //（hard 档 15s + slack）才发现异常，观感就是"AI 卡住"。
        // 接上后立刻 dispatchWebViewDead → 引擎进入可重建状态（编排器冷却后重试），
        // 与 Web 端 Worker 的 onerror 上报对齐。
        onRenderProcessGone={dispatchWebViewDead}
        onContentProcessDidTerminate={dispatchWebViewDead}
        androidLayerType="software"
        style={styles.hidden}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    width: 0,
    height: 0,
    position: 'absolute',
    opacity: 0,
    // 移出可视区域：某些平台仍会对 0 尺寸视图做一次布局
    top: -10000,
    left: -10000,
  },
});
