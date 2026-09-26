/**
 * 在线对局房间设置表单共享控件（大厅创建房间弹窗 / 房间内设置弹窗 共用，保证样式布局一致）
 * 包含：对战设置选项常量、SettingSelect 悬浮下拉、表单网格与输入框样式
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';

const COLORS = {
  background: '#F5EFE6',
  card: '#FFF8F0',
  primary: '#8B6914',
  textPrimary: '#3E2723',
  textSecondary: '#5D4037',
  textLight: '#8D6E63',
  border: 'rgba(139, 105, 20, 0.15)',
};

// ===== 对战设置选项（局时 + 加秒制 / 读秒制）=====
export const BASE_TIME_OPTIONS = [
  { value: 0, label: '不限时' },
  { value: 60, label: '1分钟' },
  { value: 180, label: '3分钟' },
  { value: 300, label: '5分钟' },
  { value: 600, label: '10分钟' },
  { value: 900, label: '15分钟' },
  { value: 1200, label: '20分钟' },
  { value: 1800, label: '30分钟' },
];
export const TURN_TIME_OPTIONS = [
  { value: 0, label: '不限' },
  { value: 15, label: '15秒' },
  { value: 30, label: '30秒' },
  { value: 60, label: '60秒' },
  { value: 90, label: '90秒' },
  { value: 120, label: '120秒' },
];
export const INCREMENT_OPTIONS = [0, 2, 3, 5, 10, 15, 30].map(v => ({ value: v, label: v === 0 ? '关闭' : `${v}秒` }));
// 读秒：局时耗尽后每步的固定思考时长（与加秒互斥）
export const BYOYOMI_OPTIONS = [0, 10, 20, 30, 60].map(v => ({ value: v, label: v === 0 ? '关闭' : `${v}秒` }));

export interface SelectOption { value: number; label: string }

/** 设置项下拉选择器（主题统一风格：标签 + 圆角值框 + 主色三角按钮；展开时悬浮显示选项） */
export function SettingSelect({ label, valueText, options, open, onToggle, onSelect, disabled }: {
  label: string;
  valueText: string;
  options: SelectOption[];
  open: boolean;
  onToggle: () => void;
  onSelect: (value: number) => void;
  disabled?: boolean;
}) {
  // 选项面板悬浮展开：绝对定位覆盖于下方内容之上，不挤压弹窗布局
  return (
    <View style={[styles.selectCol, open && !disabled && styles.selectColOpen]}>
      <View style={styles.selectRow}>
        <Text style={styles.selectLabel}>{label}</Text>
        <TouchableOpacity
          style={[styles.selectPill, disabled && styles.selectPillDisabled]}
          onPress={disabled ? undefined : onToggle}
          activeOpacity={0.8}
        >
          <Text style={[styles.selectPillText, disabled && styles.selectPillTextDisabled]} numberOfLines={1}>
            {valueText}
          </Text>
          <View style={styles.selectArrowBtn}>
            <FontAwesome6 name={open ? 'caret-up' : 'caret-down'} size={12} color={disabled ? COLORS.textLight : COLORS.primary} />
          </View>
        </TouchableOpacity>
      </View>
      {open && !disabled && (
        <View style={styles.selectPanel}>
          {options.map(opt => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.selectOption, opt.label === valueText && styles.selectOptionActive]}
              onPress={() => onSelect(opt.value)}
            >
              <Text style={[styles.selectOptionText, opt.label === valueText && styles.selectOptionTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

/** 房间设置表单共享样式（名称/密码行、下拉网格、分区标题、提示、让子汇总、遮罩） */
export const formStyles = StyleSheet.create({
  // 房间名 + 密码 同行双列
  fieldRowInline: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  fieldCol: {
    flex: 1,
  },
  fieldLabel: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginBottom: 6,
  },
  fieldInput: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    color: COLORS.textPrimary,
  },
  // 只读值展示框（非房主/对局阶段查看模式，与输入框同款视觉）
  fieldValueBox: {
    backgroundColor: COLORS.background,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  fieldValueText: {
    fontSize: 15,
    color: COLORS.textPrimary,
  },
  settingsSectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginTop: 14,
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: 2,
  },
  selectGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 8,
  },
  // 行内有面板展开时抬升整行层级（Android 需要 elevation 参与堆叠）
  selectGridOpen: {
    zIndex: 100,
    elevation: 10,
  },
  selectHint: {
    fontSize: 12,
    color: COLORS.textLight,
    marginTop: 2,
    marginBottom: 4,
  },
  hcSummary: {
    fontSize: 12,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: 6,
  },
  // 面板展开时的透明遮罩：点击面板外任意处收起
  selectBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
  },
});

const styles = StyleSheet.create({
  selectCol: {
    flex: 1,
    position: 'relative',
  },
  // 展开时抬升整列层级，保证悬浮面板盖过后续内容
  selectColOpen: {
    zIndex: 100,
    elevation: 10,
  },
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  selectLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textSecondary,
    width: 30,
  },
  selectPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(139, 105, 20, 0.25)',
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 5,
  },
  selectPillDisabled: {
    opacity: 0.55,
  },
  selectPillText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.textSecondary,
  },
  selectPillTextDisabled: {
    color: COLORS.textLight,
  },
  selectArrowBtn: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: 'rgba(139, 105, 20, 0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 悬浮选项面板：绝对定位 + 阴影浮于下方内容之上，展开不挤压布局
  selectPanel: {
    position: 'absolute',
    top: '100%',
    left: 36,
    right: 0,
    marginTop: 8,
    backgroundColor: COLORS.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(139, 105, 20, 0.25)',
    padding: 6,
    // 单列纵向列表：选项逐行排列，避免窄面板下折行成多列
    flexDirection: 'column',
    gap: 6,
    shadowColor: '#422006',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 10,
  },
  selectOption: {
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  selectOptionActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  selectOptionText: {
    fontSize: 12,
    color: COLORS.textSecondary,
  },
  selectOptionTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});
