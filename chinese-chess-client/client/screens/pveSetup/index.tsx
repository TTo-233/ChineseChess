/**
 * 人机对战 - 独立设置页（二级界面）
 * 选择模式 / 继续对局 / 执棋方 / 先后手 / AI 难度 / 开始对弈
 *
 * 【模式合并（2026-10）】揭棋入口已并入本页，成为首行的「选择模式」。
 * 两者共用一个设置页，因为除模式本身外，设置项完全一致（执棋方 / AI 难度）；
 * 拆成两页只会让「换模式」变成「退回首页再点另一个入口」。
 *
 * 但**存档仍然分开**：象棋走 chess_game_save，揭棋走 chess_jieqi_save，
 * 各自可存一局、互不覆盖（对局页 screens/game 按 variant 分流，见该文件
 * saveBattle / loadBattle / deleteBattleSave）。
 * 所以本页的续局区与保存逻辑也要跟着当前模式切换，不能用一个通用存档。
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
import { AppModal, ModalButton, modalButtonRowStyle } from '@/components/Modal';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  hasSave,
  loadGame,
  deleteSave,
  resolveFirstMover,
  loadJieqiGame,
  deleteJieqiSave,
  canResumeJieqi,
} from '@/utils/GameSave';
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
/** 玩法模式：象棋（缺省） / 揭棋 */
type GameMode = 'xiangqi' | 'jieqi';

const MODE_OPTIONS: { key: GameMode; label: string; icon: string }[] = [
  { key: 'xiangqi', label: '象棋', icon: 'chess' },
  { key: 'jieqi', label: '揭棋', icon: 'circle-question' },
];

const DIFFICULTY_OPTIONS: { key: Difficulty; label: string; desc: string; icon: string }[] = [
  { key: 'easy', label: '入门', desc: '小试牛刀', icon: 'leaf' },
  { key: 'medium', label: '进阶', desc: '炉火纯青', icon: 'fire' },
  { key: 'hard', label: '大师', desc: '登堂入室', icon: 'crown' },
];

// 玩法说明（仅揭棋模式显示；标题行右侧 (i) 标识点击后弹窗，
// 与残局闯关选关页 screens/endgame 的 headerTitleRow 同一套样式）
const JIEQI_RULE_LINES = [
  '开局时除将帅外，双方各有 15 枚棋子背面朝上，身份随机，暗子的身份对双方都不可见',
  '暗子按所在棋位的棋种走',
  '暗子移动即翻开，身份当众公开',
  '暗子不算将军，也不攻击对方',
  '揭开的士、象可以过河',
  '吃掉的暗子不会补上新子',
];

export default function PveSetupScreen() {
  const router = useSafeRouter();
  const [mode, setMode] = useState<GameMode>('xiangqi');
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [playerSide, setPlayerSide] = useState<PlayerSide>('red');
  const [firstMover, setFirstMover] = useState<FirstMover>('player');
  // 玩法说明弹窗（仅揭棋模式挂在标题栏右侧）
  const [ruleVisible, setRuleVisible] = useState(false);
  const isJieqi = mode === 'jieqi';

  // 续局信息按模式各存各的，故这里只保留「当前模式」那一档的摘要。
  // 揭棋档额外记录 identityOk：老揭棋档可能缺身份表，读得出但续不了，不该显示成可续局。
  const [hasSavedGame, setHasSavedGame] = useState(false);
  const [savedGameInfo, setSavedGameInfo] = useState<{
    difficulty: string;
    playerSide: string;
    firstMover: string;
    moveCount: number;
    timestamp: number;
  } | null>(null);

  const checkSavedGame = useCallback(async () => {
    if (mode === 'jieqi') {
      const save = await loadJieqiGame();
      if (!save || !canResumeJieqi(save)) {
        setHasSavedGame(false);
        setSavedGameInfo(null);
        return;
      }
      const diffLabel = { easy: '入门', medium: '进阶', hard: '大师' }[save.difficulty as Difficulty] || save.difficulty;
      setHasSavedGame(true);
      setSavedGameInfo({
        difficulty: diffLabel,
        playerSide: save.playerSide === 'red' ? '红方' : '黑方',
        // 揭棋固定红先：执红即先手，与开局时同一口径
        firstMover: save.playerSide === 'red' ? '先手' : '后手',
        moveCount: save.moveCount,
        timestamp: save.timestamp,
      });
      return;
    }

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
  }, [mode]);

  useFocusEffect(
    useCallback(() => {
      checkSavedGame();
    }, [checkSavedGame])
  );

  // 切模式立即重查存档：两个模式各存一局，沿用上一模式的续局区会显示错的那一局
  const handleModeChange = (next: GameMode) => {
    setMode(next);
    setRuleVisible(false);
  };

  const handleStartGame = () => {
    if (isJieqi) {
      // 揭棋红先：玩家执红 → 玩家先手；玩家执黑 → AI 先手。
      // 这里不能沿用 firstMover 开关（揭棋没有它，规则 1 规定红先）。
      router.push('/game', {
        variant: 'jieqi',
        difficulty,
        playerSide,
        firstMover: playerSide === 'red' ? 'player' : 'ai',
      });
      return;
    }
    router.push('/game', {
      difficulty,
      playerSide,
      firstMover,
    });
  };

  const handleContinueGame = () => {
    // 旧存档无 firstMover 字段时，按旧规则推断（红方=玩家先手）
    const diffMap: Record<string, string> = { '入门': 'easy', '进阶': 'medium', '大师': 'hard' };
    const base = {
      difficulty: (savedGameInfo && diffMap[savedGameInfo.difficulty]) || 'medium',
      playerSide: savedGameInfo?.playerSide === '黑方' ? 'black' : 'red',
      continueGame: true,
    };
    if (isJieqi) {
      // 揭棋续局必须带 variant，对局页据此读揭棋存档键并装回身份表
      router.push('/game', {
        ...base,
        variant: 'jieqi',
        // 揭棋先后手由执棋方唯一决定（红先），与开局时同一口径
        firstMover: savedGameInfo?.playerSide === '红方' ? 'player' : 'ai',
      });
      return;
    }
    router.push('/game', {
      ...base,
      firstMover: savedGameInfo?.firstMover === '后手' ? 'ai' : 'player',
    });
  };

  const handleDeleteSave = async () => {
    if (isJieqi) {
      await deleteJieqiSave();
    } else {
      await deleteSave();
    }
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
        <View style={styles.topTitleRow}>
          <Text style={styles.topTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>人机对战</Text>
          {/* 标题右侧：玩法说明标识，仅揭棋模式出现（象棋规则人人皆知，挂了反而是噪音） */}
          {isJieqi && (
            <TouchableOpacity
              onPress={() => setRuleVisible(true)}
              accessibilityLabel="玩法说明"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <FontAwesome6 name="circle-info" size={14} color={COLORS.primary} />
            </TouchableOpacity>
          )}
        </View>
        <View style={{ width: BACK_BUTTON_SIZE }} />
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        {/* 选择模式（首行）：象棋 / 揭棋。两种玩法共用本页其余设置 */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>选择模式</Text>
          <View style={styles.modeSelector}>
            {MODE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.modeButton, mode === opt.key && styles.modeButtonActive]}
                onPress={() => handleModeChange(opt.key)}
                activeOpacity={0.8}
              >
                <FontAwesome6
                  name={opt.icon as any}
                  size={18}
                  color={mode === opt.key ? COLORS.gold : COLORS.textMuted}
                />
                <Text style={[styles.modeButtonText, mode === opt.key && styles.modeButtonTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* 继续上次对局（按当前模式读各自的存档键） */}
        {hasSavedGame && savedGameInfo && (
          <View style={styles.continueSection}>
            <View style={styles.continueHeader}>
              <FontAwesome6 name="clock-rotate-left" size={16} color={COLORS.gold} />
              <Text style={styles.continueTitle}>
                {isJieqi ? '继续上次揭棋' : '继续上次对局'}
              </Text>
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
          {/* 揭棋固定红先（规则 1），先后手由执棋方唯一决定，故不给独立开关 */}
          <Text style={styles.sectionHint}>
            {isJieqi
              ? (playerSide === 'red' ? '你执红先行（揭棋固定红先）' : '你执黑后行，AI 先走')
              : '选择你要执的棋子颜色'}
          </Text>
        </View>

        {/* 选择先后手（仅象棋：揭棋红先，执棋方已唯一决定先后手） */}
        {!isJieqi && (
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
        )}

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
            {/*
              如实说明棋力来源，不虚报：
              · 象棋走本机内置皮卡鱼；
              · 揭棋没有专用引擎（皮卡鱼只懂象棋），走本机内置 TS AI，
                大师档深度已从 4 降到 3（每步还要算暗子身份概率，更费时间）。
            */}
            {isJieqi
              ? '揭棋由本机内置 AI 对弈，断网也能用；它会按暗子的可能身份估算优劣'
              : '皮卡鱼引擎内置在本机运行，断网也能用，棋力不受网络影响'}
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

        {/* 揭棋额外说明：它与象棋的存档分开，且不支持复盘 */}
        {isJieqi && (
          <Text style={styles.footnote}>
            揭棋与象棋各自保存一局，互不影响；揭棋暂不支持复盘
          </Text>
        )}
      </ScrollView>

      {/* 玩法说明弹窗（仅揭棋模式；与残局闯关同一套 AppModal + ModalButton 语言） */}
      <AppModal
        visible={ruleVisible}
        onClose={() => setRuleVisible(false)}
        title="玩法说明"
        showCloseBtn
        bodyStyle={styles.ruleModalBody}
      >
        {JIEQI_RULE_LINES.map(line => (
          <View key={line} style={styles.ruleLineRow}>
            <View style={styles.ruleLineDot} />
            <Text style={styles.ruleLineText}>{line}</Text>
          </View>
        ))}
        <View style={[modalButtonRowStyle, styles.ruleModalFooter]}>
          <ModalButton label="知道了" onPress={() => setRuleVisible(false)} />
        </View>
      </AppModal>
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
  // 标题行：标题 + 右侧玩法说明标识（仅揭棋模式；与残局闯关 headerTitleRow 同源）
  topTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  topTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.text,
  },
  // 模式选择：两个选项，与执棋/先后手同一套按钮语言
  modeSelector: {
    flexDirection: 'row',
    gap: 12,
  },
  modeButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: COLORS.bgCard,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  modeButtonActive: {
    backgroundColor: 'rgba(184, 134, 11, 0.1)',
    borderColor: COLORS.gold,
  },
  modeButtonText: {
    fontSize: FONT.control,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  modeButtonTextActive: {
    color: COLORS.primary,
  },
  // 玩法说明弹窗内容（与残局闯关 ruleModalBody / ruleLineRow 同源）
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
  ruleModalFooter: {
    marginTop: 4,
  },
  footnote: {
    marginTop: 16,
    fontSize: FONT.caption,
    lineHeight: 18,
    color: COLORS.textMuted,
    opacity: 0.6,
    textAlign: 'center',
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
