import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { COLORS, ELEVATION, NOTICE_DURATION_MS, RADIUS, Z_INDEX } from '@/constants/modal';
import { FONT } from '@/utils/typography';

export interface GameNoticeItem {
  /** 唯一 key：同一 key 重复触发会重置计时而不是堆叠 */
  key: string;
  /** 主提示文案 */
  text: string;
  /** 可选副标题（如请求方、原因说明） */
  detail?: string;
  /** 停留时长（毫秒），默认 3000 */
  duration?: number;
}

export interface GameNoticeProps {
  /** 当前提示（null 表示不展示） */
  notice: GameNoticeItem | null;
  /**
   * 提示条中心的纵向位置，单位与父容器一致（像素）。
   *
   * 优先用它精确覆盖棋盘中心：对局页的提示条父容器是整屏主容器，而棋盘在其中
   * 因标题行/底部栏的纵向预算并不居中，按容器 50% 定位会明显偏上。
   * 未传时退回 centerRatio（相对父容器高度的百分比，默认 0.5）。
   */
  centerY?: number;
  /** 覆盖棋盘中心的纵向位置（0~1，默认 0.5），仅在未传 centerY 时生效 */
  centerRatio?: number;
  /** 水平最大宽度，默认跟随棋盘宽度（约屏幕 - 32） */
  maxWidth?: number;
  style?: StyleProp<ViewStyle>;
  onHide?: () => void;
}

/**
 * GameNotice / GameToast —— 对局内低干扰提示条（棋盘中央深色半透明条）
 *
 * 设计目标（重构前这些提示用的是 `Alert.alert`，在 Web 上是空实现 → 完全无显示）：
 * 1. **非阻塞**：绝对定位在棋盘上方居中，`pointerEvents="box-none"`，
 *    不拦截棋盘点击；点遮罩也不会关闭（它本身没有遮罩）。
 * 2. **自动消失**：默认 3s 后淡出；重复同 key 会重置计时。
 * 3. **不遮挡局面**：只有文字条，不覆盖棋盘中心的大部分视野，替代了原本的 Alert 弹窗。
 *
 * Android 层级：容器同时设置 zIndex 与 elevation，防止被棋盘遮挡。
 */
export default function GameNotice({
  notice,
  centerY,
  centerRatio = 0.5,
  maxWidth,
  style,
  onHide,
}: GameNoticeProps) {
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeKey = notice?.key ?? null;
  const duration = notice?.duration ?? NOTICE_DURATION_MS;

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    Animated.timing(opacity, {
      toValue: 0,
      duration: 200,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      // 【C-76】start 的回调不区分「跑完」与「被 stop 打断」。连续提示时（例如「将军」
      //   紧跟「吃子」）新动画会打断旧的淡出，而旧动画的完成回调照样触发 → setVisible(false)
      //   把刚弹出的新提示抹掉。只有自然结束才允许收尾。
      if (!finished) return;
      setVisible(false);
      onHide?.();
    });
  }, [opacity, onHide]);

  const show = useCallback(
    (durationMs: number) => {
      setVisible(true);
      opacity.setValue(0);
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(hide, durationMs);
    },
    [hide, opacity],
  );

  useEffect(() => {
    if (activeKey) {
      show(duration);
    } else if (visible) {
      hide();
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // 仅在 key 变化时重新计时：detail 文案变化不应重置用户剩余阅读时间
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const containerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      styles.container,
      // 优先按像素锚定棋盘中心；缺锚点时才退回百分比（Animated.View 的 style 类型
      // 不接受普通 string，兜底分支显式断言为 ViewStyle 后由 RN 运行时按百分比解析）
      centerY != null
        ? { top: centerY }
        : ({ top: `${centerRatio * 100}%` } as unknown as ViewStyle),
      maxWidth != null ? { maxWidth } : null,
      style,
    ],
    [centerY, centerRatio, maxWidth, style],
  );

  if (!notice) return null;

  return (
    <Animated.View
      // 绝对定位在棋盘之上居中：非阻塞，不吃掉棋盘的点击
      // （box-none 只作用于本节点，子节点要靠自己的 pointerEvents="none"，见下方 inner）
      pointerEvents="box-none"
      style={[containerStyle, { opacity }]}
      collapsable={false}
    >
      <View
        // 【C-74】内层必须显式 none：pointerEvents 不向下传递，容器的 box-none 只让
        //   「自己」不命中，子 View 仍参与命中测试 —— 提示条可见的这 3 秒里，棋盘中部
        //   整块被它吞掉，点自己的棋子没反应。提示条本身不需要任何交互。
        pointerEvents="none"
        style={styles.inner}
        collapsable={false}
      >
        <Text style={styles.text} numberOfLines={4}>
          {notice.text}
        </Text>
        {!!notice.detail && (
          <Text style={styles.detail} numberOfLines={3}>
            {notice.detail}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    transform: [{ translateY: '-50%' }],
    // 棋盘容器自身有 elevation，仅 zIndex 不足以盖住，需同时设置 elevation
    zIndex: Z_INDEX.overlay,
    elevation: ELEVATION.overlay,
  },
  inner: {
    maxWidth: '92%',
    backgroundColor: COLORS.noticeBg,
    borderRadius: RADIUS.notice,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  text: {
    fontSize: FONT.control,
    fontWeight: '700',
    color: COLORS.noticeText,
    textAlign: 'center',
  },
  detail: {
    marginTop: 6,
    fontSize: FONT.caption,
    color: 'rgba(255, 255, 255, 0.85)',
    textAlign: 'center',
  },
});
