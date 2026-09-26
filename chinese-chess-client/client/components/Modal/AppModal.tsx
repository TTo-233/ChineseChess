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
   * 遮罩风格：
   *   dark  = rgba(0,0,0,0.5)，默认，绝大多数弹窗使用
   *   light = rgba(245,240,232,0.92)，lanBattle 等「棋盘仍需可辨认」场景
   *   none  = 完全透明，仅保留不可见的点击拦截层（低干扰浮层）
   */
  variant?: ModalVariant | 'none';
  /** 卡片位置：center 居中；bottom 贴底（不遮挡棋盘中心） */
  placement?: 'center' | 'bottom';
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
  children,
}: AppModalProps) {
  // 强交互场景直接吞掉返回键（no-op），而不是调用 onClose
  const handleRequestClose = blockBackButton ? () => undefined : onClose;

  const maskStyle = [
    styles.mask,
    variant === 'light' && styles.maskLight,
    variant === 'none' && styles.maskTransparent,
    placement === 'bottom' ? styles.maskBottom : styles.maskCenter,
  ];

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
          <View style={[styles.card, placement === 'bottom' && styles.cardBottom, cardStyle]}>
            {(!!title || showCloseBtn) && (
              <View style={styles.header}>
                <View style={styles.headerSpacer} />
                {!!title && (
                  <Text style={styles.title} numberOfLines={2}>
                    {title}
                  </Text>
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
    // Android 上棋盘内部存在 elevation 层，仅 zIndex 不足以盖住，需同时给 elevation
    elevation: ELEVATION.overlay,
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
  },
});
