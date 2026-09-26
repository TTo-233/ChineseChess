import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { COLORS, RADIUS, SIZES, type ModalButtonVariant } from '@/constants/modal';
import { FONT } from '@/utils/typography';

export interface ModalButtonProps {
  label: string;
  onPress: () => void;
  /** 按钮变体：primary 主操作 / secondary 次操作 / danger 危险 / success 同意 */
  variant?: ModalButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * ModalButton —— 统一弹窗按钮（终结重构前 5 套散乱类名）
 *
 * 重构前存在 `modalButton` / `modalButtonConfirm` / `modalCancelButton` /
 * `modalButtonDanger` / `modalDeleteButton` 五套命名与 3 档圆角，
 * 现统一为 4 个语义变体 + 单一圆角 `RADIUS.modalButton`。
 */
export function ModalButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
  testID,
}: ModalButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <TouchableOpacity
      testID={testID}
      style={[
        styles.button,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        variant === 'success' && styles.buttonSuccess,
        isDisabled && styles.buttonDisabled,
        style,
      ]}
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.85}
    >
      {loading ? (
        <ActivityIndicator size="small" color={variant === 'secondary' ? COLORS.modalPrimary : '#FFFFFF'} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            variant === 'secondary' && styles.buttonTextSecondary,
            isDisabled && styles.buttonTextDisabled,
          ]}
        >
          {label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flex: 1,
    minWidth: 96,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: RADIUS.modalButton,
    backgroundColor: COLORS.modalPrimary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSecondary: {
    backgroundColor: COLORS.modalSecondaryBg,
    borderWidth: 1,
    borderColor: COLORS.modalBorder,
  },
  buttonDanger: {
    backgroundColor: COLORS.modalDanger,
  },
  buttonSuccess: {
    backgroundColor: COLORS.modalSuccess,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: FONT.control,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  buttonTextSecondary: {
    color: COLORS.modalTextMuted,
  },
  buttonTextDisabled: {
    color: '#FFFFFF',
  },
});

export default ModalButton;

/** 供 AppDialog 复用的统一按钮行容器样式（flex 按钮 + 12 间距） */
export const modalButtonRowStyle: ViewStyle = {
  flexDirection: 'row',
  gap: 12,
  width: '100%',
};

/** 内容区统一上边距（标题与正文之间） */
export const modalBodyGapStyle: ViewStyle = {
  marginBottom: SIZES.modalPadding - 8,
};
