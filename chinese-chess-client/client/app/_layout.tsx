import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppState, LogBox, Text, TextInput, View } from 'react-native';
import { Provider } from '@/components/Provider';
import { warmupOfflineEngine, retryOfflineEngineNow } from '@/utils/chess/offlineAiAdapter';
import { needsWebViewEngineHost, getEngineHostSource } from '@/utils/chess/pikafish';
// 直接从 webViewHost 引入（不从 pikafish/index 转出）：该组件依赖
// react-native-webview，import 即要求原生模块；隔离在这里才不会污染纯逻辑单测。
import { PikafishWebViewHost } from '@/utils/chess/pikafish/webViewHost';

import '../global.css';

LogBox.ignoreLogs([
  "TurboModuleRegistry.getEnforcing(...): 'RNMapsAirModule' could not be found",
  // 添加其它想暂时忽略的错误或警告信息
]);

// 全局限制系统字体缩放上限（而非完全禁用）：系统大字体模式下应用内文字最多放大
// 1.3 倍，兼顾可读性与布局稳定，避免老人模式/大字模式把布局撑爆。
// 装饰性/数据性文字（角标等）在组件处以 allowFontScaling={false} 单独固定；
// 标题/按钮等关键文字以 numberOfLines + adjustsFontSizeToFit 在有限空间内自动缩放。
// @ts-expect-error defaultProps 在运行时仍然有效
Text.defaultProps = Text.defaultProps || {};
// @ts-expect-error
Text.defaultProps.maxFontSizeMultiplier = 1.3;

// @ts-expect-error
TextInput.defaultProps = TextInput.defaultProps || {};
// @ts-expect-error
TextInput.defaultProps.maxFontSizeMultiplier = 1.3;

/**
 * 本地引擎宿主（仅 Android / iOS 需要）
 *
 * Hermes 不支持 WebAssembly，所以原生端的 WASM 引擎跑在一个**屏幕外**的
 * WebView 里（零尺寸、不参与触摸）。这里在根布局挂一次即可，全程复用；
 * Web 端走 Dedicated Worker，不需要这个宿主。
 *
 * ⚠️ 必须放在 Provider 内、与 Stack 平级：它是引擎的运行时（类似一个常驻服务），
 *    不能随某个页面卸载而销毁——否则从对局页返回再进入就要重新加载 6MB 引擎。
 */
function OfflineEngineHost() {
  useEffect(() => {
    // 提前把引擎拉起来：避免玩家进入对局后第一个 AI 回合承担初始化耗时。
    // 该调用永不抛错，失败只会用兜底 AI（并会在冷却后自动重试）。
    warmupOfflineEngine();

    // 从后台回到前台：引擎大概率刚刚恢复（移动端 WebView 可能已被系统回收并
    // 重新挂载）。此时立刻重试一次，避免干等退避冷却（最长 30s）才切回皮卡鱼。
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') retryOfflineEngineNow();
    });
    return () => sub.remove();
  }, []);

  if (!needsWebViewEngineHost()) return null;

  // ⚠️ 资源解析失败**不能**抛到渲染期（会把整个 App 打崩）。
  // 解析不出来时就不挂宿主：引擎启动会因承载未就绪而走兜底 + 退避重试，
  // 界面显示"皮卡鱼启动中/基础AI"，而不是白屏崩溃。
  let source;
  try {
    source = getEngineHostSource();
  } catch (err) {
    console.warn('[OfflineEngine] 引擎离线页解析失败，跳过 WebView 宿主:', err);
    return null;
  }
  return <PikafishWebViewHost source={source} />;
}

export default function RootLayout() {
  return (
    <Provider>
      <View style={{ flex: 1 }}>
        <Stack
          screenOptions={{
            animation: 'slide_from_right',
            gestureEnabled: true,
            gestureDirection: 'horizontal',
            headerShown: false
          }}
        >
          <Stack.Screen name="index" options={{ title: "" }} />
          <Stack.Screen name="pveSetup" options={{ title: "人机对战" }} />
          <Stack.Screen name="game" options={{ title: "对弈", gestureEnabled: false }} />
          <Stack.Screen name="endgame" options={{ title: "残局闯关" }} />
          <Stack.Screen name="endgameEdit" options={{ title: "残局摆棋" }} />
          <Stack.Screen name="lanGame" options={{ title: "在线对局" }} />
          <Stack.Screen name="lanBattle" options={{ title: "在线对局", gestureEnabled: false }} />
          <Stack.Screen name="spectate" options={{ title: "观战", gestureEnabled: false }} />
          <Stack.Screen name="replay" options={{ title: "历史对局" }} />
          <Stack.Screen name="replayPlayer" options={{ title: "复盘" }} />
        </Stack>
        <OfflineEngineHost />
      </View>
    </Provider>
  );
}
