import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LogBox, Text, TextInput } from 'react-native';
import { Provider } from '@/components/Provider';

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

export default function RootLayout() {
  return (
    <Provider>
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
    </Provider>
  );
}
