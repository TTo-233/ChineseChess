/**
 * 「样式设置」弹窗
 *
 * 首页右上角样式按钮打开。弹窗内含两个分页：
 *   - 棋盘：选择棋盘样式（boardStyles / boardStyleStore）
 *   - 背景：选择对局界面整屏背景图（backgroundStyles / backgroundStyleStore）
 *
 * 两页均为「点选即时生效并持久化」，样式一并延续应用的米黄古纸主题
 * （色值取自各屏同款的 local COLORS，不引入新的主题模块）。
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  ScrollView,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { AppModal, ModalButton, modalButtonRowStyle } from '@/components/Modal';
import { BOARD_STYLES, type BoardStyle } from '@/utils/chess/boardStyles';
import { useBoardStyle, setBoardStyleId } from '@/utils/chess/boardStyleStore';
import {
  BACKGROUND_STYLES,
  type BackgroundStyle,
} from '@/utils/chess/backgroundStyles';
import {
  useBackgroundStyle,
  setBackgroundStyleId,
} from '@/utils/chess/backgroundStyleStore';
import { FONT } from '@/utils/typography';

const COLORS = {
  primary: '#8B6914',
  bg: '#F5F0E8',
  bgCard: '#FFF8F0',
  text: '#3E2723',
  textMuted: '#8D6E63',
  border: '#D7CCC8',
};

/** 分页 id */
type SettingsTab = 'board' | 'background';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'board', label: '棋盘' },
  { id: 'background', label: '背景' },
];

/** 背景缩略图卡的宽度；高度 = 宽度 / 0.45，与 1080x2400 素材比例一致 */
const BG_CARD_WIDTH = 96;
const BG_CARD_GAP = 10;
/** 1080 / 2400 */
const BG_THUMB_ASPECT = 0.45;

interface StyleSettingsModalProps {
  visible: boolean;
  onClose: () => void;
}

/** 棋盘样式卡片（顶层组件，避免渲染期重建） */
function BoardStyleCard({
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
      <View style={styles.thumbWrap}>
        <Image source={style.normalImage} style={styles.thumb} resizeMode="cover" />
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

/** 背景样式卡片（顶层组件，避免渲染期重建） */
function BackgroundStyleCard({
  style,
  selected,
  onSelect,
}: {
  style: BackgroundStyle;
  selected: boolean;
  onSelect: (id: BackgroundStyle['id']) => void;
}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={() => onSelect(style.id)}
      style={[styles.bgCard, selected && styles.cardSelected]}
    >
      <View style={styles.bgThumbWrap}>
        {style.image ? (
          // 缩略图与素材同比例(0.45)，cover 等价于完整显示整幅画
          <Image source={style.image} style={styles.thumb} resizeMode="cover" />
        ) : (
          // 「默认」= 纯色底，无图可显，给一块实色样片
          <View style={[styles.thumb, styles.bgNoneSwatch]} />
        )}
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

export default function StyleSettingsModal({ visible, onClose }: StyleSettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>('board');
  const currentBoard = useBoardStyle();
  const currentBackground = useBackgroundStyle();

  const handleSelectBoard = (id: BoardStyle['id']) => {
    // 即时生效并持久化；失败时本次会话内仍生效
    void setBoardStyleId(id);
  };

  const handleSelectBackground = (id: BackgroundStyle['id']) => {
    void setBackgroundStyleId(id);
  };

  return (
    <AppModal
      visible={visible}
      onClose={onClose}
      title="样式设置"
      showCloseBtn
      cardStyle={styles.widePanel}
      bodyStyle={styles.body}
    >
      {/* 分页切换 */}
      <View style={styles.tabs}>
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <TouchableOpacity
              key={t.id}
              activeOpacity={0.85}
              onPress={() => setTab(t.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {tab === 'board' ? (
        <>
          <Text style={styles.subtitle}>所选样式将应用于对局、复盘与摆棋棋盘</Text>
          <View style={styles.cardRow}>
            {BOARD_STYLES.map((s) => (
              <BoardStyleCard
                key={s.id}
                style={s}
                selected={s.id === currentBoard.id}
                onSelect={handleSelectBoard}
              />
            ))}
          </View>
        </>
      ) : (
        <>
          <Text style={styles.subtitle}>所选背景将铺满对局、观战与复盘界面</Text>
          {/* 横向 ScrollView 必须由一层普通 View 包裹（仓库自定义 eslint 规则
              reactnative/wrap-horizontal-scrollview-inside-view）。这里不只是为了过 lint：
              外层 View 把滚动区限定在弹窗体宽内，否则横滑手势会和 AppModal 的
              遮罩/滚动抢触摸。 */}
          <View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.bgRow}
            >
              {BACKGROUND_STYLES.map((s) => (
                <BackgroundStyleCard
                  key={s.id}
                  style={s}
                  selected={s.id === currentBackground.id}
                  onSelect={handleSelectBackground}
                />
              ))}
            </ScrollView>
          </View>
        </>
      )}

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
  // ---- 分页切换 ----
  tabs: {
    flexDirection: 'row',
    backgroundColor: COLORS.bg,
    borderRadius: 10,
    padding: 3,
    marginTop: 4,
    marginBottom: 14,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: COLORS.bgCard,
    boxShadow: '0px 1px 4px rgba(62, 39, 35, 0.16)',
  },
  tabText: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  tabTextActive: {
    color: COLORS.primary,
    fontWeight: '700',
  },
  // ---- 公共 ----
  subtitle: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 2,
    marginBottom: 14,
    textAlign: 'center',
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
  cardRow: {
    flexDirection: 'row',
    gap: 10,
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
  // ---- 背景分页 ----
  /**
   * 背景卡片不参与 flex 均分，改用固定宽度 + 横向滚动：
   * 素材是 9:20 的竖图，5 张平铺到一行会被压到 50px 上下，看不懂画面。
   */
  bgRow: {
    flexDirection: 'row',
    gap: BG_CARD_GAP,
    paddingHorizontal: 2,
    paddingBottom: 2,
  },
  bgCard: {
    width: BG_CARD_WIDTH,
    borderRadius: 14,
    backgroundColor: COLORS.bg,
    padding: 8,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'stretch',
  },
  bgThumbWrap: {
    borderRadius: 10,
    overflow: 'hidden',
    aspectRatio: BG_THUMB_ASPECT,
    position: 'relative',
  },
  bgNoneSwatch: {
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
});
