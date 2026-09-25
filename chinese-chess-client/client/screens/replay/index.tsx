/**
 * 历史对局（复盘列表）
 *
 * - 人机对战 / 在线对局 Tab 切换
 * - 时间筛选：全部 / 今天 / 近7天 / 近30天
 * - 星标收藏；长按进入批量删除模式（收藏对局不可选、不会被删除）
 * - 点击进入复盘播放页
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Modal,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  listReplays,
  toggleFavorite,
  deleteReplays,
  type ReplayGame,
  type ReplayMode,
} from '@/utils/replayStorage';

// 主题色 - 浅色复古系（与首页/人机对战一致）
const COLORS = {
  primary: '#8B6914',
  gold: '#B8860B',
  bg: '#F5F0E8',
  bgCard: '#FFF8F0',
  text: '#3E2723',
  textMuted: '#8D6E63',
  border: '#D7CCC8',
  danger: '#C62828',
  success: '#2E7D32',
  redPiece: '#B22222',
};

type TimeFilter = 'all' | 'today' | '7d' | '30d';

const TIME_FILTERS: { key: TimeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 时间筛选：all=不过滤；today=当天 0 点起；7d/30d=距今 N 天内 */
function matchTimeFilter(timestamp: number, filter: TimeFilter, now: number): boolean {
  if (filter === 'all') return true;
  if (filter === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return timestamp >= d.getTime();
  }
  const days = filter === '7d' ? 7 : 30;
  return timestamp >= now - days * DAY_MS;
}

/** 列表时间显示：今天=时:分，今年=M月D日，更早=YYYY/M/D */
function formatTime(timestamp: number, now: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  if (timestamp >= todayStart.getTime()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 胜负结果（从保存者视角） */
function resultInfo(game: ReplayGame): { label: string; color: string } {
  if (!game.winnerSide) return { label: '和棋', color: COLORS.textMuted };
  if (game.winnerSide === game.mySide) return { label: '胜', color: COLORS.success };
  return { label: '负', color: COLORS.danger };
}

export default function ReplayListScreen() {
  const router = useSafeRouter();
  const [games, setGames] = useState<ReplayGame[]>([]);
  const [mode, setMode] = useState<ReplayMode>('pve');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  // 批量删除模式：长按卡片进入，收藏对局不可选
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 当前时间快照（进入页面/刷新时更新）：供时间筛选与列表时间显示使用
  const [nowTs, setNowTs] = useState(0);

  const reload = useCallback(async () => {
    setNowTs(Date.now());
    const list = await listReplays();
    setGames(list);
  }, []);

  // 每次进入页面刷新（对局结算返回、播放页返回后列表均为最新）
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );

  // 当前筛选结果（模式 + 时间）；nowTs 初始为 0 时退化为全量匹配（reload 会先更新时间快照）
  const now = nowTs;
  const filtered = useMemo(
    () => games.filter(g => g.mode === mode && (now === 0 || matchTimeFilter(g.timestamp, timeFilter, now))),
    [games, mode, timeFilter, now]
  );

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setConfirmVisible(false);
  }, []);

  // 切换模式/筛选时退出多选，避免选中不可见项
  const switchMode = (m: ReplayMode) => {
    setMode(m);
    exitSelectMode();
  };
  const switchTimeFilter = (f: TimeFilter) => {
    setTimeFilter(f);
    exitSelectMode();
  };

  const toggleSelect = (game: ReplayGame) => {
    if (game.favorite) return; // 收藏对局不可选
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(game.id)) {
        next.delete(game.id);
      } else {
        next.add(game.id);
      }
      return next;
    });
  };

  const handleCardPress = (game: ReplayGame) => {
    if (selectMode) {
      toggleSelect(game);
    } else {
      router.push('/replayPlayer', { id: game.id });
    }
  };

  const handleCardLongPress = (game: ReplayGame) => {
    if (selectMode || game.favorite) return;
    setSelectMode(true);
    setSelectedIds(new Set([game.id]));
  };

  const handleToggleFavorite = async (game: ReplayGame) => {
    const next = await toggleFavorite(game.id);
    if (next === null) return;
    setGames(prev => prev.map(g => (g.id === game.id ? { ...g, favorite: next } : g)));
  };

  // 全选当前筛选结果中的未收藏对局
  const selectableIds = filtered.filter(g => !g.favorite).map(g => g.id);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id));
  const handleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(selectableIds));
  };

  const handleConfirmDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    // 服务端/存储层双重保护：收藏对局即使被传入也不会删除
    await deleteReplays(Array.from(selectedIds));
    setDeleting(false);
    exitSelectMode();
    reload();
  };

  const renderCard = ({ item }: { item: ReplayGame }) => {
    const result = resultInfo(item);
    const selected = selectedIds.has(item.id);
    return (
      <TouchableOpacity
        style={[styles.card, selected && styles.cardSelected]}
        onPress={() => handleCardPress(item)}
        onLongPress={() => handleCardLongPress(item)}
        activeOpacity={0.8}
        delayLongPress={350}
      >
        {/* 左侧模式图标 */}
        <View style={styles.cardIcon}>
          <FontAwesome6
            name={item.mode === 'pve' ? 'robot' : 'globe'}
            size={18}
            color={COLORS.gold}
          />
        </View>

        {/* 中间信息 */}
        <View style={styles.cardInfo}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.mode === 'pve' ? '人机对战' : '在线对局'} · {item.note}
            </Text>
            <View style={[styles.resultBadge, { borderColor: result.color }]}>
              <Text style={[styles.resultBadgeText, { color: result.color }]}>{result.label}</Text>
            </View>
          </View>
          <Text style={styles.cardSubtitle}>
            {formatTime(item.timestamp, now)} · 共{item.moveCount}步
            {item.favorite ? ' · 已收藏' : ''}
          </Text>
        </View>

        {/* 右侧：多选模式=勾选框（收藏禁用），普通模式=星标 */}
        {selectMode ? (
          <View
            style={[
              styles.checkCircle,
              selected && styles.checkCircleSelected,
              item.favorite && styles.checkCircleDisabled,
            ]}
          >
            {selected && <FontAwesome6 name="check" size={12} color="#FFF" />}
            {item.favorite && <FontAwesome6 name="star" size={10} color={COLORS.textMuted} />}
          </View>
        ) : (
          <TouchableOpacity
            style={styles.starButton}
            onPress={() => handleToggleFavorite(item)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <FontAwesome6
              name="star"
              size={18}
              color={item.favorite ? COLORS.gold : COLORS.border}
              solid={item.favorite}
            />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Screen>
      <View style={styles.container}>
        {/* 顶部标题栏（与人机对战一致） */}
        <View style={styles.topBar}>
          <View style={styles.topBarSide}>
            <TouchableOpacity
              onPress={() => (selectMode ? exitSelectMode() : router.back())}
              style={styles.backButtonInner}
            >
              <FontAwesome6 name="chevron-left" size={20} color={COLORS.text} />
            </TouchableOpacity>
          </View>
          <View style={styles.topBarCenter}>
            <Text style={styles.topBarTitle}>
              {selectMode ? `已选 ${selectedIds.size} 项` : '历史对局'}
            </Text>
            {!selectMode && (
              <Text style={styles.topBarSubtitle}>共 {filtered.length} 局</Text>
            )}
          </View>
          <View style={[styles.topBarSide, styles.topBarRight]}>
            {selectMode && (
              <TouchableOpacity
                style={[styles.headerDeleteChip, selectedIds.size === 0 && { opacity: 0.4 }]}
                onPress={() => selectedIds.size > 0 && setConfirmVisible(true)}
              >
                <FontAwesome6 name="trash-can" size={14} color={COLORS.danger} />
                <Text style={styles.headerDeleteText}>删除</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* 模式切换（人机对战 / 在线对局） */}
        <View style={styles.modeRow}>
          <TouchableOpacity
            style={[styles.modeChip, mode === 'pve' && styles.modeChipActive]}
            onPress={() => switchMode('pve')}
            activeOpacity={0.8}
          >
            <FontAwesome6
              name="robot"
              size={14}
              color={mode === 'pve' ? '#FFF' : COLORS.textMuted}
            />
            <Text style={[styles.modeChipText, mode === 'pve' && styles.modeChipTextActive]}>
              人机对战
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeChip, mode === 'lan' && styles.modeChipActive]}
            onPress={() => switchMode('lan')}
            activeOpacity={0.8}
          >
            <FontAwesome6
              name="globe"
              size={14}
              color={mode === 'lan' ? '#FFF' : COLORS.textMuted}
            />
            <Text style={[styles.modeChipText, mode === 'lan' && styles.modeChipTextActive]}>
              在线对局
            </Text>
          </TouchableOpacity>
        </View>

        {/* 时间筛选 */}
        <View style={styles.filterRow}>
          {TIME_FILTERS.map(f => (
            <TouchableOpacity
              key={f.key}
              style={[styles.filterChip, timeFilter === f.key && styles.filterChipActive]}
              onPress={() => switchTimeFilter(f.key)}
              activeOpacity={0.8}
            >
              <Text
                style={[styles.filterChipText, timeFilter === f.key && styles.filterChipTextActive]}
              >
                {f.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 对局列表 */}
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          renderItem={renderCard}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <FontAwesome6 name="chess-board" size={40} color={COLORS.border} />
              <Text style={styles.emptyText}>
                {games.length === 0 ? '暂无历史对局\n完成对局后自动保存' : '该筛选条件下暂无对局'}
              </Text>
            </View>
          }
        />

        {/* 多选模式底部操作栏 */}
        {selectMode && (
          <View style={styles.bottomBar}>
            <TouchableOpacity style={styles.actionButton} onPress={handleSelectAll}>
              <FontAwesome6
                name={allSelected ? 'square-minus' : 'square-check'}
                size={16}
                color={COLORS.text}
              />
              <Text style={styles.actionButtonText}>{allSelected ? '全不选' : '全选'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionButton, selectedIds.size === 0 && { opacity: 0.4 }]}
              onPress={() => selectedIds.size > 0 && setConfirmVisible(true)}
            >
              <FontAwesome6 name="trash-can" size={16} color={COLORS.danger} />
              <Text style={[styles.actionButtonText, { color: COLORS.danger }]}>
                删除({selectedIds.size})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={exitSelectMode}>
              <FontAwesome6 name="xmark" size={16} color={COLORS.text} />
              <Text style={styles.actionButtonText}>取消</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* 删除确认弹窗 */}
        <Modal visible={confirmVisible} transparent animationType="fade">
          <View style={styles.modalMask}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>删除对局</Text>
              <Text style={styles.modalMessage}>
                确定删除选中的 {selectedIds.size} 局对局吗？{'\n'}收藏的对局不会被删除。
              </Text>
              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.modalCancelButton]}
                  onPress={() => setConfirmVisible(false)}
                >
                  <Text style={styles.modalCancelText}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalButton, styles.modalDeleteButton]}
                  onPress={handleConfirmDelete}
                >
                  <Text style={styles.modalDeleteText}>{deleting ? '删除中…' : '确认删除'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
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
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    backgroundColor: COLORS.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  topBarSide: {
    width: 100,
    justifyContent: 'center',
  },
  topBarRight: {
    alignItems: 'flex-end',
  },
  backButtonInner: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  topBarCenter: {
    flex: 1,
    alignItems: 'center',
  },
  topBarTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
  },
  topBarSubtitle: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  headerDeleteChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.danger,
    backgroundColor: COLORS.bgCard,
  },
  headerDeleteText: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.danger,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  modeChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modeChipActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  modeChipText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  modeChipTextActive: {
    color: '#FFF',
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  filterChipActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  filterChipTextActive: {
    color: '#FFF',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
    gap: 10,
    flexGrow: 1,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bgCard,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  cardSelected: {
    borderColor: COLORS.primary,
    backgroundColor: '#F3E9D2',
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardInfo: {
    flex: 1,
    gap: 4,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
  },
  resultBadge: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  resultBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  cardSubtitle: {
    fontSize: 12,
    color: COLORS.textMuted,
  },
  starButton: {
    padding: 4,
  },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkCircleSelected: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  checkCircleDisabled: {
    borderColor: COLORS.border,
    backgroundColor: COLORS.bg,
  },
  emptyBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingBottom: 60,
  },
  emptyText: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  bottomBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: COLORS.bgCard,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: COLORS.bgCard,
    paddingHorizontal: 6,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  modalMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  modalCard: {
    width: '100%',
    backgroundColor: COLORS.bgCard,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
  },
  modalMessage: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 22,
    marginTop: 10,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalCancelButton: {
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text,
  },
  modalDeleteButton: {
    backgroundColor: COLORS.danger,
  },
  modalDeleteText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFF',
  },
});
