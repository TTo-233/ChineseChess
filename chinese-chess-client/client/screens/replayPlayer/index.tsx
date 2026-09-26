/**
 * 复盘播放页
 *
 * - 只读棋盘：按步数重建局面（初始局面 + 顺序应用着法，全部预计算，拖动即时切换）
 * - 棋盘下方可拖拉进度条（整体进度 = 棋局步数）
 * - 进度条下方按钮：上一步 / 下一步 / 翻转
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import ChessBoard, { CapturedPiecesDrawer } from '@/components/ChessBoard';
import { createInitialState, applyHandicap, makeMove, type GameState } from '@/utils/chess/GameEngine';
import { RED_SIDE, BLACK_SIDE } from '@/utils/chess/types';
import { getReplay, type ReplayGame } from '@/utils/replayStorage';
import { useBoardLayoutBudget } from '@/utils/chess/capturedDrawerMetrics';
import { playSound, playJiangJunSound, preloadSounds, unloadAllSounds } from '@/utils/SoundManager';
import { FONT } from '@/utils/typography';

// 主题色 - 浅色复古系（与人机对战一致）
const COLORS = {
  primary: '#8B6914',
  gold: '#B8860B',
  bg: '#F5F0E8',
  bgCard: '#FFF8F0',
  text: '#3E2723',
  textMuted: '#8D6E63',
  border: '#D7CCC8',
  success: '#2E7D32',
  danger: '#C62828',
};

const screenWidth = Dimensions.get('window').width;
// 与人机对战一致：棋盘与下方控制区的间距随屏宽自适应
const dynamicGap = Math.max(Math.round(screenWidth * 0.03), 8);

/** 由初始局面 + 着法序列预计算每一步的完整局面（steps[0]=开局，steps[N]=终局） */
function buildSteps(replay: ReplayGame): GameState[] {
  const steps: GameState[] = [];
  let state = createInitialState(replay.firstMoveSide === 'red' ? RED_SIDE : BLACK_SIDE);
  // 在线对局可选让棋：从让子后的局面起摆，着法序列才能正确复现
  if (replay.handicap && replay.handicap.length > 0) {
    state = applyHandicap(state, replay.handicap);
  }
  steps.push(state);
  for (const m of replay.moves) {
    // makeMove 返回深拷贝后的新状态，不修改传入状态，链式应用安全
    state = makeMove(state, m.pieceId, m.toCol, m.toRow).newState;
    steps.push(state);
  }
  return steps;
}

function formatFullTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ReplayPlayerScreen() {
  const router = useSafeRouter();
  const params = useSafeSearchParams<{ id: string }>();

  const [replay, setReplay] = useState<ReplayGame | null | undefined>(undefined); // undefined=加载中
  const [step, setStep] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  // 被吃棋子明细抽屉展开的一侧（null=收起），抽屉渲染在顶部标题行正下方（与人机对战一致）
  const [capturedDrawerSide, setCapturedDrawerSide] = useState<'opponent' | 'mine' | null>(null);
  // 棋盘可用纵向空间实测（空间不足时缩小棋盘，避免挤占标题栏与进度条）
  const [boardAreaH, setBoardAreaH] = useState(0);
  const [controlsH, setControlsH] = useState(0);

  // 每次进入页面按 id 重新加载（列表页删除后返回时兜底）
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getReplay(params.id).then(game => {
        if (cancelled) return;
        setReplay(game ?? null);
        setStep(game ? game.moves.length : 0); // 默认停在终局
        setIsFlipped(game ? game.mySide === 'black' : false);
      });
      return () => {
        cancelled = true;
      };
    }, [params.id])
  );

  // 预计算所有步的局面（同一对局只算一次，拖动滑块纯索引切换）
  const steps = useMemo(() => (replay ? buildSteps(replay) : []), [replay]);
  const totalSteps = replay ? replay.moves.length : 0;
  const currentStep = Math.min(step, totalSteps);
  const boardState = steps[currentStep] ?? null;
  const currentLastMove =
    replay && currentStep > 0
      ? (() => {
          const m = replay.moves[currentStep - 1];
          return { fromCol: m.fromCol, fromRow: m.fromRow, toCol: m.toCol, toRow: m.toRow };
        })()
      : null;

  // 当前步被吃棋子统计（与对局页口径一致：capturedByRed=红方吃掉的黑方棋子）
  const { capturedByRed, capturedByBlack } = useMemo(() => {
    const byRed: number[] = [];
    const byBlack: number[] = [];
    if (boardState) {
      boardState.pieces.forEach(p => {
        if (!p.alive) {
          if (p.id < 16) byRed.push(p.id);
          else byBlack.push(p.id);
        }
      });
    }
    return { capturedByRed: byRed, capturedByBlack: byBlack };
  }, [boardState]);

  // 棋盘高度预算 + 垂直定位留白（二分求解，口径与抽屉真实尺寸一致）：
  // 条件 1 —— 棋盘顶边上方常驻预留「摘要条悬浮区(38) + 抽屉展开高度」（复盘页棋盘上方无角标行，
  //           stripOffset=0），无论抽屉是否点开都预留，保证展开时底边不压棋盘、不与摘要条重叠；
  // 条件 2 —— 内容（棋盘 + 控制区）在宿主内垂直居中；居中时上方预留不足则整体下移贴住预留区
  //           （把下方空白让给棋盘），棋盘取到预留允许的最大尺寸。
  // 上方流内占位 = 0（无角标行）；下方流内占位 = dynamicGap + 控制区。
  const { maxBoardHeight, paddingTop: boardPadTop } = useBoardLayoutBudget({
    hostHeight: boardAreaH,
    screenWidth,
    stripOffset: 0,
    topFlowHeight: 0,
    bottomFlowHeight: dynamicGap + controlsH,
  });

  // 只读棋盘：所有交互为空操作
  const noop = useCallback(() => undefined, []);

  // 预加载常用音效并预热音频模式（复盘"下一步"同样播放走子音效）；退出时释放
  useEffect(() => {
    preloadSounds();
    return () => { unloadAllSounds(); };
  }, []);

  // 下一步：前进一格并播放该步的走子音效（将军/吃子/走子）；滑块拖动与"上一步"不播音
  const goNext = () => {
    const next = Math.min(totalSteps, step + 1);
    if (next === step || !replay) return;
    const after = steps[next];
    const before = steps[step];
    if (after) {
      // 吃子判定：本步前后存活棋子数减少
      const aliveBefore = before ? before.pieces.reduce((n, p) => n + (p.alive ? 1 : 0), 0) : 0;
      const aliveAfter = after.pieces.reduce((n, p) => n + (p.alive ? 1 : 0), 0);
      if (after.isCheck) {
        playJiangJunSound();
      } else if (aliveBefore > aliveAfter) {
        playSound('eat');
      } else {
        playSound('go');
      }
    }
    setStep(next);
  };

  const resultLabel = !replay
    ? ''
    : !replay.winnerSide
      ? '和棋'
      : replay.winnerSide === replay.mySide
        ? '本方胜'
        : '本方负';
  const resultColor = !replay
    ? COLORS.textMuted
    : !replay.winnerSide
      ? COLORS.textMuted
      : replay.winnerSide === replay.mySide
        ? COLORS.success
        : COLORS.danger;

  return (
    <Screen>
      <View style={styles.container}>
        {/* 顶部标题栏（与人机对战一致） */}
        <View style={styles.topBar}>
          <View style={styles.topBarSide}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backButtonInner}>
              <FontAwesome6 name="chevron-left" size={20} color={COLORS.text} />
            </TouchableOpacity>
          </View>
          <View style={styles.topBarCenter}>
            <Text style={styles.topBarTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
              {replay ? `${replay.mode === 'pve' ? '人机对战' : '在线对局'} · ${replay.note}` : '复盘'}
            </Text>
            {!!replay && (
              <Text style={styles.topBarSubtitle}>{formatFullTime(replay.timestamp)}</Text>
            )}
          </View>
          <View style={[styles.topBarSide, styles.topBarRight]}>
            {!!replay && (
              <View style={styles.resultChip}>
                <Text style={[styles.resultChipText, { color: resultColor }]}>{resultLabel}</Text>
              </View>
            )}
          </View>
        </View>

        {/* 棋盘 + 控制区（整体居中，控制区紧跟棋盘） */}
        <View style={styles.boardArea} onLayout={e => setBoardAreaH(e.nativeEvent.layout.height)}>
          {/* 被吃棋子明细抽屉：点击摘要文字后自标题行向下展开（浮层，棋盘不动），与人机对战一致 */}
          {boardState && replay && (
            <CapturedPiecesDrawer
              side={capturedDrawerSide}
              gameState={boardState}
              playerSide={replay.mySide}
              maxBoardHeight={maxBoardHeight}
            />
          )}
          {replay === undefined ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color={COLORS.primary} />
            </View>
          ) : replay === null || !boardState ? (
            <View style={styles.loadingBox}>
              <FontAwesome6 name="circle-exclamation" size={36} color={COLORS.border} />
              <Text style={styles.missingText}>对局不存在或已被删除</Text>
              <TouchableOpacity style={styles.missingBackButton} onPress={() => router.back()}>
                <Text style={styles.missingBackText}>返回列表</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={[styles.boardContainer, { paddingTop: boardPadTop }]}>
              <ChessBoard
                gameState={boardState}
                selectedPieceId={null}
                validMoves={null}
                lastMove={currentLastMove}
                isFlipped={isFlipped}
                onPiecePress={noop}
                onEmptyPress={noop}
                aiThinking={false}
                capturedByRed={capturedByRed}
                capturedByBlack={capturedByBlack}
                playerSide={replay.mySide}
                maxBoardHeight={maxBoardHeight}
                onCapturedPress={(side) => setCapturedDrawerSide(prev => (prev === side ? null : side))}
              />

              {/* 控制区：进度条 + 步进按钮 */}
              <View
                style={[styles.controls, { width: screenWidth, marginTop: dynamicGap }]}
                onLayout={e => setControlsH(e.nativeEvent.layout.height)}
              >
                {/* 步数指示 */}
                <View style={styles.progressRow}>
                  <Text style={styles.progressText}>
                    第 {currentStep} / {totalSteps} 步
                  </Text>
                  <Text style={styles.progressHint}>
                    {currentStep === 0
                      ? '开局'
                      : currentStep === totalSteps
                        ? '终局'
                        : `第 ${Math.floor((currentStep - 1) / 2) + 1} 回合 · ${replay.moves[currentStep - 1].pieceId >= 16 ? '红方' : '黑方'}走棋`}
                  </Text>
                </View>

                {/* 可拖拉进度条：整体进度 = 棋局步数 */}
                <Slider
                  style={styles.slider}
                  minimumValue={0}
                  maximumValue={Math.max(totalSteps, 1)}
                  step={1}
                  value={currentStep}
                  onValueChange={setStep}
                  disabled={totalSteps === 0}
                  minimumTrackTintColor={COLORS.primary}
                  maximumTrackTintColor={COLORS.border}
                  thumbTintColor={COLORS.primary}
                />

                {/* 上一步 / 下一步 / 翻转（与人机对战按钮样式一致） */}
                <View style={styles.buttonRow}>
                  <TouchableOpacity
                    style={[styles.actionButton, currentStep <= 0 && styles.actionButtonDisabled]}
                    onPress={() => setStep(s => Math.max(0, s - 1))}
                    disabled={currentStep <= 0}
                  >
                    <FontAwesome6 name="backward-step" size={16} color={COLORS.text} />
                    <Text style={styles.actionButtonText}>上一步</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionButton, currentStep >= totalSteps && styles.actionButtonDisabled]}
                    onPress={goNext}
                    disabled={currentStep >= totalSteps}
                  >
                    <FontAwesome6 name="forward-step" size={16} color={COLORS.text} />
                    <Text style={styles.actionButtonText}>下一步</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => setIsFlipped(f => !f)}
                  >
                    <FontAwesome6 name="arrows-rotate" size={16} color={COLORS.text} />
                    <Text style={styles.actionButtonText}>翻转</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </View>
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
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.text,
  },
  topBarSubtitle: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  resultChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgCard,
  },
  resultChipText: {
    fontSize: FONT.caption,
    fontWeight: '700',
  },
  boardArea: {
    flex: 1,
  },
  loadingBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  missingText: {
    fontSize: FONT.body,
    color: COLORS.textMuted,
  },
  missingBackButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: COLORS.primary,
  },
  missingBackText: {
    fontSize: FONT.control,
    fontWeight: '600',
    color: '#FFF',
  },
  boardContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  controls: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  progressRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  progressText: {
    fontSize: FONT.body,
    fontWeight: '700',
    color: COLORS.text,
  },
  progressHint: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
  },
  slider: {
    width: '100%',
    height: 40,
  },
  buttonRow: {
    width: '100%',
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
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
  actionButtonDisabled: {
    opacity: 0.4,
  },
  actionButtonText: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.text,
  },
});
