/**
 * 人机对战 - 独立设置页（二级界面）
 * 继续对局 / 执棋方 / 先后手 / AI 难度 / 开始对弈
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import { hasSave, loadGame, deleteSave, resolveFirstMover } from '@/utils/GameSave';
import { FONT } from '@/utils/typography';
import {
  TITLE_BAR_PADDING_HORIZONTAL,
  TITLE_BAR_PADDING_VERTICAL,
  BACK_BUTTON_SIZE,
} from '@/constants/chrome';

const COLORS = {
  primary: '#8B6914',
  accent: '#B22222',
  gold: '#B8860B',
  bg: '#F5F0E8',
  bgCard: '#FFF8F0',
  text: '#3E2723',
  textMuted: '#8D6E63',
  border: '#D7CCC8',
};

type Difficulty = 'easy' | 'medium' | 'hard';
type PlayerSide = 'red' | 'black';
type FirstMover = 'player' | 'ai';

const DIFFICULTY_OPTIONS: { key: Difficulty; label: string; desc: string; icon: string }[] = [
  { key: 'easy', label: '入门', desc: '小试牛刀', icon: 'leaf' },
  { key: 'medium', label: '进阶', desc: '炉火纯青', icon: 'fire' },
  { key: 'hard', label: '大师', desc: '登堂入室', icon: 'crown' },
];

export default function PveSetupScreen() {
  const router = useSafeRouter();
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [playerSide, setPlayerSide] = useState<PlayerSide>('red');
  const [firstMover, setFirstMover] = useState<FirstMover>('player');
  const [hasSavedGame, setHasSavedGame] = useState(false);
  const [savedGameInfo, setSavedGameInfo] = useState<{
    difficulty: string;
    playerSide: string;
    firstMover: string;
    moveCount: number;
    timestamp: number;
  } | null>(null);

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
    } else {
      setSavedGameInfo(null);
    }
  };

  useFocusEffect(
    useCallback(() => {
      checkSavedGame();
    }, [])
  );

  const handleStartGame = () => {
    router.push('/game', {
      difficulty,
      playerSide,
      firstMover,
    });
  };

  const handleContinueGame = () => {
    // 旧存档无 firstMover 字段时，按旧规则推断（红方=玩家先手）
    const diffMap: Record<string, string> = { '入门': 'easy', '进阶': 'medium', '大师': 'hard' };
    router.push('/game', {
      difficulty: (savedGameInfo && diffMap[savedGameInfo.difficulty]) || 'medium',
      playerSide: savedGameInfo?.playerSide === '黑方' ? 'black' : 'red',
      firstMover: savedGameInfo?.firstMover === '后手' ? 'ai' : 'player',
      continueGame: true,
    });
  };

  const handleDeleteSave = async () => {
    await deleteSave();
    setHasSavedGame(false);
    setSavedGameInfo(null);
  };

  return (
    // 背景色传入 Screen：顶部安全区与返回栏区域同样使用主题米色，与内容区统一
    <Screen backgroundColor={COLORS.bg}>
      {/* 顶部导航 */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <FontAwesome6 name="chevron-left" size={20} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.topTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>人机对战</Text>
        <View style={{ width: BACK_BUTTON_SIZE }} />
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        {/* 继续上次对局 */}
        {hasSavedGame && savedGameInfo && (
          <View style={styles.continueSection}>
            <View style={styles.continueHeader}>
              <FontAwesome6 name="clock-rotate-left" size={16} color={COLORS.gold} />
              <Text style={styles.continueTitle}>继续上次对局</Text>
              <View style={styles.continueInfo}>
                <Text style={styles.continueInfoText}>
                  {savedGameInfo.difficulty} · {savedGameInfo.playerSide} · {savedGameInfo.firstMover} · 第{Math.ceil(savedGameInfo.moveCount / 2) + 1}回合
                </Text>
              </View>
            </View>
            <View style={styles.continueButtons}>
              <TouchableOpacity style={styles.continueButton} onPress={handleContinueGame}>
                <FontAwesome6 name="play" size={14} color="#FFFFFF" />
                <Text style={styles.continueButtonText}>继续对局</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.deleteSaveButton} onPress={handleDeleteSave}>
                <FontAwesome6 name="trash" size={12} color={COLORS.textMuted} />
                <Text style={styles.deleteSaveButtonText}>删除</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.continueDivider} />
          </View>
        )}

        {/* 选择执棋方 */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>选择执棋</Text>
          <View style={styles.sideSelector}>
            <TouchableOpacity
              style={[styles.sideButton, playerSide === 'red' && styles.sideButtonActive]}
              onPress={() => setPlayerSide('red')}
            >
              <View style={[styles.sideDot, { backgroundColor: COLORS.accent }]} />
              <Text style={[styles.sideButtonText, playerSide === 'red' && styles.sideButtonTextActive]}>红方</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sideButton, playerSide === 'black' && styles.sideButtonActive]}
              onPress={() => setPlayerSide('black')}
            >
              <View style={[styles.sideDot, { backgroundColor: COLORS.text }]} />
              <Text style={[styles.sideButtonText, playerSide === 'black' && styles.sideButtonTextActive]}>黑方</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 选择先后手 */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>选择先后手</Text>
          <View style={styles.sideSelector}>
            <TouchableOpacity
              style={[styles.sideButton, firstMover === 'player' && styles.sideButtonActive]}
              onPress={() => setFirstMover('player')}
            >
              <FontAwesome6 name="play" size={16} color={firstMover === 'player' ? COLORS.gold : COLORS.textMuted} />
              <Text style={[styles.sideButtonText, firstMover === 'player' && styles.sideButtonTextActive]}>先手</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sideButton, firstMover === 'ai' && styles.sideButtonActive]}
              onPress={() => setFirstMover('ai')}
            >
              <FontAwesome6 name="hourglass-half" size={16} color={firstMover === 'ai' ? COLORS.gold : COLORS.textMuted} />
              <Text style={[styles.sideButtonText, firstMover === 'ai' && styles.sideButtonTextActive]}>后手</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.sectionHint}>
            {firstMover === 'player' ? '你先行走棋' : 'AI 先行走棋'}
          </Text>
        </View>

        {/* 选择难度 */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>AI 难度</Text>
          <View style={styles.difficultyGrid}>
            {DIFFICULTY_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.difficultyCard, difficulty === opt.key && styles.difficultyCardActive]}
                onPress={() => setDifficulty(opt.key)}
              >
                <FontAwesome6
                  name={opt.icon as any}
                  size={22}
                  color={difficulty === opt.key ? COLORS.gold : COLORS.textMuted}
                />
                <Text style={[styles.difficultyLabel, difficulty === opt.key && styles.difficultyLabelActive]}>
                  {opt.label}
                </Text>
                <Text style={styles.difficultyDesc}>{opt.desc}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.engineHint}>
            皮卡鱼引擎内置在本机运行，断网也能用，棋力不受网络影响
          </Text>
        </View>

        {/* 开始按钮 */}
        <TouchableOpacity
          style={styles.startButton}
          onPress={handleStartGame}
          activeOpacity={0.8}
        >
          <View style={styles.startButtonInner}>
            <Text style={styles.startButtonText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              {hasSavedGame ? '开始新对弈' : '开始对弈'}
            </Text>
            <FontAwesome6 name="arrow-right" size={18} color="#fff" style={{ marginLeft: 8 }} />
          </View>
        </TouchableOpacity>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  contentContainer: {
    paddingHorizontal: 20,
    paddingTop: 20, // 与在线对局一致：标题行与下方内容间隔 20
    paddingBottom: 40,
  },
  // 顶部标题行：暖白卡片底 + 底部分隔线，与在线对局标题行颜色保持一致
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: TITLE_BAR_PADDING_HORIZONTAL,
    paddingVertical: TITLE_BAR_PADDING_VERTICAL,
    backgroundColor: COLORS.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  /** 返回按钮：与残局闯关/在线对局/复盘列表统一的 40×40 圆角卡片样式 */
  backButton: {
    width: BACK_BUTTON_SIZE,
    height: BACK_BUTTON_SIZE,
    borderRadius: 12,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  topTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.text,
  },
  section: {
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginBottom: 10,
    fontWeight: '500',
  },
  sideSelector: {
    flexDirection: 'row',
    gap: 12,
  },
  sideButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  sideButtonActive: {
    backgroundColor: 'rgba(184, 134, 11, 0.1)',
    borderColor: COLORS.gold,
  },
  sideDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  sideButtonText: {
    fontSize: FONT.control,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  sideButtonTextActive: {
    color: COLORS.primary,
  },
  sectionHint: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 8,
    opacity: 0.8,
  },
  difficultyGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  difficultyCard: {
    flex: 1,
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderRadius: 14,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    gap: 6,
  },
  difficultyCardActive: {
    backgroundColor: 'rgba(184, 134, 11, 0.1)',
    borderColor: COLORS.gold,
  },
  difficultyLabel: {
    fontSize: FONT.body,
    fontWeight: '700',
    color: COLORS.textMuted,
  },
  difficultyLabelActive: {
    color: COLORS.gold,
  },
  difficultyDesc: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    opacity: 0.7,
  },
  // 引擎说明文案的样式（旧名 hybridHint 来自已删除的"混合调度/联网兜底"体系）
  engineHint: {
    marginTop: 12,
    fontSize: FONT.caption,
    lineHeight: 18,
    color: COLORS.textMuted,
    opacity: 0.65,
    textAlign: 'center',
  },
  continueSection: {
    paddingBottom: 16,
  },
  continueHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  continueTitle: {
    fontSize: FONT.body,
    fontWeight: '700',
    color: COLORS.text,
  },
  continueInfo: {
    marginLeft: 'auto',
  },
  continueInfoText: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
  },
  continueButtons: {
    flexDirection: 'row',
    gap: 10,
  },
  continueButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  continueButtonText: {
    fontSize: FONT.body,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  deleteSaveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.04)',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    gap: 4,
  },
  deleteSaveButtonText: {
    fontSize: FONT.body,
    color: COLORS.textMuted,
  },
  continueDivider: {
    height: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.06)',
    marginTop: 14,
  },
  startButton: {
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: COLORS.accent,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
    marginTop: 4,
  },
  startButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    paddingVertical: 18,
    paddingHorizontal: 32,
  },
  startButtonText: {
    fontSize: FONT.control,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 2,
  },
});
