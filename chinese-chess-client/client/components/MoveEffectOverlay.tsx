/**
 * 对局吃子 / 将军特效浮层
 *
 * 设计目标：醒目但不突兀
 * - 入场：淡入 + 回弹式缩放（0.55 → 1.04 → 1.0），无闪烁、无全屏遮挡
 * - 停留：短暂展示（吃子约 0.5s，将军约 0.7s）
 * - 退场：淡出 + 轻微放大消散
 * - 浮层 pointerEvents="none"，绝不拦截棋盘触摸
 *
 * 加载性能：
 * - 组件常驻挂载（闲置时整体 opacity 0），两张素材始终渲染、仅以透明度切换，
 *   棋盘一加载即完成图片解码：首次播放与 吃/将军 种类切换均无解码延迟。
 *
 * 连续将军节流策略由调用方实现（见 hooks/useMoveEffect）：
 * 本组件只负责按 seq 变化重播动画。
 * - 挂载守卫：组件挂载瞬间不主动播放（防止棋盘重开/remount 时残留特效重播），
 *   仅响应挂载后 seq 的递增变化。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StyleSheet } from 'react-native';

export type MoveEffectKind = 'capture' | 'check';

export interface MoveEffect {
  kind: MoveEffectKind;
  /** 每次触发递增，相同 kind 也需重播动画 */
  seq: number;
}

interface MoveEffectOverlayProps {
  effect: MoveEffect | null;
  /** 棋盘图片的显示尺寸（用于居中与特效尺寸换算） */
  boardWidth: number;
  boardHeight: number;
}

// 特效素材（透明底：金色书法字 + 水墨圆环）
const EFFECT_IMAGE_CAPTURE = require('@/assets/effect_chi.png');
const EFFECT_IMAGE_CHECK = require('@/assets/effect_jiangjun.png');
// 素材宽高比（高/宽）：吃 600×600，将军 600×600
const CAPTURE_ASPECT = 600 / 600;
const CHECK_ASPECT = 600 / 600;

interface KindConfig {
  /** 特效宽度占棋盘宽比例 */
  sizeRatio: number;
  /** 素材宽高比（高/宽） */
  aspect: number;
  /** 峰值不透明度 */
  peakOpacity: number;
  fadeInMs: number;
  scaleInMs: number;
  holdMs: number;
  fadeOutMs: number;
}

const KIND_CONFIG: Record<MoveEffectKind, KindConfig> = {
  capture: {
    sizeRatio: 0.32,
    aspect: CAPTURE_ASPECT,
    peakOpacity: 1,
    fadeInMs: 160,
    scaleInMs: 240,
    holdMs: 480,
    fadeOutMs: 300,
  },
  check: {
    sizeRatio: 0.32,
    aspect: CHECK_ASPECT,
    peakOpacity: 1,
    fadeInMs: 190,
    scaleInMs: 280,
    holdMs: 680,
    fadeOutMs: 340,
  },
};

/**
 * 各特效完整播放时长（淡入 + 停留 + 淡出 + 缩放收尾余量），
 * 供对局逻辑在触发特效后延时后续动作（如推迟 AI 落子，避免特效被打断）。
 */
export const MOVE_EFFECT_DURATION_MS: Record<MoveEffectKind, number> = {
  capture: KIND_CONFIG.capture.fadeInMs + KIND_CONFIG.capture.holdMs + KIND_CONFIG.capture.fadeOutMs + 110,
  check: KIND_CONFIG.check.fadeInMs + KIND_CONFIG.check.holdMs + KIND_CONFIG.check.fadeOutMs + 110,
};

export default function MoveEffectOverlay({ effect, boardWidth, boardHeight }: MoveEffectOverlayProps) {
  const [opacity] = useState(() => new Animated.Value(0));
  const [scale] = useState(() => new Animated.Value(0.55));

  const seq = effect?.seq ?? 0;
  // 归一化：仅识别 capture / check（闲置时按 check 布局保持素材常驻解码；
  // 同时兼容热更新残留的旧 kind，如已移除的 check-mini，避免查表越界）
  const kind: MoveEffectKind = effect?.kind === 'capture' ? 'capture' : 'check';

  // 挂载守卫：仅播放挂载后 seq 递增触发的特效，挂载瞬间的残留 seq 不重播
  const mountedSeqRef = useRef(seq);

  useEffect(() => {
    if (seq <= 0 || seq === mountedSeqRef.current) return;
    mountedSeqRef.current = seq;
    const cfg = KIND_CONFIG[kind];

    opacity.stopAnimation();
    scale.stopAnimation();
    opacity.setValue(0);
    scale.setValue(0.55);

    const animation = Animated.parallel([
      // 透明度：淡入 → 停留 → 淡出
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: cfg.peakOpacity,
          duration: cfg.fadeInMs,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(cfg.holdMs),
        Animated.timing(opacity, {
          toValue: 0,
          duration: cfg.fadeOutMs,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
      // 缩放：回弹入场（0.55→1.04→1.0）→ 退场微放大消散
      Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.04,
          duration: cfg.scaleInMs,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1.0,
          duration: 110,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(Math.max(0, cfg.holdMs - 110)),
        Animated.timing(scale, {
          toValue: 1.07,
          duration: cfg.fadeOutMs,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    ]);
    animation.start();

    return () => animation.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, kind]);

  const cfg = KIND_CONFIG[kind];
  const effectWidth = Math.round(boardWidth * cfg.sizeRatio);
  const effectHeight = Math.round(effectWidth * cfg.aspect);

  return (
    <Animated.View
      pointerEvents="none"
      collapsable={false}
      style={[
        styles.host,
        {
          left: Math.round((boardWidth - effectWidth) / 2),
          // 垂直略偏上（视觉重心），避免遮挡刚落下的棋子
          top: Math.round((boardHeight - effectHeight) / 2 - boardHeight * 0.03),
          width: effectWidth,
          height: effectHeight,
          opacity,
          transform: [{ scale }],
        },
      ]}
    >
      {/* 双图常驻、透明度切换：首次播放与种类切换均无图片解码延迟；
          fadeDuration={0} 关闭 Android 默认的图片淡入，避免与动画叠加 */}
      <Image
        source={EFFECT_IMAGE_CAPTURE}
        style={[styles.image, kind !== 'capture' && styles.hidden]}
        resizeMode="contain"
        fadeDuration={0}
      />
      <Image
        source={EFFECT_IMAGE_CHECK}
        style={[styles.image, styles.imageOverlap, kind === 'capture' && styles.hidden]}
        resizeMode="contain"
        fadeDuration={0}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    zIndex: 60,
    elevation: 60,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imageOverlap: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  hidden: {
    opacity: 0,
  },
});
