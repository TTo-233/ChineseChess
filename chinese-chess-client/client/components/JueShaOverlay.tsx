/**
 * 绝杀特效组件 - 与开源项目 JueSha.xaml 完全一致
 *
 * 素材布局（基于原项目629x695棋盘网格区域）：
 * - "绝"组: 位于左上 (0,0)，大"绝"270x270 + 小"绝"100x90 居中重叠
 * - "杀"组: 偏移(69,34)，大"杀"270x270 + 小"杀"100x90 居中重叠
 * - 底部背景: 偏移(29,74)，尺寸310x220
 *
 * 动画时间线（已取消红色背景闪烁，各阶段前移）：
 * - 大"绝": 0~2.0s opacity 1→0
 * - 小"绝": 0~1.5s opacity 0→1
 * - 大"杀": 0.3~2.6s opacity 1→0
 * - 小"杀": 0.3~1.8s opacity 0→1
 * - 底部背景: 1.5~2.0s opacity 0→1
 * - 按钮: 2.5s 淡入
 * - 不淡出，保持最终画面
 */
import React, { useEffect, useState } from 'react';
import { Animated, Image, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { COLORS as MODAL_COLORS, RADIUS } from '@/constants/modal';
import { FONT } from '@/utils/typography';

// 大"绝"图片: 270x270 位于 (0,0)
const JUE1_SIZE = 270;
// 小"绝"图片: 100x90 位于 (85,90)（在270x270中居中）
const JUE5_WIDTH = 100;
const JUE5_HEIGHT = 90;
const JUE5_LEFT = (JUE1_SIZE - JUE5_WIDTH) / 2;
const JUE5_TOP = (JUE1_SIZE - JUE5_HEIGHT) / 2;

// "杀"组偏移
const SHA_OFFSET_X = 69;
const SHA_OFFSET_Y = 34;

// 大"杀"图片: 270x270 位于 (69,34)
const SHA1_SIZE = 270;
// 小"杀"图片: 100x90 位于 (69+85, 34+90) = (154,124)
const SHA5_WIDTH = 100;
const SHA5_HEIGHT = 90;
const SHA5_LEFT = SHA_OFFSET_X + (SHA1_SIZE - SHA5_WIDTH) / 2;
const SHA5_TOP = SHA_OFFSET_Y + (SHA1_SIZE - SHA5_HEIGHT) / 2;

// 底部背景: 310x220 位于 (29,74)
const TUOBA_WIDTH = 310;
const TUOBA_HEIGHT = 220;
const TUOBA_LEFT = 29;
const TUOBA_TOP = 74;

// 内容包围盒
const CONTENT_WIDTH = 339;  // max(270, 69+270, 29+310) = 339
const CONTENT_HEIGHT = 304; // max(270, 34+270, 74+220) = 304

// 【C-87】原文件顶部还有 GRID_WIDTH=631 / GRID_HEIGHT=697 与派生的
// CENTER_OFFSET_X / CENTER_OFFSET_Y（按"在旧口径棋盘网格内居中"算的偏移）。
// 四者都已删除：中心对齐早已改由 contentLeft/contentTop 基于传入的 boardFrame
// （boardCenterX/Y）计算，无传入时才退回屏幕居中；而 631/697 是陈旧的原始图片口径
// （现样式参数在 @/utils/chess/boardStyles 里逐样式给出），留着只会让人以为居中
// 仍由这些常量决定。

interface JueShaOverlayProps {
  visible: boolean;
  onPlayAgain?: () => void;
  onGoHome?: () => void;
  resultText?: string;
  /** 主按钮文案（默认"再来一局"） */
  primaryText?: string;
  /** 次按钮文案（默认"返回首页"） */
  secondaryText?: string;
  /** 残局闯关：过关后展示"下一关"按钮 */
  onNextLevel?: () => void;
  nextLevelText?: string;
  /**
   * 棋盘在浮层容器中的实际位置与尺寸（动态布局预算下棋盘尺寸/位置会变化）。
   * 传入后：绝杀动画锁定棋盘中心、结果文字与按钮排到棋盘正下方；
   * 未传入（null/undefined）时退回"屏幕居中"兜底，保证向后兼容。
   */
  boardFrame?: { x: number; y: number; width: number; height: number } | null;
  /**
   * 是否播放「绝/杀」字符特效。默认 true（绝杀/困毙终局）。
   * 认输/和棋/断线判负等非绝杀终局传 false：不播字符特效，仅淡入结果文字与按钮。
   */
  showEffect?: boolean;
}

export default function JueShaOverlay({
  visible,
  onPlayAgain,
  onGoHome,
  resultText,
  primaryText = '再来一局',
  secondaryText = '返回首页',
  onNextLevel,
  nextLevelText = '下一关',
  boardFrame,
  showEffect = true,
}: JueShaOverlayProps) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const [jue1Opacity] = useState(() => new Animated.Value(0));
  const [jue5Opacity] = useState(() => new Animated.Value(0));
  const [sha1Opacity] = useState(() => new Animated.Value(0));
  const [sha5Opacity] = useState(() => new Animated.Value(0));
  const [tuobaOpacity] = useState(() => new Animated.Value(0));
  const [buttonsOpacity] = useState(() => new Animated.Value(0));
  // 【C-73】按钮是否已可交互（淡入完成才置 true）。opacity 不参与 RN 的命中测试，
  // 而容器是 pointerEvents="box-none"（不传递给子节点）→ buttonsArea 这块全宽覆盖层
  // 在淡入前同样能吃到点击，于是绝杀动画播放的 2.5 秒里「看不见的按钮」可以误触
  // （点棋盘下半部实际命中「下一关 / 再来一局 / 返回首页」）。故显式按进度切 pointerEvents。
  const [buttonsReady, setButtonsReady] = useState(false);

  useEffect(() => {
    if (!visible) return;

    // 初始状态
    jue1Opacity.setValue(0);
    jue5Opacity.setValue(0);
    sha1Opacity.setValue(0);
    sha5Opacity.setValue(0);
    tuobaOpacity.setValue(0);
    buttonsOpacity.setValue(0);
    // 【C-73】这是"每轮动画开始前把按钮区退回不可交互"的复位，不是从 props/state
    // 派生的值：动画进度本身在 Animated.Value 上，buttonsReady 必须在 visible 每次
    // 翻 true 时归零，否则会沿用上一轮残留的 true，导致新一轮淡入前那一帧仍能命中
    // 不可见的按钮。改成渲染期复位或推迟到下一宏任务都会重新引入这个命中窗口。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setButtonsReady(false);

    let interactiveTimer: ReturnType<typeof setTimeout> | null = null;

    // 非绝杀终局（认输/和棋/断线判负）：不播「绝/杀」字符特效，直接淡入结果文字与按钮
    if (!showEffect) {
      Animated.timing(buttonsOpacity, { toValue: 1, duration: 300, useNativeDriver: true }).start();
      interactiveTimer = setTimeout(() => setButtonsReady(true), 300);
    } else {
      Animated.parallel([
        // 大"绝": 0~2.0s opacity 1→0
        Animated.sequence([
          Animated.timing(jue1Opacity, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(jue1Opacity, { toValue: 0, duration: 2000, useNativeDriver: true }),
        ]),
        // 小"绝": 0~1.5s opacity 0→1
        Animated.timing(jue5Opacity, { toValue: 1, duration: 1500, useNativeDriver: true }),
        // 大"杀": 0.3~2.6s opacity 1→0
        Animated.sequence([
          Animated.delay(300),
          Animated.timing(sha1Opacity, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(sha1Opacity, { toValue: 0, duration: 2300, useNativeDriver: true }),
        ]),
        // 小"杀": 0.3~1.8s opacity 0→1
        Animated.sequence([
          Animated.delay(300),
          Animated.timing(sha5Opacity, { toValue: 1, duration: 1500, useNativeDriver: true }),
        ]),
        // 底部背景: 1.5~2.0s opacity 0→1
        Animated.sequence([
          Animated.delay(1500),
          Animated.timing(tuobaOpacity, { toValue: 1, duration: 500, useNativeDriver: true }),
        ]),
        // 按钮: 2.5s 淡入
        Animated.sequence([
          Animated.delay(2500),
          Animated.timing(buttonsOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
        ]),
      ]).start();
      // 与上面的 Animated.delay(2500) + 400ms 淡入保持同一节奏：完全可见后才可点
      interactiveTimer = setTimeout(() => setButtonsReady(true), 2500 + 400);
    }

    return () => {
      if (interactiveTimer) clearTimeout(interactiveTimer);
    };
  }, [visible, showEffect]);

  if (!visible) return null;

  // 棋盘几何：优先用传入的真实棋盘位置（动态布局预算下棋盘尺寸/位置会变化），
  // 未传入时退回"屏幕居中"估算，保证向后兼容
  const boardW = boardFrame ? boardFrame.width : screenWidth - 16;
  const boardCenterX = boardFrame ? boardFrame.x + boardFrame.width / 2 : screenWidth / 2;
  const boardCenterY = boardFrame ? boardFrame.y + boardFrame.height / 2 : screenHeight / 2;
  const boardBottom = boardFrame
    ? boardFrame.y + boardFrame.height
    : screenHeight / 2 + ((screenWidth - 16) / 631 * 842) / 2;

  // 缩放比例：内容包围盒宽度约为棋盘宽度的 80%（随动态棋盘大小自适应，兜底防止过小）
  const scale = Math.max((boardW * 0.8) / CONTENT_WIDTH, 0.1);
  const contentW = CONTENT_WIDTH * scale;
  const contentH = CONTENT_HEIGHT * scale;

  // 绝杀动画锁定棋盘中心
  const contentLeft = boardCenterX - contentW / 2;
  const contentTop = boardCenterY - contentH / 2;

  // 结果文字与按钮排到棋盘正下方（与棋盘底边留少量间距；紧凑排布以落入底部栏预留区 + 底部安全区内）
  const buttonsTop = boardBottom + 6;

  return (
    <View style={styles.container} pointerEvents="box-none">
      {/* 内容区域 - 锁定棋盘中心（仅绝杀/困毙终局播放；认输/和棋/断线判负不展示） */}
      {showEffect && (
      <View style={[
        styles.contentArea,
        {
          left: contentLeft,
          top: contentTop,
          width: contentW,
          height: contentH,
        }
      ]}>
        {/* 底部背景（拖把图） */}
        <Animated.View style={[
          styles.tuobaContainer,
          {
            left: (TUOBA_LEFT - 0) * scale,
            top: (TUOBA_TOP - 0) * scale,
            width: TUOBA_WIDTH * scale,
            height: TUOBA_HEIGHT * scale,
            opacity: tuobaOpacity,
          }
        ]}>
          <Image
            source={require('@/assets/juesha_bg.png')}
            style={styles.fullImage}
            resizeMode="contain"
          />
        </Animated.View>

        {/* 大"绝" */}
        <Animated.View style={[
          styles.charGroup,
          {
            left: 0,
            top: 0,
            width: JUE1_SIZE * scale,
            height: JUE1_SIZE * scale,
            opacity: jue1Opacity,
          }
        ]}>
          <Image
            source={require('@/assets/juesha_da_jue.png')}
            style={styles.fullImage}
            resizeMode="contain"
          />
        </Animated.View>

        {/* 小"绝" */}
        <Animated.View style={[
          styles.charGroup,
          {
            left: JUE5_LEFT * scale,
            top: JUE5_TOP * scale,
            width: JUE5_WIDTH * scale,
            height: JUE5_HEIGHT * scale,
            opacity: jue5Opacity,
          }
        ]}>
          <Image
            source={require('@/assets/juesha_xiao_jue.png')}
            style={styles.fullImage}
            resizeMode="contain"
          />
        </Animated.View>

        {/* 大"杀" */}
        <Animated.View style={[
          styles.charGroup,
          {
            left: SHA_OFFSET_X * scale,
            top: SHA_OFFSET_Y * scale,
            width: SHA1_SIZE * scale,
            height: SHA1_SIZE * scale,
            opacity: sha1Opacity,
          }
        ]}>
          <Image
            source={require('@/assets/juesha_da_sha.png')}
            style={styles.fullImage}
            resizeMode="contain"
          />
        </Animated.View>

        {/* 小"杀" */}
        <Animated.View style={[
          styles.charGroup,
          {
            left: SHA5_LEFT * scale,
            top: SHA5_TOP * scale,
            width: SHA5_WIDTH * scale,
            height: SHA5_HEIGHT * scale,
            opacity: sha5Opacity,
          }
        ]}>
          <Image
            source={require('@/assets/juesha_xiao_sha.png')}
            style={styles.fullImage}
            resizeMode="contain"
          />
        </Animated.View>
      </View>
      )}

      {/* 结果提示条 + 按钮区域：结果文字以 GameNotice 样式（棋盘中央深色半透明条，
          非全屏遮罩，棋盘仍然可辨认）呈现；操作按钮排在棋盘正下方 */}
      {/* 结果文字无交互，pointerEvents="none" 让它不参与命中测试（box-none 不传递到子节点） */}
      <Animated.View
        pointerEvents="none"
        style={[styles.noticeArea, { opacity: buttonsOpacity, top: boardCenterY }]}
      >
        {resultText ? (
          <View style={styles.resultBar}>
            <Text style={styles.resultText}>{resultText}</Text>
          </View>
        ) : null}
      </Animated.View>

      {/* 【C-73】淡入完成前整块不参与命中测试，避免「看不见的按钮」被误触；
          容器 pointerEvents="box-none" 不会传递给子节点，所以要挂在这一层（buttonsArea 自身
          是全宽绝对定位的覆盖层，命中面积远大于按钮本身）。 */}
      <Animated.View
        pointerEvents={buttonsReady ? 'box-none' : 'none'}
        style={[styles.buttonsArea, { opacity: buttonsOpacity, top: buttonsTop }]}
      >
        <View style={styles.buttonsRow}>
          {onNextLevel && (
            <TouchableOpacity style={styles.buttonPrimary} onPress={onNextLevel}>
              <Text style={styles.buttonPrimaryText}>{nextLevelText}</Text>
            </TouchableOpacity>
          )}
          {onPlayAgain && (
            <TouchableOpacity style={styles.buttonPrimary} onPress={onPlayAgain}>
              <Text style={styles.buttonPrimaryText}>{primaryText}</Text>
            </TouchableOpacity>
          )}
          {onGoHome && (
            <TouchableOpacity style={styles.buttonSecondary} onPress={onGoHome}>
              <Text style={styles.buttonSecondaryText}>{secondaryText}</Text>
            </TouchableOpacity>
          )}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    // Android 上棋盘内部存在 elevation 层，仅 zIndex 不足以盖住，需同时给 elevation
    elevation: 100,
    justifyContent: 'center',
    alignItems: 'center',
  },
  contentArea: {
    position: 'absolute',
  },
  charGroup: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tuobaContainer: {
    position: 'absolute',
  },
  fullImage: {
    width: '100%',
    height: '100%',
  },
  noticeArea: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    transform: [{ translateY: '-50%' }],
  },
  /**
   * 结果提示条：与对局内 GameNotice 同一视觉规范（@/constants/modal 的 COLORS.noticeBg /
   * RADIUS.notice / 16-24 内边距），只是不自动消失——结算必须等用户选择去留。
   */
  resultBar: {
    backgroundColor: MODAL_COLORS.noticeBg,
    borderRadius: RADIUS.notice,
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  buttonsArea: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  resultText: {
    fontSize: FONT.control,
    fontWeight: '700',
    color: MODAL_COLORS.noticeText,
    textAlign: 'center',
  },
  buttonsRow: {
    flexDirection: 'row',
    gap: 16,
  },
  buttonPrimary: {
    backgroundColor: '#8B0000',
    paddingHorizontal: 32,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 120,
    alignItems: 'center',
  },
  buttonPrimaryText: {
    color: '#FFFFFF',
    fontSize: FONT.control,
    fontWeight: '600',
  },
  buttonSecondary: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 32,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 120,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#D4C4A8',
  },
  buttonSecondaryText: {
    color: '#5D4037',
    fontSize: FONT.body,
    fontWeight: '600',
  },
});
