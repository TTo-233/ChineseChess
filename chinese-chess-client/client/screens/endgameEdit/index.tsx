/**
 * 残局摆棋编辑器（新建 + 再编辑）
 *
 * 交互流程：
 * 1. 棋盘上方为「红棋 / 黑棋」选子摘要条（与被吃棋子摘要条同位置、同形式）
 * 2. 点击半区向下展开选子抽屉（与被吃棋子抽屉一致：透明背景 + 淡入下滑动画），
 *    抽屉内展示该方全部 7 类棋子图片，行末附「清除」工具
 * 3. 点选棋子后抽屉收起，再点击棋盘交叉点摆放（同位置直接替换原棋子）；
 *    「清除」工具用于点击移除棋盘上的棋子
 * 4. 「校验并保存」先做合规性校验（将帅、飞将、数量、兵/士/象位置等），
 *    不通过时在保存按钮上方常驻红条提示原因；通过后弹出命名弹窗
 * 5. 保存成功返回选关页并自动切换到「自定义」标签
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Modal, TextInput,
  KeyboardAvoidingView, Platform, Keyboard, TouchableWithoutFeedback, Image, Dimensions, Animated,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Screen } from '@/components/Screen';
import BoardEditor from '@/components/BoardEditor';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { createFromFen } from '@/utils/chess/GameEngine';
import { FEN_CHARS } from '@/utils/chess/types';
import { getPieceImage, PIECE_NAMES } from '@/utils/chess/pieceImages';
import { validateEndgameFen } from '@/utils/chess/endgames';
import {
  addCustomEndgame,
  updateCustomEndgame,
  markPendingFocusCustomTab,
} from '@/utils/EndgameProgress';
import { FONT } from '@/utils/typography';

// 主题色（与残局选关页一致）
const COLORS = {
  bg: '#F5F0E8',
  bgCard: '#FFF8F0',
  text: '#4A3F35',
  textMuted: '#8B7D6B',
  accent: '#C23B22',
  primary: '#8B6914',
  border: '#E0D5C8',
};

type SideKey = 'red' | 'black';

// 选子面板项：key=FEN 字符，ids=该类棋子可用的棋子 id 池（池大小即该类的数量上限）
interface PaletteItem {
  key: string;
  side: SideKey;
  ids: number[];
}

const PALETTE_ROWS: { side: SideKey; items: PaletteItem[] }[] = [
  {
    side: 'red',
    items: [
      { key: 'K', side: 'red', ids: [16] },              // 帅
      { key: 'A', side: 'red', ids: [17, 18] },          // 仕
      { key: 'B', side: 'red', ids: [19, 20] },          // 相
      { key: 'N', side: 'red', ids: [21, 22] },          // 马
      { key: 'R', side: 'red', ids: [23, 24] },          // 车
      { key: 'C', side: 'red', ids: [25, 26] },          // 炮
      { key: 'P', side: 'red', ids: [27, 28, 29, 30, 31] }, // 兵
    ],
  },
  {
    side: 'black',
    items: [
      { key: 'k', side: 'black', ids: [0] },             // 将
      { key: 'a', side: 'black', ids: [1, 2] },          // 士
      { key: 'b', side: 'black', ids: [3, 4] },          // 象
      { key: 'n', side: 'black', ids: [5, 6] },          // 马
      { key: 'r', side: 'black', ids: [7, 8] },          // 车
      { key: 'c', side: 'black', ids: [9, 10] },         // 炮
      { key: 'p', side: 'black', ids: [11, 12, 13, 14, 15] }, // 卒
    ],
  },
];

// 当前选中的工具：某类棋子 / 清除（记录来源半区用于摘要条高亮）
type Selection = { kind: 'piece'; item: PaletteItem } | { kind: 'erase'; side: SideKey } | null;

// 摆子结果：[col][row] → 棋子 id，-1 为空
type Placements = number[][];

const emptyBoard = (): Placements =>
  Array.from({ length: 9 }, () => new Array(10).fill(-1));

// 选子摘要条高度（与被吃棋子摘要条 CAPTURED_SUMMARY_H 一致）
const SELECT_STRIP_H = 30;

export default function EndgameEditScreen() {
  const router = useSafeRouter();
  const params = useSafeSearchParams<{ customId?: string; name?: string; comment?: string; fen?: string }>();

  const editingId = params.customId || '';
  const isEdit = !!editingId;

  // 初始局面：编辑时从 FEN 解析（复用引擎的 id 分配），新建时为空棋盘
  const [placements, setPlacements] = useState<Placements>(() => {
    if (params.fen) {
      try {
        return createFromFen(params.fen).qiPan;
      } catch {
        return emptyBoard();
      }
    }
    return emptyBoard();
  });
  const [selection, setSelection] = useState<Selection>(null);
  const [saveVisible, setSaveVisible] = useState(false);
  const [saveName, setSaveName] = useState(params.name || '');
  const [saveComment, setSaveComment] = useState(params.comment || '');
  const [saveError, setSaveError] = useState('');
  // 合规性校验结果（常驻显示于保存按钮上方，摆子变化时自动清除）
  const [boardError, setBoardError] = useState('');
  // 瞬时提示（数量上限/已清空等，2.5 秒后自动消失）
  const [hintOverride, setHintOverride] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 选子抽屉（完全对齐被吃棋子抽屉的展开/收起动画与状态机）
  const [drawerSide, setDrawerSide] = useState<SideKey | null>(null);
  const [renderedDrawerSide, setRenderedDrawerSide] = useState<SideKey | null>(null);
  const [drawerAnim] = useState(() => new Animated.Value(0));

  // 清空二次确认（两段式：3 秒内再次点击才执行，替代原生确认框）
  const [clearArmed, setClearArmed] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 导出 FEN 弹窗（展示当前局面串 + 复制到剪贴板，弹窗内联反馈）
  const [exportVisible, setExportVisible] = useState(false);
  const [exportFen, setExportFen] = useState('');
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 抽屉展开/切换时立即同步渲染目标；收起时保留旧值直至退出动画结束
  if (drawerSide && drawerSide !== renderedDrawerSide) {
    setRenderedDrawerSide(drawerSide);
  }

  useEffect(() => {
    if (drawerSide) {
      Animated.timing(drawerAnim, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    } else if (renderedDrawerSide) {
      Animated.timing(drawerAnim, { toValue: 0, duration: 140, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setRenderedDrawerSide(null);
      });
    }
  }, [drawerSide, renderedDrawerSide, drawerAnim]);

  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const showTransientHint = useCallback((msg: string) => {
    setHintOverride(msg);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHintOverride(null), 2500);
  }, []);

  // 已使用的棋子 id 集合（用于分配空子、判断数量上限）
  const usedIds = useMemo(() => {
    const set = new Set<number>();
    placements.forEach((col) => col.forEach((id) => { if (id >= 0) set.add(id); }));
    return set;
  }, [placements]);

  // 双方已摆棋子数量（摘要条「红棋：N / 黑棋：N」，与被吃棋子摘要条同形式）
  const { redCount, blackCount } = useMemo(() => {
    let red = 0;
    let black = 0;
    placements.forEach((col) => col.forEach((id) => {
      if (id >= 16) red++;
      else if (id >= 0) black++;
    }));
    return { redCount: red, blackCount: black };
  }, [placements]);

  // 摆子变化时清除上次的校验错误提示
  useEffect(() => {
    setBoardError('');
  }, [placements]);

  // 面板棋子尺寸：与被吃棋子抽屉一致（80% 棋子图尺寸随屏宽自适应）；
  // 数量角标的尺寸/偏移/字号同样沿用被吃棋子角标随棋子图比例联动的算法
  const screenWidth = Dimensions.get('window').width;
  const editBoardStyle = useBoardStyle();
  const widthScale = (screenWidth - 16) / editBoardStyle.scaleBaseWidth;
  const pieceSize = Math.floor(editBoardStyle.pieceDiameter * widthScale);
  const palettePieceSize = Math.max(Math.floor(pieceSize * 0.8), 1);
  const paletteBadgeSize = Math.max(Math.round(palettePieceSize * 0.47), 12);
  const paletteBadgeFont = Math.max(Math.round(paletteBadgeSize * 0.6), 8);
  const paletteBadgeOffset = -Math.round(paletteBadgeSize * 0.27);
  // 预留抽屉带高度 = 抽屉内容高（棋子项 + 上下外边距 3*2 + 抽屉上下内边距 4*2）
  const drawerBandHeight = palettePieceSize + 14;

  const hasAnyPiece = usedIds.size > 0;

  // 棋盘交叉点点击：按当前选中工具摆放/替换/移除
  const handlePointPress = useCallback((col: number, row: number) => {
    if (!selection) return;
    if (selection.kind === 'erase') {
      setPlacements((prev) => {
        if (prev[col][row] < 0) return prev;
        const next = prev.map((c) => [...c]);
        next[col][row] = -1;
        return next;
      });
      return;
    }
    const ids = selection.item.ids;
    const freeId = ids.find((id) => !usedIds.has(id));
    if (freeId === undefined) {
      showTransientHint(`「${selection.item.side === 'red' ? '红' : '黑'}·${PIECE_NAMES[ids[0]]}」数量已达上限`);
      return;
    }
    setPlacements((prev) => {
      const next = prev.map((c) => [...c]);
      next[col][row] = freeId; // 同位置直接替换原棋子
      return next;
    });
  }, [selection, usedIds, showTransientHint]);

  // 摘要条半区点击：展开/收起选子抽屉
  const toggleDrawer = useCallback((side: SideKey) => {
    setDrawerSide((prev) => (prev === side ? null : side));
  }, []);

  // 抽屉内点选棋子：选中（再次点击取消），抽屉保持展开不收回，选中状态保留在摘要条上
  const handleSelectPiece = useCallback((item: PaletteItem) => {
    if (item.ids.every((id) => usedIds.has(id))) {
      showTransientHint(`「${item.side === 'red' ? '红' : '黑'}·${PIECE_NAMES[item.ids[0]]}」数量已达上限`);
      return;
    }
    setSelection((prev) =>
      prev?.kind === 'piece' && prev.item.key === item.key ? null : { kind: 'piece', item }
    );
  }, [usedIds, showTransientHint]);

  const handleSelectErase = useCallback((side: SideKey) => {
    setSelection((prev) => (prev?.kind === 'erase' ? null : { kind: 'erase', side }));
  }, []);

  // 清空棋盘（两段式确认：点击后 3 秒内再点一次才清空）
  const handleClear = useCallback(() => {
    if (!hasAnyPiece) return;
    if (!clearArmed) {
      setClearArmed(true);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setClearArmed(false), 3000);
      showTransientHint('再次点击右上角按钮确认清空棋盘');
      return;
    }
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setClearArmed(false);
    setPlacements(emptyBoard());
    setSelection(null);
    setDrawerSide(null);
    showTransientHint('棋盘已清空');
  }, [hasAnyPiece, clearArmed, showTransientHint]);

  // 由摆子结果生成 FEN（仅棋盘部分，红方先行与残局体系一致）
  const buildFen = (): string => {
    let out = '';
    for (let row = 0; row < 10; row++) {
      let spaces = 0;
      for (let col = 0; col < 9; col++) {
        const id = placements[col][row];
        if (id < 0) { spaces++; continue; }
        if (spaces > 0) { out += spaces; spaces = 0; }
        out += FEN_CHARS[id];
      }
      if (spaces > 0) out += spaces;
      if (row < 9) out += '/';
    }
    return out;
  };

  // 打开保存弹窗（先校验合规性，不通过则常驻红条提示原因）
  const handlePressSave = () => {
    const err = validateEndgameFen(buildFen());
    if (err) {
      setBoardError(err);
      return;
    }
    setBoardError('');
    setSaveError('');
    setSaveVisible(true);
  };

  // 保存：新增或覆盖更新，完成后返回并自动聚焦「自定义」标签
  const handleConfirmSave = async () => {
    const name = saveName.trim();
    if (!name) {
      setSaveError('请输入残局名称');
      return;
    }
    const fen = buildFen();
    const comment = saveComment.trim();
    try {
      if (isEdit) {
        await updateCustomEndgame(editingId, { name, comment, fen });
      } else {
        await addCustomEndgame({ name, comment, fen });
      }
    } catch {
      setSaveError('保存失败，请重试');
      return;
    }
    markPendingFocusCustomTab();
    setSaveVisible(false);
    router.back();
  };

  // 导出当前局面 FEN（与导入格式一致：仅棋盘串、红方先行）；
  // 顺带做一次合规校验并在弹窗内提示，但不阻止导出，方便用户继续调整
  const handleExport = () => {
    const fen = buildFen();
    setExportFen(fen);
    setExportErr(validateEndgameFen(fen));
    setCopied(false);
    setExportVisible(true);
  };

  // 复制 FEN 到剪贴板，成功后按钮短暂变为「已复制」（避免 Toast/原生弹窗）
  const handleCopyFen = async () => {
    try {
      await Clipboard.setStringAsync(exportFen);
    } catch {
      return;
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  const selectionHint = hintOverride
    ?? (selection?.kind === 'piece'
      ? `已选 ${selection.item.side === 'red' ? '红' : '黑'}·${PIECE_NAMES[selection.item.ids[0]]}：点击棋盘交叉点摆放（替换该处棋子）；再点摘要文字收起抽屉`
      : selection?.kind === 'erase'
        ? '已选清除：点击棋盘上的棋子移除；再点摘要文字收起抽屉'
        : '点击上方「红棋 / 黑棋」展开棋子抽屉，选择棋子后点击棋盘交叉点摆放');

  return (
    <Screen>
      <View style={styles.container}>
        {/* 顶部标题栏（与其他页面一致） */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.headerButton}
            accessibilityLabel="返回"
          >
            <FontAwesome6 name="arrow-left" size={16} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
            {isEdit ? '编辑残局' : '自由摆棋'}
          </Text>
          <View style={styles.headerRight}>
            <TouchableOpacity
              onPress={handleExport}
              style={[styles.headerButton, !hasAnyPiece && { opacity: 0.4 }]}
              accessibilityLabel="导出当前局面 FEN"
              disabled={!hasAnyPiece}
            >
              <FontAwesome6 name="file-export" size={16} color={COLORS.text} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleClear}
              style={[
                styles.headerButton,
                !hasAnyPiece && { opacity: 0.4 },
                clearArmed && styles.headerButtonDanger,
              ]}
              accessibilityLabel={clearArmed ? '确认清空棋盘' : '清空棋盘'}
              disabled={!hasAnyPiece}
            >
              <FontAwesome6 name="trash-can" size={16} color={clearArmed ? '#FFFFFF' : COLORS.accent} />
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* 抽屉带 + 摘要条 + 棋盘 + 选子抽屉的相对定位容器。
              与被吃棋子布局一致：摘要文字在下（棋盘正上方），抽屉自顶部标题行向下展开，
              展开后的棋子位于文字上方的预留抽屉带内，棋盘位置不动、文字不被遮挡 */}
          <View style={{ position: 'relative' }}>
            {/* 预留抽屉带：高度 = 抽屉内容高，收起时为空（同对局页棋盘上方的留白区） */}
            <View style={{ height: drawerBandHeight }} pointerEvents="none" />
            {/* 选子摘要条：与被吃棋子摘要条同位置（棋盘正上方）、同形式（左右半区） */}
            <View style={styles.selectStripRow}>
              {(['red', 'black'] as const).map((sideKey) => {
                const count = sideKey === 'red' ? redCount : blackCount;
                const isDrawerOpen = drawerSide === sideKey;
                const pieceToolActive = selection?.kind === 'piece' && selection.item.side === sideKey;
                const eraseToolActive = selection?.kind === 'erase' && selection.side === sideKey;
                const active = isDrawerOpen || pieceToolActive || eraseToolActive;
                return (
                  <TouchableOpacity
                    key={sideKey}
                    style={[styles.selectHalf, active && styles.selectHalfActive]}
                    onPress={() => toggleDrawer(sideKey)}
                    activeOpacity={0.7}
                    accessibilityLabel={`${sideKey === 'red' ? '红棋' : '黑棋'}选子抽屉`}
                  >
                    {pieceToolActive && (
                      <Image
                        source={getPieceImage((selection as { kind: 'piece'; item: PaletteItem }).item.ids[0])}
                        style={{ width: 18, height: 18, marginRight: 4 }}
                      />
                    )}
                    {eraseToolActive && (
                      <FontAwesome6 name="eraser" size={12} color={COLORS.primary} style={{ marginRight: 4 }} />
                    )}
                    <Text style={[styles.selectHalfText, active && styles.selectHalfTextActive]}>
                      {sideKey === 'red' ? '红棋' : '黑棋'}：{count}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* 可编辑棋盘 */}
            <BoardEditor placements={placements} onPointPress={handlePointPress} />

            {/* 选子抽屉：锚定于标题行正下方（top:0），向下展开落在预留抽屉带内，
                棋子显示位于摘要文字上方、不遮挡文字与棋盘（与被吃棋子抽屉一致：透明背景 + 淡入下滑；
                容器为普通 View 不拦截触摸；选中棋子不收起，点摘要文字收起；最后渲染保证 Android 层级） */}
            {renderedDrawerSide && (
              <Animated.View
                style={[
                  styles.paletteDrawer,
                  {
                    opacity: drawerAnim,
                    transform: [{ translateY: drawerAnim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }],
                  },
                ]}
                collapsable={false}
              >
                <View style={styles.paletteDrawerRow}>
                  {PALETTE_ROWS.find((r) => r.side === renderedDrawerSide)!.items.map((item) => {
                    const repId = item.ids[0];
                    // 剩余可摆数量（未使用的棋子 id 数），与被吃棋子角标同规则：仅 > 1 时显示
                    const remaining = item.ids.reduce((acc, id) => acc + (usedIds.has(id) ? 0 : 1), 0);
                    const exhausted = remaining === 0;
                    const active = selection?.kind === 'piece' && selection.item.key === item.key;
                    return (
                      <TouchableOpacity
                        key={item.key}
                        style={[styles.paletteItem, exhausted && { opacity: 0.35 }]}
                        onPress={() => handleSelectPiece(item)}
                        activeOpacity={0.7}
                        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                        accessibilityLabel={`${item.side === 'red' ? '红' : '黑'}${PIECE_NAMES[repId]}，剩余${remaining}个`}
                      >
                        <Image
                          source={getPieceImage(repId)}
                          style={{ width: palettePieceSize, height: palettePieceSize }}
                        />
                        {/* 选中态：金色描边圈 */}
                        {active && (
                          <View
                            style={[styles.paletteSelectedRing, { width: palettePieceSize + 6, height: palettePieceSize + 6, borderRadius: 7 }]}
                            pointerEvents="none"
                          />
                        )}
                        {/* 剩余数量角标：与被吃棋子数量角标同样式（红色圆标微超出棋子边缘） */}
                        {remaining > 1 && (
                          <View
                            style={[
                              styles.paletteBadge,
                              {
                                top: paletteBadgeOffset,
                                right: paletteBadgeOffset,
                                minWidth: paletteBadgeSize,
                                height: paletteBadgeSize,
                                borderRadius: paletteBadgeSize / 2,
                                paddingHorizontal: paletteBadgeSize * 0.17,
                              },
                            ]}
                            pointerEvents="none"
                          >
                            <Text
                              allowFontScaling={false}
                              style={[
                                styles.paletteBadgeText,
                                { fontSize: paletteBadgeFont, lineHeight: Math.max(Math.round(paletteBadgeFont * 1.2), 1) },
                              ]}
                            >
                              {remaining}
                            </Text>
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                  {/* 清除工具：位于棋子行末尾，裸图标与棋子项同规格 */}
                  <TouchableOpacity
                    style={styles.paletteItem}
                    onPress={() => handleSelectErase(renderedDrawerSide)}
                    activeOpacity={0.7}
                    hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                    accessibilityLabel="清除棋子"
                  >
                    <View style={{ width: palettePieceSize, height: palettePieceSize, alignItems: 'center', justifyContent: 'center' }}>
                      <FontAwesome6 name="eraser" size={Math.max(Math.floor(palettePieceSize * 0.55), 1)} color={COLORS.textMuted} />
                    </View>
                    {selection?.kind === 'erase' && selection.side === renderedDrawerSide && (
                      <View
                        style={[styles.paletteSelectedRing, { width: palettePieceSize + 6, height: palettePieceSize + 6, borderRadius: 7 }]}
                        pointerEvents="none"
                      />
                    )}
                  </TouchableOpacity>
                </View>
              </Animated.View>
            )}
          </View>

          {/* 当前选中状态提示 */}
          <Text style={styles.hintText} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.8}>
            {selectionHint}
          </Text>

          <View style={{ height: 12 }} />
        </ScrollView>

        {/* 底部保存栏：校验错误常驻红条 + 保存按钮 */}
        <View style={styles.bottomBar}>
          {!!boardError && (
            <View style={styles.boardErrorBanner}>
              <FontAwesome6 name="triangle-exclamation" size={12} color={COLORS.accent} />
              <Text style={styles.boardErrorText}>{boardError}</Text>
            </View>
          )}
          <TouchableOpacity style={styles.saveButton} onPress={handlePressSave} activeOpacity={0.85}>
            <FontAwesome6 name="floppy-disk" size={15} color="#FFFFFF" />
            <Text style={styles.saveButtonText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              校验并保存
            </Text>
          </TouchableOpacity>
        </View>

        {/* 保存命名弹窗 */}
        <Modal visible={saveVisible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setSaveVisible(false)}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss} disabled={Platform.OS === 'web'}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={styles.modalOverlay}>
                <View style={styles.modalCard}>
                  <View style={styles.modalHeader}>
                    <Text style={styles.modalTitle}>{isEdit ? '保存残局修改' : '保存为残局'}</Text>
                    <TouchableOpacity onPress={() => setSaveVisible(false)}>
                      <FontAwesome6 name="xmark" size={18} color={COLORS.textMuted} />
                    </TouchableOpacity>
                  </View>
                  <View style={styles.modalBody}>
                    <Text style={styles.fieldLabel}>名称</Text>
                    <TextInput
                      style={styles.input}
                      value={saveName}
                      onChangeText={setSaveName}
                      placeholder="例如：七星聚会"
                      placeholderTextColor={COLORS.textMuted}
                      maxLength={20}
                    />
                    <Text style={styles.fieldLabel}>说明（可选）</Text>
                    <TextInput
                      style={[styles.input, styles.inputMultiline]}
                      value={saveComment}
                      onChangeText={setSaveComment}
                      placeholder="残局出处或杀法说明"
                      placeholderTextColor={COLORS.textMuted}
                      maxLength={120}
                      multiline
                    />
                    {!!saveError && <Text style={styles.errorText}>{saveError}</Text>}
                  </View>
                  <View style={styles.modalFooter}>
                    <TouchableOpacity style={[styles.modalButton, styles.modalButtonCancel]} onPress={() => setSaveVisible(false)}>
                      <Text style={styles.modalButtonCancelText}>取消</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.modalButton, styles.modalButtonConfirm]} onPress={handleConfirmSave}>
                      <Text style={styles.modalButtonConfirmText}>保存</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </KeyboardAvoidingView>
          </TouchableWithoutFeedback>
        </Modal>

        {/* 导出 FEN 弹窗（展示当前局面串，可复制；不合规时提示但不阻止导出） */}
        <Modal visible={exportVisible} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setExportVisible(false)}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss} disabled={Platform.OS === 'web'}>
            <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={styles.modalOverlay}>
                <View style={styles.modalCard}>
                  <View style={styles.modalHeader}>
                    <Text style={styles.modalTitle}>导出当前局面</Text>
                    <TouchableOpacity onPress={() => setExportVisible(false)}>
                      <FontAwesome6 name="xmark" size={18} color={COLORS.textMuted} />
                    </TouchableOpacity>
                  </View>
                  <View style={styles.modalBody}>
                    <Text style={styles.fieldLabel}>FEN 局面串（红方先行，可直接用于导入）</Text>
                    <TextInput
                      style={[styles.input, styles.inputMultiline]}
                      value={exportFen}
                      editable={false}
                      multiline
                    />
                    {exportErr ? (
                      <Text style={styles.errorText}>当前局面未通过合规校验（{exportErr}），仍可复制后继续调整</Text>
                    ) : (
                      <Text style={styles.fenOkText}>当前局面已通过合规校验</Text>
                    )}
                    {copied && <Text style={styles.fenOkText}>已复制到剪贴板</Text>}
                  </View>
                  <View style={styles.modalFooter}>
                    <TouchableOpacity style={[styles.modalButton, styles.modalButtonCancel]} onPress={() => setExportVisible(false)}>
                      <Text style={styles.modalButtonCancelText}>关闭</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.modalButton, styles.modalButtonConfirm]} onPress={handleCopyFen}>
                      <Text style={styles.modalButtonConfirmText}>{copied ? '已复制' : '复制'}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </KeyboardAvoidingView>
          </TouchableWithoutFeedback>
        </Modal>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: COLORS.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  headerButtonDanger: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  // 头部右侧按钮组（导出 + 清空）
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.text,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 12,
  },
  // 选子摘要条：与被吃棋子摘要条同形式（固定高度，左右半区居中文字）
  selectStripRow: {
    flexDirection: 'row',
    height: SELECT_STRIP_H,
    marginBottom: 8,
  },
  selectHalf: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4, // 扩大点击区域
    borderRadius: 8,
  },
  selectHalfActive: {
    backgroundColor: 'rgba(139, 105, 20, 0.12)',
  },
  selectHalfText: {
    fontSize: FONT.body,
    color: '#666',
  },
  selectHalfTextActive: {
    color: COLORS.primary,
    fontWeight: '600',
  },
  // 选子抽屉：锚定于标题行正下方（top:0），向下展开浮于摘要条文字层上方、不接触棋盘
  // （内容高度 = paddingVertical*2 + 棋子项 ≈ 47px < 摘要条+棋盘顶内边距 50px）；
  // zIndex/elevation 置于最高层，collapsable={false} 防止 Android Release 视图扁平化导致被棋盘遮挡
  paletteDrawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'transparent',
    paddingHorizontal: 12,
    paddingVertical: 4,
    zIndex: 50,
    elevation: 50,
  },
  paletteDrawerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    alignSelf: 'stretch',
    paddingHorizontal: 4,
  },
  paletteItem: {
    // 与被吃棋子项同样式：裸棋子图（无边框无底衬），角标绝对定位于项内；
    // 对称外边距代替 gap（与被吃棋子抽屉一致，规避 Yoga 换行缺陷）
    position: 'relative',
    marginHorizontal: 3,
    marginVertical: 3,
  },
  // 剩余数量角标：与被吃棋子数量角标同样式（红底白字细边，微超出棋子边缘）
  paletteBadge: {
    position: 'absolute',
    backgroundColor: '#C62828',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.85)',
    zIndex: 2,
  },
  paletteBadgeText: {
    color: '#fff',
    fontWeight: '700',
  },
  // 选中态描边圈（浮于棋子图上方，略大于棋子图）
  paletteSelectedRing: {
    position: 'absolute',
    top: -3,
    left: -3,
    borderWidth: 2,
    borderColor: COLORS.primary,
    backgroundColor: 'rgba(139, 105, 20, 0.14)',
  },
  hintText: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 2,
    paddingHorizontal: 24,
    minHeight: 18,
  },
  bottomBar: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: COLORS.bgCard,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  // 合规性校验错误常驻横幅（替代原生弹窗，保证任何设备上清晰可见）
  boardErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(194, 59, 34, 0.08)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 8,
  },
  boardErrorText: {
    flex: 1,
    fontSize: FONT.caption,
    color: COLORS.accent,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.primary,
    borderRadius: 14,
    paddingVertical: 13,
  },
  saveButtonText: {
    fontSize: FONT.control,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: COLORS.bgCard,
    borderRadius: 16,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.text,
  },
  modalBody: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  fieldLabel: {
    fontSize: FONT.body,
    color: COLORS.textMuted,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: FONT.control,
    color: COLORS.text,
  },
  inputMultiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  errorText: {
    fontSize: FONT.caption,
    color: COLORS.accent,
    marginTop: 10,
  },
  // 导出弹窗内的正常提示（校验通过 / 已复制）
  fenOkText: {
    fontSize: FONT.caption,
    color: '#3E7C4F',
    marginTop: 10,
  },
  modalFooter: {
    flexDirection: 'row',
    gap: 10,
    padding: 16,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalButtonCancel: {
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalButtonCancelText: {
    fontSize: FONT.body,
    color: COLORS.text,
    fontWeight: '600',
  },
  modalButtonConfirm: {
    backgroundColor: COLORS.primary,
  },
  modalButtonConfirmText: {
    fontSize: FONT.control,
    color: '#FFFFFF',
    fontWeight: '700',
  },
});
