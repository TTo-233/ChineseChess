/**
 * 残局闯关选关页
 * - 内置 100 关：含原开源项目残局库的 30 关与本仓库新增的关卡，
 *   全部按实测难度由易到难排序，分 入门 / 进阶 / 经典 / 其他 四档各 25 关，
 *   从第 1 关开始依次解锁
 * - 卡片左上角角标显示该关难度分档
 * - 支持继续挑战（局内存档）
 * - 支持导入自定义残局（FEN 识别校验后保存）
 */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  FlatList,
  TextInput,
  useWindowDimensions,
  LayoutChangeEvent,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { AppModal, ModalButton, modalButtonRowStyle } from '@/components/Modal';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import { BUILTIN_ENDGAMES, validateEndgameFen, type EndgameTier } from '@/utils/chess/endgames';
import {
  loadProgress,
  isLevelUnlocked,
  getCrownTier,
  getCustomCrownTier,
  loadEndgameBattle,
  deleteEndgameBattle,
  loadCustomEndgames,
  addCustomEndgame,
  deleteCustomEndgame,
  builtinLevelToLaunch,
  consumePendingFocusCustomTab,
  type EndgameProgressData,
  type EndgameBattleSave,
  type CustomEndgame,
  type EndgameLaunchParams,
} from '@/utils/EndgameProgress';
import { FONT } from '@/utils/typography';
import { getPikafishTier, ENDGAME_AI_TIER } from '@/utils/chess/pikafishDifficulty';
import {
  TITLE_BAR_PADDING_HORIZONTAL,
  TITLE_BAR_PADDING_VERTICAL,
  BACK_BUTTON_SIZE,
} from '@/constants/chrome';

// 主题色 - 浅色复古系（与首页一致）
const COLORS = {
  primary: '#8B6914',
  accent: '#B22222',
  gold: '#B8860B',
  bg: '#F5F0E8',
  bgCard: '#FFF8F0',
  text: '#3E2723',
  textMuted: '#8D6E63',
  border: '#D7CCC8',
  success: '#2E7D32',
};

// 通关皇冠配色：0 次提示=金，1 次=银，其余=铜
const CROWN_COLORS = {
  gold: '#E6A800',
  silver: '#9EA7AD',
  bronze: '#B5763A',
} as const;

// 残局分档角标配色：入门最浅，越往后越重，与「皇冠评级」的调性一致
// （AI 档位由 ENDGAME_AI_TIER 决定，见 utils/chess/pikafishDifficulty）
const TIER_COLORS: Record<EndgameTier, { bg: string; text: string }> = {
  入门: { bg: '#E8F0E4', text: '#4A7A3F' },
  进阶: { bg: '#F5EBD8', text: '#8A6212' },
  经典: { bg: '#F0E0DC', text: '#9C3A2C' },
  其他: { bg: '#E4E6EE', text: '#4B5486' },
};

// 玩法说明（标题行右侧标识点击后弹窗展示）
// AI 难度文案与 game 屏实际档位同源（ENDGAME_AI_TIER），改档位时这里自动跟着变
const RULE_LINES = [
  '从第 1 关开始依次解锁，必须从第一关开始闯关',
  '共 100 关，已按实测难度由易到难排序：入门 → 进阶 → 经典 → 其他，各 25 关，卡片左上角标即分档',
  `${getPikafishTier(ENDGAME_AI_TIER).label} AI 难度，红方先行`,
  '对局中禁止使用翻转',
  '每关限 3 次提示，次数用尽后按钮不可用',
  '通关评级：0 次提示金冠 · 1 次银冠 · 其余铜冠',
];

// 关卡网格的左右内边距：既用于 scrollContent 样式，也用于把 FlatList 的**外宽**
// 换算成网格**内宽**（见 handleGridLayout）——两处共用一个常量，避免改一处忘另一处。
const GRID_H_PADDING = 16;

export default function EndgameScreen() {
  const router = useSafeRouter();
  const { width: windowWidth } = useWindowDimensions();
  // 关卡网格可用宽度（onLayout 实测，初始按屏宽减去内容左右内边距估算），用于自适应每行卡片数
  const [gridWidth, setGridWidth] = useState(() => Math.max(windowWidth - 32, 0));
  const [progress, setProgress] = useState<EndgameProgressData>({ highestUnlocked: 0, completed: [] });
  const [battleSave, setBattleSave] = useState<EndgameBattleSave | null>(null);
  const [customLevels, setCustomLevels] = useState<CustomEndgame[]>([]);

  // 导入弹窗
  const [importVisible, setImportVisible] = useState(false);
  // 添加残局方式选择弹窗（棋盘摆棋 / FEN 导入）
  const [addChoiceVisible, setAddChoiceVisible] = useState(false);
  // 玩法说明弹窗（标题行右侧标识触发）
  const [ruleVisible, setRuleVisible] = useState(false);
  // 内置/自定义关卡切换标签（导入自定义成功后自动切到 custom）
  const [activeTab, setActiveTab] = useState<'builtin' | 'custom'>('builtin');
  const [importName, setImportName] = useState('');
  const [importFen, setImportFen] = useState('');
  const [importComment, setImportComment] = useState('');
  const [importError, setImportError] = useState('');

  // 自定义残局长按批量删除模式：deleteMode 开启后点击卡片仅切换选中，不进入对局
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 删除按钮两段式确认（实机原生 Alert 不弹出，改用页面内联确认）：
  // 第一次点击进入 armed 状态（3 秒内有效），再次点击才真正执行删除
  const [deleteArmed, setDeleteArmed] = useState(false);
  const deleteArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDeleteArm = useCallback(() => {
    if (deleteArmTimer.current) {
      clearTimeout(deleteArmTimer.current);
      deleteArmTimer.current = null;
    }
    setDeleteArmed(false);
  }, []);

  const exitDeleteMode = useCallback(() => {
    setDeleteMode(false);
    setSelectedIds([]);
    clearDeleteArm();
  }, [clearDeleteArm]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  // 长按进入批量删除模式并选中该卡片
  const handleLongPressCustom = useCallback((id: string) => {
    setDeleteMode(true);
    setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  // 关卡卡片自适应：按网格实测宽度自动调整每行个数（卡片最小宽 108，至少 2 列），
  // 卡片宽度按列数均分，保证左右边距对称、整体居中对齐
  const GRID_GAP = 10;
  const columnCount = Math.max(2, Math.floor((gridWidth + GRID_GAP) / (108 + GRID_GAP)));
  const cellWidth = Math.max(Math.floor((gridWidth - GRID_GAP * (columnCount - 1)) / columnCount), 0);

  const handleGridLayout = useCallback((e: LayoutChangeEvent) => {
    // ⚠️ onLayout 现在挂在 FlatList 上，报的是**整条列表**的宽度（含 scrollContent 的左右内边距）；
    // 而 cellWidth 要按内边距**之内**的可用宽度均分，因此必须减掉两侧 padding。
    // 此前 onLayout 挂在内边距之内的网格 View 上，量到的本身就是内宽，改成 FlatList 后口径变了。
    const w = Math.floor(e.nativeEvent.layout.width) - GRID_H_PADDING * 2;
    if (w > 0) setGridWidth((prev) => (prev === w ? prev : w));
  }, []);

  const refresh = useCallback(async () => {
    const [p, save, customs] = await Promise.all([
      loadProgress(),
      loadEndgameBattle(),
      loadCustomEndgames(),
    ]);
    setProgress(p);
    setBattleSave(save);
    setCustomLevels(customs);
    // 摆棋保存成功后返回：自动切到「自定义」标签，让新残局/修改结果立即可见
    if (consumePendingFocusCustomTab()) {
      setActiveTab('custom');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  // 批量删除选中的自定义残局（两段式内联确认，删除后不可恢复）：
  // 原生 Alert 在实机上不弹出会导致"点击删除没有反应"，
  // 因此第一次点击仅进入待确认状态（按钮变为「确认删除」，3 秒内有效），再次点击才执行
  const handleBatchDelete = useCallback(() => {
    if (selectedIds.length === 0) {
      exitDeleteMode();
      return;
    }
    if (!deleteArmed) {
      setDeleteArmed(true);
      if (deleteArmTimer.current) clearTimeout(deleteArmTimer.current);
      deleteArmTimer.current = setTimeout(() => {
        deleteArmTimer.current = null;
        setDeleteArmed(false);
      }, 3000);
      return;
    }
    clearDeleteArm();
    const ids = selectedIds;
    // 立即退出删除模式并执行删除，避免重复点击
    exitDeleteMode();
    (async () => {
      for (const id of ids) {
        await deleteCustomEndgame(id);
      }
      refresh();
    })();
  }, [selectedIds, deleteArmed, clearDeleteArm, exitDeleteMode, refresh]);

  // 进入关卡
  const launchLevel = (params: EndgameLaunchParams) => {
    router.push('/game', { endgame: JSON.stringify(params) });
  };

  // 继续挑战（恢复局内存档）
  const handleResume = () => {
    if (!battleSave) return;
    if (battleSave.levelIndex >= 0) {
      const level = BUILTIN_ENDGAMES[battleSave.levelIndex];
      if (!level) return;
      launchLevel(builtinLevelToLaunch(battleSave.levelIndex, level, true));
    } else {
      launchLevel({
        levelIndex: -1,
        customId: battleSave.customId,
        name: battleSave.name,
        comment: '',
        fen: battleSave.fen,
        continueBattle: true,
      });
    }
  };

  // 放弃局内存档
  const handleDiscardSave = async () => {
    await deleteEndgameBattle();
    setBattleSave(null);
  };

  // 保存导入的自定义残局
  const handleImportSave = async () => {
    const name = importName.trim();
    if (!name) {
      setImportError('请输入残局名称');
      return;
    }
    const err = validateEndgameFen(importFen);
    if (err) {
      setImportError(err);
      return;
    }
    await addCustomEndgame({
      name,
      comment: importComment.trim(),
      fen: importFen.trim(),
    });
    setImportVisible(false);
    setImportName('');
    setImportFen('');
    setImportComment('');
    setImportError('');
    refresh();
    // 导入成功后自动切换至自定义关卡界面
    setActiveTab('custom');
  };

  const completedCount = progress.completed.length;

  // 关卡网格数据源：内置与自定义共用同一条虚拟化渲染路径（见下方 FlatList）。
  // 内置 100 关若一次性 map 出来，进页时会同步创建 ~700 个原生节点
  // （每张卡片 = 包装层 + Touchable + 序号/名称两个自适应字号 Text + 分档角标 + 皇冠），
  // 这是「进残局闯关比进人机/在线对局明显更慢」的根因；
  // 改用 FlatList 后只挂载视口内的行，与人机/在线对局的量级对齐。
  type GridItem =
    | { kind: 'builtin'; index: number; level: (typeof BUILTIN_ENDGAMES)[number] }
    | { kind: 'custom'; index: number; item: CustomEndgame };

  const gridData = useMemo<GridItem[]>(() => {
    if (activeTab === 'builtin') {
      return BUILTIN_ENDGAMES.map((level, index) => ({ kind: 'builtin' as const, index, level }));
    }
    return customLevels.map((item, index) => ({ kind: 'custom' as const, index, item }));
    // activeTab 决定取哪一份；customLevels 变化需要重算
  }, [activeTab, customLevels]);

  const renderGridItem = ({ item: row }: { item: GridItem }) => {
    if (row.kind === 'builtin') {
      const { level, index } = row;
      const unlocked = isLevelUnlocked(index, progress);
      const completed = progress.completed.includes(index);
      const crown = getCrownTier(progress, index);
      return (
        // 包装层负责定位：皇冠等角标绝对定位于卡片之外层，避免角标参与卡片弹性居中布局
        // （修复实机上有皇冠时序号/名称整体下移、不再居中的问题）
        <View style={[styles.levelCellWrap, { width: cellWidth }]}>
          <TouchableOpacity
            style={[
              styles.levelCell,
              completed && styles.levelCellCompleted,
              !unlocked && styles.levelCellLocked,
            ]}
            disabled={!unlocked}
            onPress={() => launchLevel(builtinLevelToLaunch(index, level))}
            activeOpacity={0.8}
          >
            {!unlocked && (
              <FontAwesome6 name="lock" size={16} color={COLORS.textMuted} style={{ marginBottom: 4 }} />
            )}
            <Text style={[styles.levelNumber, !unlocked && styles.levelTextMuted]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{index + 1}</Text>
            <Text style={[styles.levelName, !unlocked && styles.levelTextMuted]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {level.name}
            </Text>
            {/* 难度分档角标：放在卡片内容之外层，与皇冠错开左上角，避免挤压居中布局 */}
            <View
              style={[styles.tierBadge, { backgroundColor: TIER_COLORS[level.tier].bg }]}
              pointerEvents="none"
            >
              <Text style={[styles.tierBadgeText, { color: TIER_COLORS[level.tier].text }]} numberOfLines={1}>
                {level.tier}
              </Text>
            </View>
          </TouchableOpacity>
          {completed && crown && (
            <View style={styles.crownBadge} pointerEvents="none">
              <FontAwesome6 name="crown" size={13} color={CROWN_COLORS[crown]} solid />
            </View>
          )}
        </View>
      );
    }

    const { item, index } = row;
    const crown = getCustomCrownTier(progress, item.id);
    const selected = selectedIds.includes(item.id);
    return (
      // 包装层负责定位：皇冠/选择圈绝对定位于卡片之外层（同内置关卡，避免挤压内容居中）
      <View style={[styles.levelCellWrap, { width: cellWidth }]}>
        <TouchableOpacity
          style={[
            styles.levelCell,
            deleteMode && selected && styles.levelCellSelected,
          ]}
          onPress={() => {
            if (deleteMode) {
              toggleSelect(item.id);
              return;
            }
            launchLevel({
              levelIndex: -1,
              customId: item.id,
              name: item.name,
              comment: item.comment,
              fen: item.fen,
            });
          }}
          onLongPress={() => handleLongPressCustom(item.id)}
          delayLongPress={350}
          activeOpacity={0.8}
        >
          <Text style={styles.levelNumber} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{index + 1}</Text>
          <Text style={styles.levelName} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {item.name}
          </Text>
        </TouchableOpacity>
        {/* 通关皇冠：右上角（与内置关卡一致），删除模式下隐藏避免与选择圈拥挤 */}
        {crown && !deleteMode && (
          <View style={styles.crownBadge} pointerEvents="none">
            <FontAwesome6 name="crown" size={13} color={CROWN_COLORS[crown]} solid />
          </View>
        )}
        {/* 再编辑入口：右下角铅笔角标，进入摆棋编辑器加载原局面（删除模式下隐藏） */}
        {!deleteMode && (
          <TouchableOpacity
            style={styles.customEditBadge}
            onPress={() =>
              router.push('/endgameEdit', {
                customId: item.id,
                name: item.name,
                comment: item.comment,
                fen: item.fen,
              })
            }
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={`编辑自定义残局 ${item.name}`}
          >
            <FontAwesome6 name="pen" size={10} color={COLORS.textMuted} />
          </TouchableOpacity>
        )}
        {/* 批量删除模式：左上角选择圈 */}
        {deleteMode && (
          <View
            style={[styles.selectCircle, selected && styles.selectCircleActive]}
            pointerEvents="none"
          >
            {selected && <FontAwesome6 name="check" size={10} color="#FFFFFF" />}
          </View>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <View style={styles.container}>
        {/* 顶部栏 */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <FontAwesome6 name="chevron-left" size={20} color={COLORS.text} />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <View style={styles.headerTitleRow}>
              <Text style={styles.headerTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>残局闯关</Text>
              {/* 标题右侧：玩法说明标识，点击弹窗显示 */}
              <TouchableOpacity
                onPress={() => setRuleVisible(true)}
                accessibilityLabel="玩法说明"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <FontAwesome6 name="circle-info" size={14} color={COLORS.primary} />
              </TouchableOpacity>
            </View>
            <Text style={styles.headerSubtitle}>已通过 {completedCount}/{BUILTIN_ENDGAMES.length} 关</Text>
          </View>
          {/* 右上角：添加自定义残局入口（棋盘摆棋 / FEN 导入） */}
          <TouchableOpacity
            onPress={() => setAddChoiceVisible(true)}
            style={styles.backButton}
            accessibilityLabel="添加自定义残局"
          >
            <FontAwesome6 name="plus" size={18} color={COLORS.text} />
          </TouchableOpacity>
        </View>

        {/* 关卡列表：FlatList 虚拟化 + 多列网格。
            卡片网格改为 FlatList 的 numColumns（见 gridData 注释），
            表头（继续挑战 / 分档切换 / 批量删除工具栏）走 ListHeaderComponent，
            这样进页时只挂载视口内的行，而不是一次性创建全部 100 张卡片。 */}
        <FlatList
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          onLayout={handleGridLayout}
          data={gridData}
          // 列数变化时必须换 key 重建 FlatList：RN 的 numColumns 不支持运行时变更
          key={`endgame-grid-${columnCount}`}
          numColumns={columnCount}
          keyExtractor={(row) => String(row.kind === 'builtin' ? row.level.id : row.item.id)}
          renderItem={renderGridItem}
          // 列表内容随进度/选中态/删除模式变化，需显式声明额外的重渲染依赖
          extraData={{ progress, deleteMode, selectedIds, cellWidth }}
          columnWrapperStyle={styles.gridRow}
          showsVerticalScrollIndicator={false}
          // ⚠️ numColumns>1 时，FlatList 的 initialNumToRender / maxToRenderPerBatch
          // 计的是**行数**（内部 getItemCount = ceil(data.length / numColumns)），不是卡片数。
          // 因此这里必须给"行数"的小常量；按卡片数写（如 columnCount*3）会算出 18 行，
          // 已经超过 100 关 ÷ 6 列 = 17 行，等于把全部卡片一次性挂上，虚拟化彻底失效。
          // 6 行 ≈ 一屏多一点，足以覆盖首屏不留白。
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={5}
          ListHeaderComponent={
            <>
              {/* 继续挑战 */}
              {battleSave && (
                <View style={styles.resumeCard}>
                  <TouchableOpacity style={styles.resumeMain} onPress={handleResume} activeOpacity={0.8}>
                    <View style={styles.resumeIcon}>
                      <FontAwesome6 name="play" size={16} color="#FFFFFF" />
                    </View>
                    <View style={styles.resumeInfo}>
                      <Text style={styles.resumeTitle}>继续挑战</Text>
                      <Text style={styles.resumeSubtitle}>
                        {battleSave.levelIndex >= 0 ? `第 ${battleSave.levelIndex + 1} 关 · ` : '自定义 · '}{battleSave.name}
                      </Text>
                    </View>
                    <FontAwesome6 name="chevron-right" size={14} color={COLORS.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.resumeDiscard} onPress={handleDiscardSave}>
                    <FontAwesome6 name="xmark" size={14} color={COLORS.textMuted} />
                  </TouchableOpacity>
                </View>
              )}

              {/* 内置/自定义关卡切换按钮（自定义在右侧） */}
              <View style={styles.tabSwitcher}>
                <TouchableOpacity
                  style={[styles.tabButton, activeTab === 'builtin' && styles.tabButtonActive]}
                  onPress={() => {
                    setActiveTab('builtin');
                    exitDeleteMode(); // 切换到内置关卡时退出批量删除模式
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.tabButtonText, activeTab === 'builtin' && styles.tabButtonTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>内置关卡</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tabButton, activeTab === 'custom' && styles.tabButtonActive]}
                  onPress={() => setActiveTab('custom')}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.tabButtonText, activeTab === 'custom' && styles.tabButtonTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>自定义</Text>
                </TouchableOpacity>
              </View>

              {/* 批量删除模式工具栏：已选数量 + 全选/删除/完成 */}
              {activeTab === 'custom' && deleteMode && (
                <View style={styles.deleteToolbar}>
                  <Text style={styles.deleteToolbarInfo} numberOfLines={1}>已选 {selectedIds.length} 项</Text>
                  <View style={styles.deleteToolbarActions}>
                    <TouchableOpacity
                      style={styles.deleteToolbarBtn}
                      onPress={() =>
                        setSelectedIds(
                          selectedIds.length === customLevels.length ? [] : customLevels.map((l) => l.id)
                        )
                      }
                      activeOpacity={0.8}
                    >
                      <Text style={styles.deleteToolbarBtnText} numberOfLines={1}>
                        {selectedIds.length === customLevels.length ? '取消全选' : '全选'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.deleteToolbarBtn,
                        deleteArmed ? styles.deleteToolbarBtnArmed : styles.deleteToolbarBtnDanger,
                      ]}
                      onPress={handleBatchDelete}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.deleteToolbarBtnDangerText} numberOfLines={1}>
                        {deleteArmed
                          ? `确认删除(${selectedIds.length})?`
                          : `删除${selectedIds.length > 0 ? `(${selectedIds.length})` : ''}`}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.deleteToolbarBtn} onPress={exitDeleteMode} activeOpacity={0.8}>
                      <Text style={styles.deleteToolbarBtnText} numberOfLines={1}>完成</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </>
          }
          // 自定义标签下无关卡时给出引导文案；内置关卡恒有 100 条，不会走到这里
          ListEmptyComponent={
            activeTab === 'custom' ? (
              <Text style={styles.emptyText}>暂无自定义残局，点击右上角「+」摆棋或导入 FEN 局面</Text>
            ) : null
          }
          ListFooterComponent={<View style={{ height: 32 }} />}
        />

        {/* 添加自定义残局方式选择弹窗 */}
        <AppModal
          visible={addChoiceVisible}
          onClose={() => setAddChoiceVisible(false)}
          title="添加自定义残局"
          showCloseBtn
        >
          <View style={styles.choiceBody}>
            <TouchableOpacity
              style={styles.choiceRow}
              activeOpacity={0.8}
              onPress={() => {
                setAddChoiceVisible(false);
                router.push('/endgameEdit', { customId: '', name: '', comment: '', fen: '' });
              }}
            >
              <View style={styles.choiceIcon}>
                <FontAwesome6 name="chess-board" size={18} color={COLORS.primary} />
              </View>
              <View style={styles.choiceInfo}>
                <Text style={styles.choiceTitle}>棋盘自由摆棋</Text>
                <Text style={styles.choiceSubtitle}>在棋盘上摆放棋子，校验合规后保存</Text>
              </View>
              <FontAwesome6 name="chevron-right" size={14} color={COLORS.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.choiceRow}
              activeOpacity={0.8}
              onPress={() => {
                setAddChoiceVisible(false);
                setImportVisible(true);
              }}
            >
              <View style={styles.choiceIcon}>
                <FontAwesome6 name="file-import" size={18} color={COLORS.primary} />
              </View>
              <View style={styles.choiceInfo}>
                <Text style={styles.choiceTitle}>FEN 文本导入</Text>
                <Text style={styles.choiceSubtitle}>粘贴 FEN 局面串，识别校验后保存</Text>
              </View>
              <FontAwesome6 name="chevron-right" size={14} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>
        </AppModal>

        {/* 导入自定义残局弹窗 */}
        <AppModal
          visible={importVisible}
          onClose={() => setImportVisible(false)}
          title="导入自定义残局"
          showCloseBtn
          avoidKeyboard
          /* 【C-81】按钮行交给 AppModal 的 footer：此前它虽已位于 ScrollView 之外，
             但同处 body 之内，body 不收缩（缺 flexShrink:1）时整块仍会被卡片
             maxHeight 硬切、把按钮顶出卡片下沿。改为页脚后按钮恒在卡片内。 */
          footer={
            <View style={modalButtonRowStyle}>
              <ModalButton label="取消" variant="secondary" onPress={() => setImportVisible(false)} />
              <ModalButton label="识别并保存" onPress={handleImportSave} />
            </View>
          }
        >
          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.fieldLabel}>名称</Text>
            <TextInput
              style={styles.input}
              value={importName}
              onChangeText={setImportName}
              placeholder="例如：七星聚会"
              placeholderTextColor={COLORS.textMuted}
              maxLength={20}
            />
            <Text style={styles.fieldLabel}>FEN 局面串</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={importFen}
              onChangeText={(t) => { setImportFen(t); setImportError(''); }}
              placeholder="如：2b1ka3/4aP3/4b1N2/9/9/7R1/9/6r1B/2ppA2n1/2BAK4 w"
              placeholderTextColor={COLORS.textMuted}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.fieldHint}>小写=黑方，大写=红方，数字=连续空格，行以 / 分隔；末尾可附 w（红先，默认）或 b（黑先）</Text>
            <Text style={styles.fieldLabel}>说明（可选）</Text>
            <TextInput
              style={styles.input}
              value={importComment}
              onChangeText={setImportComment}
              placeholder="杀法要点备注"
              placeholderTextColor={COLORS.textMuted}
              maxLength={100}
            />
            {importError ? <Text style={styles.errorText}>{importError}</Text> : null}
          </ScrollView>
        </AppModal>

        {/* 玩法说明弹窗 */}
        <AppModal
          visible={ruleVisible}
          onClose={() => setRuleVisible(false)}
          title="玩法说明"
          showCloseBtn
          bodyStyle={styles.ruleModalBody}
        >
          {RULE_LINES.map(line => (
            <View key={line} style={styles.ruleLineRow}>
              <View style={styles.ruleLineDot} />
              <Text style={styles.ruleLineText}>{line}</Text>
            </View>
          ))}
          <View style={[modalButtonRowStyle, styles.ruleModalFooter]}>
            <ModalButton label="知道了" onPress={() => setRuleVisible(false)} />
          </View>
        </AppModal>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  // 顶部标题行：暖白卡片底 + 底部分隔线，与在线对局标题行颜色保持一致
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: TITLE_BAR_PADDING_HORIZONTAL,
    paddingVertical: TITLE_BAR_PADDING_VERTICAL,
    backgroundColor: COLORS.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    width: BACK_BUTTON_SIZE,
    height: BACK_BUTTON_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  headerInfo: {
    alignItems: 'center',
  },
  // 标题行：标题 + 右侧玩法说明标识
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.text,
  },
  headerSubtitle: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: GRID_H_PADDING,
    paddingTop: 20, // 与在线对局一致：标题行与下方内容间隔 20
  },
  // 玩法说明弹窗内容
  ruleModalBody: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 12,
  },
  ruleLineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  ruleLineDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.primary,
    marginTop: 7,
  },
  ruleLineText: {
    flex: 1,
    fontSize: FONT.body,
    color: COLORS.text,
    lineHeight: 20,
  },
  resumeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bgCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.gold,
    marginBottom: 16,
    overflow: 'hidden',
  },
  resumeMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  resumeIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.success,
    justifyContent: 'center',
    alignItems: 'center',
  },
  resumeInfo: {
    flex: 1,
  },
  resumeTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.text,
  },
  resumeSubtitle: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  resumeDiscard: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  /** 内置/自定义切换按钮（分段控件：内置左、自定义右） */
  tabSwitcher: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  tabButtonText: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  tabButtonTextActive: {
    color: '#FFFFFF',
  },
  // FlatList 的行容器（numColumns 网格）：横向 gap 由这里提供，
  // 纵向行间距用 marginBottom（FlatList 不支持在行容器上写 gap 的同时保证
  // 首行不额外留白，故把行间距放在每行底部，视觉与原先 flexWrap + gap 一致）。
  gridRow: {
    gap: 10,
    marginBottom: 10,
  },
  // 关卡格包装层：宽度由网格实测宽度按列数均分（内联 width），作为皇冠/选择圈等角标的绝对定位锚点，
  // 角标与卡片内容分属不同子树，任何平台下都不会挤压卡片内部居中布局
  levelCellWrap: {
    position: 'relative',
  },
  levelCell: {
    width: '100%',
    aspectRatio: 1.1,
    backgroundColor: COLORS.bgCard,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 6,
  },
  levelCellCompleted: {
    borderColor: '#93BD82',
    backgroundColor: '#E3F1DA', // 浅绿色：已通过关卡整体底色
  },
  levelCellLocked: {
    opacity: 0.55,
  },
  // 通关皇冠：右上角倾斜小皇冠（金/银/铜按最佳提示次数）
  crownBadge: {
    position: 'absolute',
    top: 5,
    right: 5,
    transform: [{ rotate: '32deg' }],
  },
  // 难度分档角标：左上角（与皇冠错开），绝对定位在卡片之外层，不参与卡片内部居中布局
  tierBadge: {
    position: 'absolute',
    top: 5,
    left: 5,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  tierBadgeText: {
    fontSize: FONT.micro,
    fontWeight: '600',
  },
  levelNumber: {
    fontSize: FONT.display,
    fontWeight: '800',
    color: COLORS.primary,
  },
  levelName: {
    fontSize: FONT.caption,
    color: COLORS.text,
    marginTop: 4,
    maxWidth: '100%',
  },
  levelTextMuted: {
    color: COLORS.textMuted,
  },
  emptyText: {
    fontSize: FONT.body,
    color: COLORS.textMuted,
    textAlign: 'center',
    paddingVertical: 16,
  },
  // 自定义卡片右下角再编辑角标（与皇冠错开位置）
  customEditBadge: {
    position: 'absolute',
    bottom: 5,
    right: 5,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(107,114,128,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // 批量删除模式：卡片选中态（主色描边 + 暖色底）
  levelCellSelected: {
    borderColor: COLORS.primary,
    borderWidth: 2,
    backgroundColor: '#F3E9D2',
  },
  // 批量删除模式：左上角选择圈
  selectCircle: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: COLORS.textMuted,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectCircleActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  // 批量删除模式工具栏
  deleteToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.bgCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
  },
  deleteToolbarInfo: {
    fontSize: FONT.body,
    color: COLORS.textMuted,
    flexShrink: 1,
  },
  deleteToolbarActions: {
    flexDirection: 'row',
    gap: 8,
  },
  deleteToolbarBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
  },
  deleteToolbarBtnText: {
    fontSize: FONT.body,
    color: COLORS.text,
    fontWeight: '600',
  },
  deleteToolbarBtnDanger: {
    backgroundColor: COLORS.accent,
  },
  // 删除待确认状态：更深的警示红 + 醒目边框，提示用户再次点击才真正执行
  deleteToolbarBtnArmed: {
    backgroundColor: '#8E1B1B',
    borderWidth: 1,
    borderColor: '#FFD9D9',
  },
  deleteToolbarBtnDangerText: {
    fontSize: FONT.body,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  // 添加残局方式选择弹窗选项行
  choiceBody: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  choiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bg,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 12,
  },
  choiceIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(139, 105, 20, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceInfo: {
    flex: 1,
  },
  choiceTitle: {
    fontSize: FONT.body,
    fontWeight: '700',
    color: COLORS.text,
  },
  choiceSubtitle: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  // 弹窗遮罩/卡片/标题/按钮样式已收敛到 @/components/Modal（AppModal / ModalButton），
  // 尺寸与配色统一走 @/constants/modal 的 Design Tokens。
  // 内边距（左右 24 / 上 20 / 下 24）由 AppModal 的 body 统一提供，
  // 这里不再覆盖 paddingHorizontal —— 否则标签与输入框会贴到卡片边框上。
  // 【C-81】导入弹窗的按钮行已移交给 AppModal 的 footer（页脚区自带分隔线与间距），
  // 原来的 importModalFooter 随之移除。
  ruleModalFooter: {
    marginTop: 18,
  },
  modalBody: {
    // flexGrow:0 = 内容不多时按内容高度收缩；
    // flexShrink:1 + minHeight:0 = 内容超高时这一层先收缩、由 ScrollView 内部滚动。
    // 收缩能否真正生效还取决于 AppModal.body 的 flexShrink:1 + minHeight:0（见 C-81）——
    // RN 的 flexShrink 默认是 0，只在滚动容器自身声明并不足以让整条链收缩。
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  fieldLabel: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.text,
    marginTop: 10,
    marginBottom: 6,
  },
  input: {
    backgroundColor: COLORS.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: FONT.control,
    color: COLORS.text,
  },
  inputMultiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  fieldHint: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 6,
    lineHeight: 16,
  },
  errorText: {
    fontSize: FONT.caption,
    color: COLORS.accent,
    marginTop: 10,
    fontWeight: '600',
  },
});
