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
  /** 覆盖棋盘中心的纵向位置（0~1，默认 0.5） */
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
    }).start(() => {
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
      // 百分比定位：Animated.View 的 style 类型不接受普通 string，
      // 显式断言为 ViewStyle 后由 RN 运行时按百分比解析
      { top: `${centerRatio * 100}%` } as unknown as ViewStyle,
      maxWidth != null ? { maxWidth } : null,
      style,
    ],
    [centerRatio, maxWidth, style],
  );

  if (!notice) return null;

  return (
    <Animated.View
      // 绝对定位在棋盘之上居中：非阻塞，不吃掉棋盘的点击
      pointerEvents="box-none"
      style={[containerStyle, { opacity }]}
      collapsable={false}
    >
      <View style={styles.inner} collapsable={false}>
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
