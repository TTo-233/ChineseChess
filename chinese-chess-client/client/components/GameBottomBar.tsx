/**
 * 对局界面底部操作栏（2026-10 布局改造）。
 *
 * 设计来源：产品参考截图的移动端底栏 —— 屏幕最底端一条通栏，一排「图标 + 文字」的竖排按钮，
 * 点击「菜单」向上弹出一张深色卡片列表（卡片底部带一个朝下的小三角指向菜单键）。
 * 本组件只负责这套视觉与交互外壳，具体每个键的图标/文案/行为由对局页通过 props 注入，
 * 因此人机对战 / 残局闯关 / 在线对局 / 观战 / 复盘多个模式共用一份实现。
 *
 * 与被替换掉的旧实现（各页内的 styles.bottomBar + styles.actionButton）的差异：
 * 1. 旧的是「带边框的胶囊按钮横排」，高度随按钮内边距浮动，且各页手写 phase/jueShaVisible
 *    分支时容易漏掉占位元素，造成棋盘高度预算抖动；这里高度固定为常量
 *    BOTTOM_BAR_HEIGHT，布局预算引用同一常量，图标在 icon↔spinner 间切换也不改变高度。
 * 2. 本组件由对局页放在 boardHost **之外**（作为主容器的最后一个子节点），
 *    因此底栏固定在屏幕最底端，棋盘上下的留白不再把底栏往下/往上带。
 * 3. 「菜单」弹出列表是绝对定位浮层，不占纵向流内高度，展开/收起不会推挤棋盘。
 * 4. 展开期间的遮罩溢出到全屏（负 inset），吞掉误触棋盘的落子点击。
 *
 * 配色：底栏底色直接复用 `@/constants/modal` 的 `COLORS.noticeBg`（与 GameNotice 提示条
 * 同一枚 token 的透明黑）。选透明黑而非实色，是为了后续能在 `barBackgroundImage` 传入
 * 木纹/纹理底图而不必改结构——图铺在底色之上，图上再压一层半透明黑保证文字对比度。
 * 2026-10 实机核对：noticeBg = rgba(0,0,0,0.65)，在浅色木纹上已足够压住底图并保证米白文字对比度；
 * barScrim 仅在传入底图时额外叠加，不传图时该 View 不渲染，底色就是纯 noticeBg。
 *
 * 剩余次数角标（提示/悔棋）沿用旧口径：按钮右上角红色圆形数字标识。
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { ImageSourcePropType } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { COLORS as MODAL_COLORS, ELEVATION, Z_INDEX } from '@/constants/modal';
import { FONT } from '@/utils/typography';

/**
 * 底栏按钮区高度（不含底部安全区内边距），布局预算按此常量预留，
 * 切换图标/角标不改变。底栏整体高度 = 本常量 + bottomInset。
 */
export const BOTTOM_BAR_HEIGHT = 62;

/** 底栏配色：与 GameNotice 同款透明黑底 + 米白图标文字 */
const COLORS = {
  barBg: MODAL_COLORS.noticeBg,
  /** 铺了背景图时再压一层，保证米白文字在浅色木纹上也够清晰 */
  barScrim: 'rgba(0, 0, 0, 0.35)',
  /** 底栏与棋盘之间的分隔发丝线（深底上用浅色，浅色棋盘上也能分辨） */
  barBorder: 'rgba(255, 255, 255, 0.14)',
  itemText: '#F2E8DC',
  itemDisabled: 'rgba(242, 232, 220, 0.38)',
  popupBg: '#3A3733',
  popupBorder: '#5A534C',
  popupText: '#F2E8DC',
  badgeBg: '#C62828',
  badgeBorder: 'rgba(255, 255, 255, 0.85)',
};

/** FontAwesome6 图标名（全站统一走 @expo/vector-icons，沿用现有图标体系） */
export type GameBottomBarIcon =
  | 'bars'
  | 'arrow-left'
  | 'lightbulb'
  | 'rotate-left'
  | 'rotate-right'
  | 'backward-step'
  | 'forward-step'
  | 'arrows-rotate'
  | 'door-open'
  | 'flag'
  | 'handshake'
  | 'circle-check'
  | 'gear';

/** 「菜单」弹出列表里的一项 */
export interface GameMenuItem {
  /** 稳定 key */
  key: string;
  /** 左侧线性图标 */
  icon: GameBottomBarIcon;
  /** 右侧文案 */
  label: string;
  /** 禁用态（禁用时仍展示但不可点，用于说明为何不可用） */
  disabled?: boolean;
  /** 点击回调 */
  onPress?: () => void;
}

/** 底栏按键的公共字段（不含 key / onPress，两者由下面的联合按 key 区分） */
interface GameBottomBarActionBase {
  icon: GameBottomBarIcon;
  label: string;
  disabled?: boolean;
  /** 右上角剩余次数角标；null/undefined 表示不展示 */
  badge?: number | null;
}

/** key 为 'menu' 的按钮：点击切换弹出列表，由组件内部接管，无需 onPress */
export interface GameBottomBarMenuAction extends GameBottomBarActionBase {
  key: 'menu';
}

/**
 * 普通底栏按键：**onPress 必填**。
 * 早期实现里 onPress 是可选的，忘接回调不会报错，按钮却按下毫无反应；
 * 这里用联合类型让它在 tsc 阶段就失败（TS2741 缺少 onPress）。
 */
export interface GameBottomBarAction extends GameBottomBarActionBase {
  key: string;
  onPress: () => void;
}

/** 传入 actions 的元素联合：非菜单键必须带 onPress */
export type GameBottomBarActionInput = GameBottomBarAction | GameBottomBarMenuAction;

export interface GameBottomBarProps {
  /** 底栏主按钮（从左到右），各键等分整条宽度；除菜单键外都必须提供 onPress */
  actions: GameBottomBarActionInput[];
  /** 「菜单」弹出列表；为空数组或未提供时不渲染弹出层（菜单键点击无效果） */
  menuItems?: GameMenuItem[];
  /** 底栏不可见（如绝杀特效播放中）：隐藏但保留占位，避免棋盘位置移动 */
  hidden?: boolean;
  /**
   * 底部安全区高度（useSafeAreaInsets().bottom）：作为底栏内边距撑开，
   * 使底栏背景一直铺到屏幕物理底边，而不是悬在 Home Indicator 之上。
   */
  bottomInset?: number;
  /** 可选底图（木纹/纹理）；不传则只显示透明黑底色 */
  barBackgroundImage?: ImageSourcePropType;
  /** 按钮行宽度样式（跟随棋盘本体宽度，见 boardAlignedRowStyle）；未传则铺满通栏 */
  widthStyle?: object;
  /** 外层附加样式（如上边距） */
  style?: object;
}

export default function GameBottomBar({
  actions,
  menuItems,
  hidden = false,
  bottomInset = 0,
  barBackgroundImage,
  widthStyle,
  style,
}: GameBottomBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // 按钮行实测宽度（px）：弹出卡片按像素算宽度（窄屏文案不溢出），
  // 首帧为 0，PopupMenu 内部回退到屏幕宽。
  const [rowWidth, setRowWidth] = useState(0);
  const hasMenu = !!menuItems && menuItems.length > 0;
  // 菜单键在 actions 里的下标：'menu' 命中则该键展开/收起弹出列表
  const menuIndex = actions.findIndex(a => a.key === 'menu');

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const handleAction = useCallback(
    (action: GameBottomBarActionInput) => {
      if (action.disabled) return;
      // 菜单键由组件内部接管为「展开/收起弹出列表」，不走上面的 onPress
      if (action.key === 'menu') {
        if (hasMenu) setMenuOpen(prev => !prev);
        return;
      }
      closeMenu();
      // 非菜单键的 onPress 在 GameBottomBarAction 中是必填（类型层面保证漏接会报错）；
      // 用 `in` 收窄是因为普通键的 key 类型是 string，覆盖了 'menu' 字面量。
      if ('onPress' in action) action.onPress();
    },
    [hasMenu, closeMenu]
  );

  const handleMenuItem = useCallback(
    (item: GameMenuItem) => {
      if (item.disabled) return;
      closeMenu();
      item.onPress?.();
    },
    [closeMenu]
  );

  const renderItem = (action: GameBottomBarActionInput, index: number) => {
    const showBadge = action.badge !== undefined && action.badge !== null;
    return (
      <Pressable
        key={action.key}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        accessibilityState={{ disabled: !!action.disabled }}
        disabled={action.disabled}
        onPress={() => handleAction(action)}
        style={({ pressed }) => [
          styles.actionItem,
          pressed && !action.disabled && styles.actionItemPressed,
          menuIndex === index && menuOpen && styles.actionItemActive,
        ]}
      >
        <View style={styles.iconFrame}>
          <FontAwesome6
            name={action.icon}
            size={22}
            color={action.disabled ? COLORS.itemDisabled : COLORS.itemText}
          />
          {showBadge && (
            <View style={styles.badge}>
              <Text allowFontScaling={false} style={styles.badgeText}>
                {action.badge}
              </Text>
            </View>
          )}
        </View>
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          style={[styles.actionLabel, action.disabled && { color: COLORS.itemDisabled }]}
        >
          {action.label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.wrap, style]} pointerEvents="box-none">
      {/* 底栏主体：通栏铺到屏幕底边，paddingBottom 撑开底部安全区，
          按钮行居中且宽度跟随棋盘本体（宽屏下不横贯整个屏幕）。 */}
      <View
        style={[styles.bar, bottomInset > 0 && { paddingBottom: bottomInset }, hidden && styles.barHidden]}
        pointerEvents={hidden ? 'none' : 'box-none'}
      >
        {/* 可选底图 + 压暗层：图铺在透明黑底色之上，后续接入木纹只需传图不改结构 */}
        {barBackgroundImage && (
          <>
            <Image source={barBackgroundImage} resizeMode="cover" style={styles.barImage} />
            <View style={styles.barScrim} pointerEvents="none" />
          </>
        )}

        {/* 弹出列表先渲染：遮罩铺在按钮之下，展开时点「菜单」仍能收起，点其它键则直接执行并收起 */}
        <View
          style={[styles.itemRow, widthStyle ?? styles.itemRowFull]}
          pointerEvents="box-none"
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            setRowWidth((prev) => (prev === w ? prev : w));
          }}
        >
          <PopupMenu
            visible={menuOpen}
            items={menuItems ?? []}
            anchorIndex={menuIndex}
            actionCount={actions.length}
            rowWidth={rowWidth}
            onBackdropPress={closeMenu}
            onItemPress={handleMenuItem}
          />
          {actions.map(renderItem)}
        </View>
      </View>
    </View>
  );
}

// ==================== Popup Menu ====================

interface PopupMenuProps {
  visible: boolean;
  items: GameMenuItem[];
  /** 弹出卡片水平对齐的按钮下标（-1 = 左对齐整条） */
  anchorIndex: number;
  actionCount: number;
  /** 按钮行实测宽度（px）；0 = 首帧尚未测量，回退到屏幕宽 */
  rowWidth: number;
  onBackdropPress: () => void;
  onItemPress: (item: GameMenuItem) => void;
}

/**
 * 卡片宽度下限（px）：窄屏（如 320pt 的机型）上「等待对方同意」「退出房间」这类
 * 六字文案连同图标约需 150px，若只按「两个按钮宽」等比收窄会被挤到省略号甚至溢出，
 * 故设下限保证一行文案始终完整可读。
 */
export const POPUP_MIN_CARD_WIDTH = 168;
/** 卡片宽度上限（占按钮行宽度的比例）：贴边不好看 */
export const POPUP_MAX_CARD_FRACTION = 0.78;
/** 卡片行左右内边距（px）：卡片偏窄时收紧，给文案腾出空间 */
const POPUP_ROW_PADDING_WIDE = 14;
const POPUP_ROW_PADDING_NARROW = 10;
const POPUP_NARROW_CARD_WIDTH = 200;
/** 指向三角的半边长（px）：左右夹取时避免三角整体越过卡片圆角 */
export const ARROW_HALF_SIZE = 7;

/**
 * 向上弹出的菜单卡片：深色圆角卡片 + 底部朝下小三角（指向菜单键）。
 * 挂在按钮行内（按钮行与卡片按钮同一坐标系，卡片才能精确对齐菜单键），
 * 绝对定位不进入纵向流内高度，因此展开不会推挤棋盘。
 *
 * 宽度按**实测像素**算而不是纯百分比：先取「两个按键槽宽」，再用
 * [POPUP_MIN_CARD_WIDTH, 行宽×POPUP_MAX_CARD_FRACTION] 夹一次。
 * 这样窄屏不会把长文案压到溢出，宽屏也不会把卡片拉成横贯整屏的长条。
 *
 * 收起后仍保持挂载，让退场动画播完；若在 visible=false 时立刻 return null，卡片会瞬间消失。
 * 因此「是否可命中测试」必须跟着 visible 走，关闭后的残影绝不能挡住棋盘落子。
 *
 * 【C-80】命中开关只能写在 **prop** 上，不能塞进 style（2026-10 线上问题：底栏上方隐形按钮）。
 * RN 明确不把 pointerEvents 当样式属性——ViewPropTypes.d.ts:199-200 原话：
 * 「since pointerEvents does not affect layout/appearance ... we opt to
 * not include pointerEvents on style」。写在 style 里会被静默忽略，节点回落默认值 auto：
 *   · 遮罩（整屏溢出，top:-2×屏高）回落 auto → 收起后整个棋盘点不动；
 *   · 「退出对局」行回落 auto → 底栏正上方一块隐形按钮，点它弹「保存对局」确认框。
 * 另外 opacity/可见性不参与命中测试，收起只靠 opacity 是无效的。
 * 本组件所有可命中开关一律用 prop 表达；新增浮层时照此办理。
 */
function PopupMenu({
  visible,
  items,
  anchorIndex,
  actionCount,
  rowWidth,
  onBackdropPress,
  onItemPress,
}: PopupMenuProps) {
  const [anim] = useState(() => new Animated.Value(0));
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: visible ? 160 : 130,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  if (items.length === 0) return null;

  // 首帧尚未 onLayout 回调时用屏幕宽兜底，避免出现宽度为 0 的闪帧
  const effectiveRowWidth = rowWidth > 0 ? rowWidth : windowWidth;
  const slots = Math.max(actionCount, 1);
  const slotWidth = effectiveRowWidth / slots;
  const cardWidth = Math.max(
    POPUP_MIN_CARD_WIDTH,
    Math.min(slotWidth * 2, effectiveRowWidth * POPUP_MAX_CARD_FRACTION)
  );
  // 卡片水平居中于锚点按钮（菜单键），再整体夹进行内避免贴边
  const anchorCenter =
    anchorIndex >= 0 && actionCount > 0 ? (anchorIndex + 0.5) * slotWidth : slotWidth / 2;
  const cardLeft = Math.max(
    0,
    Math.min(anchorCenter - cardWidth / 2, effectiveRowWidth - cardWidth)
  );
  // 三角正对菜单键，且不越过卡片左右圆角
  const arrowLeft = Math.max(
    ARROW_HALF_SIZE,
    Math.min(anchorCenter - cardLeft, cardWidth - ARROW_HALF_SIZE)
  );
  const rowPadding =
    cardWidth < POPUP_NARROW_CARD_WIDTH ? POPUP_ROW_PADDING_NARROW : POPUP_ROW_PADDING_WIDE;

  return (
    <View style={styles.popupLayer} pointerEvents="box-none" collapsable={false}>
      {/* 遮罩：向左右与上方溢出到全屏（RN 父容器默认不裁剪），吞掉展开期间的误触落子。
          按钮行在其之后渲染，因此按钮与卡片都在遮罩之上，仍可点击。
          pointerEvents 必须作为 **prop** 下发：RN 明确不把 pointerEvents 当样式属性
          （ViewPropTypes.d.ts「we opt to not include pointerEvents on style」），
          写在 style 里会被静默忽略、节点回落默认 auto，遮罩收起后仍整屏可点。 */}
      <Pressable
        style={[styles.backdrop, { top: -windowHeight * 2, left: -windowWidth, right: -windowWidth }]}
        pointerEvents={visible ? 'auto' : 'none'}
        onPress={onBackdropPress}
        accessibilityLabel="关闭菜单"
      />
      <Animated.View
        style={[
          styles.card,
          {
            left: cardLeft,
            width: cardWidth,
            opacity: anim,
            transform: [
              { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
              { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
            ],
          },
        ]}
        pointerEvents={visible ? 'box-none' : 'none'}
        collapsable={false}
        testID="game-bottom-bar-popup-card"
      >
        {items.map((item, idx) => (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            accessibilityState={{ disabled: !!item.disabled }}
            disabled={item.disabled}
            onPress={() => onItemPress(item)}
            pointerEvents={visible ? 'auto' : 'none'}
            style={({ pressed }) => [
              styles.cardRow,
              idx > 0 && styles.cardRowDivider,
              pressed && !item.disabled && styles.cardRowPressed,
              { paddingHorizontal: rowPadding },
            ]}
          >
            <View
              style={styles.cardIconFrame}
              testID={`game-bottom-bar-popup-icon-${item.key}`}
            >
              <FontAwesome6
                name={item.icon}
                size={18}
                color={item.disabled ? COLORS.itemDisabled : COLORS.popupText}
              />
            </View>
            <Text
              allowFontScaling={false}
              numberOfLines={1}
              style={[styles.cardLabel, item.disabled && { color: COLORS.itemDisabled }]}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
        {/* 底部朝下三角：指向菜单键（CSS border 三角形，避免额外图片资源） */}
        <View
          style={[styles.cardArrow, { left: arrowLeft }]}
          pointerEvents="none"
          testID="game-bottom-bar-popup-arrow"
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    // 底栏宿主：通栏（stretch），底色一路铺到屏幕物理底边
    alignSelf: 'stretch',
  },
  bar: {
    minHeight: BOTTOM_BAR_HEIGHT,
    justifyContent: 'flex-end',
    backgroundColor: COLORS.barBg,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: COLORS.barBorder,
  },
  barImage: {
    ...StyleSheet.absoluteFillObject,
    // 同 Screen.backgroundImage：RN <Image> 会注入素材固有尺寸，absoluteFillObject 覆盖不掉，
    // 必须显式给 100%（用 undefined 不保险，序列化时可能被丢弃）才能随底栏尺寸自适应。
    width: '100%',
    height: '100%',
  },
  barScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.barScrim,
  },
  // 隐藏但保留占位：绝杀特效播放时不让棋盘位置跳动（沿用旧底栏的处理方式）
  barHidden: {
    opacity: 0,
  },
  // 按钮行：高度固定，按钮等分；宽度由 widthStyle（跟随棋盘本体）决定
  itemRow: {
    height: BOTTOM_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemRowFull: {
    width: '100%',
  },
  actionItem: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  actionItemPressed: {
    opacity: 0.6,
  },
  actionItemActive: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  iconFrame: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {
    fontSize: FONT.caption,
    fontWeight: '600',
    color: COLORS.itemText,
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: COLORS.badgeBg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.badgeBorder,
  },
  badgeText: {
    fontSize: FONT.micro,
    lineHeight: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  // 弹出菜单层：绝对定位在按钮行上（卡片/遮罩都以此为参照）
  popupLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  backdrop: {
    position: 'absolute',
    bottom: 0,
    backgroundColor: 'transparent',
  },
  card: {
    position: 'absolute',
    bottom: BOTTOM_BAR_HEIGHT + 8,
    backgroundColor: COLORS.popupBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.popupBorder,
    boxShadow: '0px -2px 10px rgba(0, 0, 0, 0.45)',
    // 命中开关一律走 prop（见组件内注释）：pointerEvents 写在 style 里 RN 不认，
    // 这里只保留视觉样式，收起时的可命中性由卡片节点的 pointerEvents prop 统管。
    // 棋盘内部有 zIndex/elevation 层，必须成对设置才能稳定盖住（见 @/constants/modal 注释）
    zIndex: Z_INDEX.drawer,
    elevation: ELEVATION.drawer,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // 图标与文案是一个整体，居中时按「图标+文案」的整组宽度算，
    // 两者之间只有 gap 的间距，不允许文案再单独撑开或脱离图标。
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 13,
  },
  cardRowDivider: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  cardRowPressed: {
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  cardIconFrame: {
    // 固定宽 22px 且自身居中：同一菜单内所有图标占位一致，
    // 菜单键是第一个时也不会让整组偏移
    width: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardLabel: {
    // 不要 flex:1 —— 它会把文案撑满图标右侧的剩余空间，让图标和文字之间裂开一道缝，
    // 看起来割裂。宽度按内容自适应，由父行的 justifyContent:'center' 整组居中；
    // flexShrink 允许极窄屏下收缩而不是撑破卡片。
    flexShrink: 1,
    fontSize: FONT.control,
    fontWeight: '600',
    color: COLORS.popupText,
  },
  // 卡片底部指向菜单键的三角（透明底 + 上/左右三边着色）
  cardArrow: {
    position: 'absolute',
    bottom: -7,
    marginLeft: -ARROW_HALF_SIZE,
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderTopWidth: 7,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: COLORS.popupBg,
  },
});