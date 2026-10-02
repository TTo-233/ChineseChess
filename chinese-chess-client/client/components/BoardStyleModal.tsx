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
  TouchableOpacity,
  StyleSheet,
  Image,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { AppModal, ModalButton, modalButtonRowStyle } from '@/components/Modal';
import { BOARD_STYLES, type BoardStyle } from '@/utils/chess/boardStyles';
import { useBoardStyle, setBoardStyleId } from '@/utils/chess/boardStyleStore';
import { FONT } from '@/utils/typography';

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
    <AppModal
      visible={visible}
      onClose={onClose}
      title="棋盘样式"
      showCloseBtn
      cardStyle={styles.widePanel}
      bodyStyle={styles.body}
    >
      <Text style={styles.subtitle}>所选样式将应用于对局、复盘与摆棋棋盘</Text>

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
      <View style={[modalButtonRowStyle, styles.footer]}>
        <ModalButton label="完成" onPress={onClose} />
      </View>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  /**
   * 样式选择弹窗是全应用最宽的一张卡片（缩略图一行并排），
   * 在 AppModal 默认的 SIZES.modalMaxWidth(360) 基础上放宽一档。
   */
  widePanel: {
    maxWidth: 420,
  },
  body: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  subtitle: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 2,
    marginBottom: 14,
    textAlign: 'center',
  },
  cardRow: {
    flexDirection: 'row',
    gap: 10,
  },
  footer: {
    marginTop: 18,
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
    fontSize: FONT.body,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
  },
  cardNameSelected: {
    color: COLORS.primary,
  },
  cardDesc: {
    marginTop: 2,
    fontSize: FONT.micro,
    color: COLORS.textMuted,
    textAlign: 'center',
  },
});
