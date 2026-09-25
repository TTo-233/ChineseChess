/**
 * 首页 - 中国象棋
 * 设计风格：传统中式 + 现代简约
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { Screen } from '@/components/Screen';
import BoardStyleModal from '@/components/BoardStyleModal';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import { hasSave, loadGame, resolveFirstMover } from '@/utils/GameSave';
import { loadProgress } from '@/utils/EndgameProgress';
import { BUILTIN_ENDGAMES } from '@/utils/chess/endgames';
import { preloadChessAssets } from '@/utils/preloadAssets';

// 主题色 - 浅色复古系
const COLORS = {
  primary: '#8B6914',      // 古铜金（棋盘边框）
  primaryLight: '#A67C00', // 浅古铜
  accent: '#B22222',       // 朱砂红（棋子红方）
  accentLight: '#CD5C5C',
  gold: '#B8860B',         // 暗金色
  bg: '#F5F0E8',           // 米黄/古纸色背景
  bgCard: '#FFF8F0',       // 暖白卡片
  text: '#3E2723',         // 深棕文字
  textMuted: '#8D6E63',    // 浅棕文字
  border: '#D7CCC8',       // 浅棕边框
  boardBg: '#DEB887',      // 棋盘木色
};

export default function HomeScreen() {
  const router = useSafeRouter();
  const [hasSavedGame, setHasSavedGame] = useState(false);
  const [styleModalVisible, setStyleModalVisible] = useState(false);
  const [savedGameInfo, setSavedGameInfo] = useState<{
    difficulty: string;
    playerSide: string;
    firstMover: string;
    moveCount: number;
    timestamp: number;
  } | null>(null);
  // 残局闯关进度
  const [endgamePassed, setEndgamePassed] = useState(0);
  // 入口导航锁：快速连点入口卡片会导致同一路由重复入栈（表现为"返回后又回到本页"），
  // 800ms 窗口内忽略后续点击
  const navLockAtRef = useRef(0);
  const pushOnce = useCallback((path: '/replay' | '/pveSetup' | '/endgame' | '/lanGame') => {
    const now = Date.now();
    if (now - navLockAtRef.current < 800) return;
    navLockAtRef.current = now;
    router.push(path);
  }, [router]);

  const checkSavedGame = async () => {
    const exists = await hasSave();
    setHasSavedGame(exists);
    if (exists) {
      const save = await loadGame();
      if (save) {
        const diffLabel = { easy: '入门', medium: '进阶', hard: '大师' }[save.difficulty] || save.difficulty;
        const sideLabel = save.playerSide === 'red' ? '红方' : '黑方';
        const moverLabel = resolveFirstMover(save) === 'player' ? '先手' : '后手';
        setSavedGameInfo({
          difficulty: diffLabel,
          playerSide: sideLabel,
          firstMover: moverLabel,
          moveCount: save.moveCount,
          timestamp: save.timestamp,
        });
      }
    }
  };

  useFocusEffect(
    useCallback(() => {
      checkSavedGame();
      loadProgress().then(p => setEndgamePassed(p.completed.length));
      // 首页空闲期预热全部对局图片资源（幂等），消除进局/换样式/特效的首帧解码延迟
      preloadChessAssets();
    }, [])
  );

  return (
    <Screen>
      <View style={styles.container}>
        {/* 固定右上角：历史对局（复盘）+ 设置（棋盘样式）入口，独立于标题单独一行 */}
        <View style={styles.topBarRow}>
          <TouchableOpacity
            style={styles.replayEntry}
            onPress={() => pushOnce('/replay')}
            activeOpacity={0.8}
          >
            <FontAwesome6 name="clock-rotate-left" size={17} color={COLORS.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.replayEntry}
            onPress={() => setStyleModalVisible(true)}
            activeOpacity={0.8}
          >
            <FontAwesome6 name="gear" size={17} color={COLORS.primary} />
          </TouchableOpacity>
        </View>

        {/* 其余内容整体居中，保证一屏显示 */}
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
        >
          {/* 顶部标题区 */}
          <View style={styles.headerSection}>
            <View style={styles.titleContainer}>
              <Text style={styles.titleChinese}>中 国 象 棋</Text>
              <View style={styles.titleDivider} />
              <Text style={styles.titleEnglish}>CHINESE CHESS</Text>
            </View>
          </View>

          {/* 人机对战入口（进入独立设置页） */}
          <TouchableOpacity
            style={styles.entryCard}
            onPress={() => pushOnce('/pveSetup')}
            activeOpacity={0.8}
          >
            <View style={styles.entryIcon}>
              <FontAwesome6 name="robot" size={20} color={COLORS.gold} />
            </View>
            <View style={styles.entryInfo}>
              <Text style={styles.entryTitle}>人机对战</Text>
              <Text style={styles.entryDescription}>
                {hasSavedGame ? '有未完成的棋局 · 点击进入' : '三种难度 · 可保存棋局'}
              </Text>
            </View>
            <FontAwesome6 name="chevron-right" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>

          {/* 残局闯关入口 */}
          <TouchableOpacity
            style={styles.entryCard}
            onPress={() => pushOnce('/endgame')}
            activeOpacity={0.8}
          >
            <View style={styles.entryIcon}>
              <FontAwesome6 name="puzzle-piece" size={20} color={COLORS.gold} />
            </View>
            <View style={styles.entryInfo}>
              <Text style={styles.entryTitle}>残局闯关</Text>
              <Text style={styles.entryDescription}>
                已通过 {endgamePassed}/{BUILTIN_ENDGAMES.length} 关 · 大师难度
              </Text>
            </View>
            <FontAwesome6 name="chevron-right" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>

          {/* 在线对局入口 */}
          <TouchableOpacity
            style={styles.entryCard}
            onPress={() => pushOnce('/lanGame')}
            activeOpacity={0.8}
          >
            <View style={styles.entryIcon}>
              <FontAwesome6 name="globe" size={20} color={COLORS.gold} />
            </View>
            <View style={styles.entryInfo}>
              <Text style={styles.entryTitle}>在线对局</Text>
              <Text style={styles.entryDescription}>与远方的朋友在线对弈</Text>
            </View>
            <FontAwesome6 name="chevron-right" size={16} color={COLORS.textMuted} />
          </TouchableOpacity>

          {/* 底部信息 */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>人生如棋，落子无悔</Text>
          </View>
        </ScrollView>

        {/* 棋盘样式设置弹窗 */}
        <BoardStyleModal
          visible={styleModalVisible}
          onClose={() => setStyleModalVisible(false)}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  // 固定右上角行：复盘入口 + 设置入口独立于标题
  topBarRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 4,
  },
  scroll: {
    flex: 1,
  },
  contentContainer: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  headerSection: {
    alignItems: 'center',
    marginBottom: 32,
  },
  // 右上角历史对局入口（固定在标题上方独立一行）
  replayEntry: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  titleContainer: {
    alignItems: 'center',
  },
  titleChinese: {
    fontSize: 36,
    fontWeight: '900',
    color: COLORS.text,
    letterSpacing: 8,
  },
  titleDivider: {
    width: 60,
    height: 2,
    backgroundColor: COLORS.gold,
    marginVertical: 12,
  },
  titleEnglish: {
    fontSize: 12,
    color: COLORS.textMuted,
    letterSpacing: 4,
    fontWeight: '500',
  },
  // 游玩功能入口卡片（人机对战 / 残局闯关 / 在线对局）
  entryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.bgCard,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 16,
    paddingVertical: 18,
    marginBottom: 16,
    gap: 14,
  },
  entryIcon: {
    width: 46,
    height: 46,
    borderRadius: 12,
    backgroundColor: 'rgba(184, 134, 11, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  entryInfo: {
    flex: 1,
  },
  entryTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.text,
  },
  entryDescription: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 3,
  },
  footer: {
    alignItems: 'center',
    marginTop: 32,
    gap: 4,
  },
  footerText: {
    fontSize: 12,
    color: COLORS.textMuted,
    opacity: 0.6,
  },
});
