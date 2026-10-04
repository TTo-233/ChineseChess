import React from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  useWindowDimensions,
  View,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  COLORS,
  ELEVATION,
  RADIUS,
  SIZES,
  Z_INDEX,
  type ModalCloseBtnType,
  type ModalVariant,
} from '@/constants/modal';
import { FONT } from '@/utils/typography';

export interface AppModalProps {
  /** 是否展示 */
  visible: boolean;
  /** 关闭回调（点击遮罩/关闭键/物理返回键统一走这里） */
  onClose: () => void;
  /** 标题（省略则不渲染标题区） */
  title?: string;
  /**
   * 自定义标题内容，优先级高于 title。
   *
   * 用于标题需要可点击/可交互的场景（例如「连续点击标题 N 次解锁隐藏功能」）：
   * AppModal 内部仍负责居中与行高，只把渲染权交给调用方。
   */
  titleNode?: React.ReactNode;
  /**
   * 遮罩风格：
   *   dark  = rgba(0,0,0,0.5)，默认，绝大多数弹窗使用
   *   light = rgba(245,240,232,0.92)，lanBattle 等「棋盘仍需可辨认」场景
   *   none  = 完全透明，仅保留不可见的点击拦截层（低干扰浮层）
   */
  variant?: ModalVariant | 'none';
  /** 卡片位置：center 居中；bottom 贴底（不遮挡棋盘中心） */
  placement?: 'center' | 'bottom';
  /**
   * 弹窗卡片中心锚点（窗口坐标）。用于「对局中弹窗须位于棋盘中心」的场景：
   * RN <Modal> 渲染在独立原生窗口，其坐标系是窗口，而棋盘位置由动态布局预算决定
   * 未必与屏幕中心重合（棋盘受纵向预算压缩时会明显偏移）。
   * 传入后遮罩仍走 placement 的原有 flex 定位（卡片宽高/内边距约束不变），仅把卡片
   * 从「屏幕中心」平移到锚点，保证卡片不会因绝对定位而贴边或溢出；
   * 未传时行为与既往完全一致。
   */
  anchorCenter?: { x: number; y: number } | null;
  /** 是否展示关闭控件 */
  showCloseBtn?: boolean;
  /** 关闭控件样式：icon 图标 X / text 文字「关闭」 */
  closeBtnType?: ModalCloseBtnType;
  /** 状态栏透明（默认 true，保持与既有弹窗一致） */
  statusBarTranslucent?: boolean;
  /**
   * 强交互场景（选边、认输/悔棋/求和等）必须阻断 Android 物理返回键，
   * 传 true 后 onRequestClose 不再执行 onClose，避免用户误退出弹窗而状态未落地。
   */
  blockBackButton?: boolean;
  /** 点击遮罩是否关闭（默认 false：既有弹窗均不因点遮罩而关闭） */
  dismissOnMaskPress?: boolean;
  /** 内容区样式（可覆盖内边距） */
  bodyStyle?: StyleProp<ViewStyle>;
  /** 卡片样式（可覆盖圆角、宽度、maxHeight 等） */
  cardStyle?: StyleProp<ViewStyle>;
  /** 键盘弹出时是否避让（表单类弹窗使用） */
  avoidKeyboard?: boolean;
  children: React.ReactNode;
}

/**
 * AppModal —— 全应用统一的基础全屏弹窗
 *
 * 统一收敛了此前散落各处的遮罩色、卡片圆角、宽度约束与物理返回键行为：
 * 内部固定使用 `<Modal transparent animationType="fade" statusBarTranslucent>`。
 * 焦点/层级：遮罩层同时设置 zIndex 与 elevation，防止 Android 上被棋盘遮挡
 * （棋盘容器自身设了 elevation，仅 zIndex 不足以盖住）。
 */
export default function AppModal({
  visible,
  onClose,
  title,
  titleNode,
  variant = 'dark',
  placement = 'center',
  showCloseBtn = false,
  closeBtnType = 'icon',
  statusBarTranslucent = true,
  blockBackButton = false,
  dismissOnMaskPress = false,
  bodyStyle,
  cardStyle,
  avoidKeyboard = false,
  anchorCenter = null,
  children,
}: AppModalProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  // 强交互场景直接吞掉返回键（no-op），而不是调用 onClose
  const handleRequestClose = blockBackButton ? () => undefined : onClose;

  const maskStyle = [
    styles.mask,
    variant === 'light' && styles.maskLight,
    variant === 'none' && styles.maskTransparent,
    placement === 'bottom' ? styles.maskBottom : styles.maskCenter,
  ];

  // 锚点修正：遮罩仍按 placement 正常居中/贴底（卡片宽高约束保持不变），
  // 只把卡片从「屏幕中心」平移到锚点中心——避免绝对定位下 width:'100%' 的百分比基准歧义。
  // 前提是 placement==='center'（遮罩 padding 上下左右对称，卡片中心仍等于屏幕中心）；
  // 传 bottom 组合时基准会是「底部条带中心」，调用方须自行换算锚点。
  const anchorOffsetStyle = anchorCenter
    ? ({
        transform: [
          { translateX: anchorCenter.x - windowWidth / 2 },
          { translateY: anchorCenter.y - windowHeight / 2 },
        ],
      } as const)
    : null;

  const handleMaskPress = () => {
    if (Platform.OS === 'web') {
      Keyboard.dismiss();
      return;
    }
    if (dismissOnMaskPress) onClose();
  };

  const body = (
    <TouchableWithoutFeedback onPress={handleMaskPress} disabled={!dismissOnMaskPress}>
      <View style={maskStyle} collapsable={false}>
        {/* 卡片 */}
        <TouchableWithoutFeedback onPress={() => Keyboard.dismiss()}>
          <View style={[styles.card, placement === 'bottom' && styles.cardBottom, cardStyle, anchorOffsetStyle]}>
            {((!!title || !!titleNode) || showCloseBtn) && (
              <View style={styles.header}>
                <View style={styles.headerSpacer} />
                {!!titleNode ? (
                  <View style={styles.titleHost}>{titleNode}</View>
                ) : (
                  !!title && (
                    <Text style={styles.title} numberOfLines={2}>
                      {title}
                    </Text>
                  )
                )}
                <View style={styles.headerSpacer}>
                  {showCloseBtn && (
                    closeBtnType === 'text' ? (
                      <Pressable onPress={onClose} hitSlop={8}>
                        <Text style={styles.closeText}>关闭</Text>
                      </Pressable>
                    ) : (
                      <Pressable onPress={onClose} hitSlop={10} style={styles.closeIconBtn}>
                        <FontAwesome6 name="xmark" size={16} color={COLORS.modalTextMuted} />
                      </Pressable>
                    )
                  )}
                </View>
              </View>
            )}
            <View style={[styles.body, bodyStyle]}>{children}</View>
          </View>
        </TouchableWithoutFeedback>
      </View>
    </TouchableWithoutFeedback>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent={statusBarTranslucent}
      onRequestClose={handleRequestClose}
    >
      {avoidKeyboard ? (
        <KeyboardAvoidingView
          style={styles.keyboardAvoider}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {body}
        </KeyboardAvoidingView>
      ) : (
        body
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    zIndex: Z_INDEX.overlay,
    // ⚠️ 这里刻意【不设】elevation。
    // 遮罩是整屏透明/半透明底板，它本就在最顶层，elevation 对遮挡关系没有任何贡献；
    // 但 Android 会把设了 elevation>0 的 View 提升为独立 RenderNode 离屏合成层。
    // 遮罩一旦被提升，弹窗出现时底层页面会被拆成多个合成层逐层 alpha 混合，
    // 在部分机型/色彩空间下会在合成层边界产生 1px 硬边的偏亮竖条（实机截图量到
    // 屏幕中心 640 处约 108px 宽、幅度 2~24 级的亮带，且不覆盖不透明的弹窗卡片）。
    // 真正的层级需求只是「卡片不能被棋盘内部 elevation 浮层压住」，
    // 那一层由 styles.card 上的 elevation 承担，遮罩无需提升。
  },
  maskCenter: {
    backgroundColor: COLORS.modalOverlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SIZES.modalPadding,
  },
  maskBottom: {
    backgroundColor: COLORS.modalOverlay,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: SIZES.modalPadding,
    paddingBottom: SIZES.modalPadding * 2,
  },
  maskLight: {
    backgroundColor: COLORS.modalOverlayLight,
  },
  /** 完全透明遮罩：仅拦截点击，不在视觉上遮挡下层 */
  maskTransparent: {
    backgroundColor: 'transparent',
  },
  keyboardAvoider: {
    flex: 1,
  },
  card: {
    width: '100%',
    minWidth: SIZES.modalMinWidth,
    maxWidth: SIZES.modalMaxWidth,
    maxHeight: SIZES.modalMaxHeight,
    backgroundColor: COLORS.modalCard,
    borderRadius: RADIUS.modalCard,
    borderWidth: 1,
    borderColor: COLORS.modalBorder,
    // ⚠️ 这里刻意【不设】overflow:'hidden'。
    // 房间设置类弹窗的下拉选项面板与点击遮罩都是 absolute 定位，并刻意向外扩出
    // body 内边距（见 RoomSettingsControls.formStyles.selectBackdrop 的负 margin，
    // 以及 selectPanel 的 top:'100%' 悬浮）。一旦在卡片上裁剪，展开的下拉面板会被
    // 圆角处切掉、点不到。高度问题已由 body 的 minHeight:0 + ScrollView 的
    // flexShrink:1 解决，不需要靠裁剪兜底。
    zIndex: Z_INDEX.overlay,
    elevation: ELEVATION.overlay,
  },
  cardBottom: {
    maxHeight: '46%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SIZES.modalPadding,
    paddingTop: SIZES.modalPadding,
    paddingBottom: 4,
    gap: 8,
  },
  /** 让标题真正居中：左右两侧占位块宽度一致（关闭键为图标时略窄，故固定等宽） */
  headerSpacer: {
    width: 32,
    alignItems: 'flex-end',
  },
  title: {
    flex: 1,
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.modalText,
    textAlign: 'center',
  },
  /** titleNode 的承载容器：与 title 同样的 flex/居中，保证自定义标题视觉位置一致 */
  titleHost: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeIconBtn: {
    width: 28,
    height: 28,
    borderRadius: RADIUS.modalButton,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.modalSecondaryBg,
  },
  closeText: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.modalTextMuted,
  },
  body: {
    padding: SIZES.modalPadding,
    paddingTop: SIZES.modalPadding - 4,
    // ⚠️ minHeight:0 是「内容超高时内部滚动」的关键，不能删。
    // 卡片有 maxHeight:88%，但 flex 子项的自动最小尺寸等于其内容尺寸：内容一旦超过
    // 卡片上限，body（以及它内部 flexGrow:0 的 ScrollView）都不肯收缩，直接把内容
    // 顶出卡片下沿——实机表现为短屏机型上「取消/创建」按钮溢出弹窗、点不到。
    // minHeight:0 解除这个自动最小尺寸，卡片才会封顶、ScrollView 才会真正滚动。
    minHeight: 0,
  },
});
