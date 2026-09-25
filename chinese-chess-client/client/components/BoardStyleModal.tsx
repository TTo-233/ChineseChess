/**
 * 棋盘样式选择弹窗
 *
 * 首页「设置」入口打开：展示全部棋盘样式（预览图 + 名称 + 描述），
 * 点选即时生效并持久化（boardStyleStore），所有棋盘场景同步切换。
 */

import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Image,
  TouchableWithoutFeedback,
  Keyboard,
  Platform,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { BOARD_STYLES, type BoardStyle } from '@/utils/chess/boardStyles';
import { useBoardStyle, setBoardStyleId } from '@/utils/chess/boardStyleStore';

const COLORS = {
  primary: '#8B6914',
  bg: '#F5F0E8',
  bgCard: '#FFF8F0',
  text: '#3E2723',
  textMuted: '#8D6E63',
  border: '#D7CCC8',
};

interface BoardStyleModalProps {
  visible: boolean;
  onClose: () => void;
}

/** 单个样式卡片（顶层组件，避免渲染期重建） */
function StyleCard({
  style,
  selected,
  onSelect,
}: {
  style: BoardStyle;
  selected: boolean;
  onSelect: (id: BoardStyle['id']) => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={() => onSelect(style.id)}
      style={[styles.card, selected && styles.cardSelected]}
    >
      <View style={[styles.thumbWrap, selected && styles.thumbWrapSelected]}>
        <Image
          source={style.normalImage}
          style={styles.thumb}
          resizeMode="cover"
        />
        {selected && (
          <View style={styles.checkBadge}>
            <FontAwesome6 name="check" size={11} color="#FFF8F0" />
          </View>
        )}
      </View>
      <Text style={[styles.cardName, selected && styles.cardNameSelected]} numberOfLines={1}>
        {style.name}
      </Text>
      <Text style={styles.cardDesc} numberOfLines={1}>
        {style.desc}
      </Text>
    </TouchableOpacity>
  );
}

export default function BoardStyleModal({ visible, onClose }: BoardStyleModalProps) {
  const current = useBoardStyle();

  const handleSelect = (id: BoardStyle['id']) => {
    // 即时生效并持久化；失败时本次会话内仍生效
    void setBoardStyleId(id);
  };

  return (
    <Modal visible={visible} transparent animationType="fade">
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} disabled={Platform.OS === 'web'}>
        <View style={styles.mask}>
          <View style={styles.panel}>
            {/* Header */}
            <View style={styles.header}>
              <View style={styles.headerIcon}>
                <FontAwesome6 name="chess-board" size={16} color={COLORS.primary} />
              </View>
              <View style={styles.headerTexts}>
                <Text style={styles.title}>棋盘样式</Text>
                <Text style={styles.subtitle}>所选样式将应用于对局、复盘与摆棋棋盘</Text>
              </View>
              <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
                <FontAwesome6 name="xmark" size={15} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>

            {/* 样式卡片 */}
            <View style={styles.cardRow}>
              {BOARD_STYLES.map((s) => (
                <StyleCard
                  key={s.id}
                  style={s}
                  selected={s.id === current.id}
                  onSelect={handleSelect}
                />
              ))}
            </View>

            {/* Footer */}
            <TouchableOpacity style={styles.doneBtn} onPress={onClose} activeOpacity={0.8}>
              <Text style={styles.doneBtnText}>完成</Text>
            </TouchableOpacity>
          </View>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    backgroundColor: 'rgba(30, 20, 10, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  panel: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: COLORS.bgCard,
    borderRadius: 20,
    padding: 20,
    boxShadow: '0px 12px 32px rgba(62, 39, 35, 0.25)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(139, 105, 20, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  headerTexts: {
    flex: 1,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.text,
  },
  subtitle: {
    fontSize: 11,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardRow: {
    flexDirection: 'row',
    gap: 10,
  },
  card: {
    flex: 1,
    borderRadius: 14,
    backgroundColor: COLORS.bg,
    padding: 8,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'stretch',
  },
  cardSelected: {
    borderColor: COLORS.primary,
    backgroundColor: '#FBF3E4',
  },
  thumbWrap: {
    borderRadius: 10,
    overflow: 'hidden',
    aspectRatio: 0.9,
    position: 'relative',
  },
  thumbWrapSelected: {
    // 选中态仅外框高亮，缩略图不加额外装饰
  },
  thumb: {
    width: '100%',
    height: '100%',
  },
  checkBadge: {
    position: 'absolute',
    right: 6,
    top: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0px 2px 6px rgba(62, 39, 35, 0.35)',
  },
  cardName: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
  },
  cardNameSelected: {
    color: COLORS.primary,
  },
  cardDesc: {
    marginTop: 2,
    fontSize: 10,
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  doneBtn: {
    marginTop: 18,
    height: 44,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0px 6px 14px rgba(139, 105, 20, 0.3)',
  },
  doneBtnText: {
    color: '#FFF8F0',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 2,
  },
});
