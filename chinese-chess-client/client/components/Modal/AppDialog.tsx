import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import AppModal from './AppModal';
import { ModalButton, modalButtonRowStyle } from './ModalButton';
import { COLORS, type ModalButtonVariant } from '@/constants/modal';
import { FONT } from '@/utils/typography';

export interface AppDialogProps {
  visible: boolean;
  title: string;
  /** 正文内容：字符串或自定义节点（受限于卡片宽度） */
  message?: string | React.ReactNode;
  /** 确认键文案 */
  confirmText?: string;
  /** 取消键文案（省略则不渲染取消键） */
  cancelText?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  /** 危险操作：确认键切换为 danger 变体（替代原先内联覆盖 backgroundColor 的写法） */
  danger?: boolean;
  /** 确认键变体显式指定（优先于 danger） */
  confirmVariant?: ModalButtonVariant;
  /** 确认键 loading（替换为 ActivityIndicator） */
  loading?: boolean;
  /** 强交互场景（认输/悔棋/求和）阻断 Android 物理返回键 */
  blockBackButton?: boolean;
  /** 遮罩风格（默认 dark；低干扰场景可传 light/none） */
  variant?: 'dark' | 'light' | 'none';
  /** 贴底呈现（悔棋/求和等需要看清棋盘的场景） */
  placement?: 'center' | 'bottom';
  /**
   * 卡片中心锚点（窗口坐标）：对局中弹窗须位于棋盘中心时传入。
   * 传入后卡片在 placement 原有定位的基础上平移到锚点（宽高约束不变），
   * 因此须传窗口坐标而非容器相对坐标；见 AppModal.anchorCenter。
   */
  anchorCenter?: { x: number; y: number } | null;
}

/**
 * AppDialog —— 统一确认/提示型弹窗（Header 标题 / Body 正文 / Footer 1-2 个按钮）
 *
 * 适用：认输确认、重开确认、保存对局、删除对局、退出房间等「一句话 + 一到两个选择」的场景。
 * 重构前这些场景各写一份 Modal + 局部按钮样式，标题居中/靠左、按钮圆角都不一致。
 */
export default function AppDialog({
  visible,
  title,
  message,
  confirmText = '确定',
  cancelText,
  onConfirm,
  onCancel,
  danger = false,
  confirmVariant,
  loading = false,
  blockBackButton = false,
  variant = 'dark',
  placement = 'center',
  anchorCenter = null,
}: AppDialogProps) {
  const variantOfConfirm: ModalButtonVariant = confirmVariant ?? (danger ? 'danger' : 'primary');
  const hasCancel = !!onCancel;

  return (
    <AppModal
      visible={visible}
      // 【C-79】单键弹窗不再把返回键接到确认动作。
      // AppModal 用 onRequestClose 承接 Android 物理返回键（AppModal.tsx:102/174），
      // 此前 `onClose={hasCancel ? onCancel! : onConfirm}` 让"只有确认键"的弹窗一按
      // 返回就执行确认。当前唯一单键调用方（game/index.tsx:1450 残局说明）无害，
      // 但 AppDialog 是通用组件：将来「删除对局 / 认输 / 退出房间」这类单键确认弹窗
      // 一接上，返回键立刻变成误确认入口。
      // 修复方式（两处协同，单键时语义才完整）：
      //   ① 单键时 onClose 传空操作 —— 即使别的路径走到 onClose（AppModal 的关闭图标键）
      //      也不会顺手执行确认；
      //   ② 下方 blockBackButton 补 `|| !hasCancel` —— 返回键被直接吞掉。
      // 两处都不引入新 prop：单键弹窗本来就该由它唯一的按钮来关闭。若某天确实需要
      // "返回键 = 关闭"，给该调用方补一个 onCancel（或改用双键形式）即可显式表达。
      onClose={hasCancel ? onCancel! : () => undefined}
      title={title}
      variant={variant}
      placement={placement}
      anchorCenter={anchorCenter}
      blockBackButton={blockBackButton || !hasCancel}
      // 确认类弹窗不支持点遮罩关闭，避免误触丢失输入
      dismissOnMaskPress={false}
    >
      <View style={styles.body}>
        {typeof message === 'string' ? (
          <Text style={styles.message}>{message}</Text>
        ) : (
          message
        )}
        <View style={[modalButtonRowStyle, !hasCancel && styles.singleButtonRow]}>
          {hasCancel && (
            <ModalButton
              label={cancelText ?? '取消'}
              variant="secondary"
              onPress={onCancel!}
              testID="app-dialog-cancel"
            />
          )}
          <ModalButton
            label={confirmText}
            variant={variantOfConfirm}
            onPress={onConfirm}
            loading={loading}
            testID="app-dialog-confirm"
          />
        </View>
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  body: {
    alignItems: 'stretch',
  },
  message: {
    fontSize: FONT.body,
    lineHeight: 21,
    color: COLORS.modalTextMuted,
    textAlign: 'center',
    marginBottom: 20,
  },
  singleButtonRow: {
    justifyContent: 'center',
  },
});
