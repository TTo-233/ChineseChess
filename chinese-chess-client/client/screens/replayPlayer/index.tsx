/**
 * 复盘播放页
 *
 * - 只读棋盘：按步数重建局面（初始局面 + 顺序应用着法，全部预计算，拖动即时切换）
 * - 棋盘下方可拖拉进度条（整体进度 = 棋局步数）
 * - 底部固定操作栏：菜单（翻转棋盘 / 返回列表）、上一步、下一步
 * - 顶部标题栏已于 2026-10 下线：对局标题 / 时间 / 结果芯片移到底部信息行
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import ChessBoard from '@/components/ChessBoard';
import GameBottomBar, {
  BOTTOM_BAR_HEIGHT,
  type GameBottomBarActionInput,
  type GameMenuItem,
} from '@/components/GameBottomBar';
import { createInitialState, applyHandicap, makeMove, type GameState } from '@/utils/chess/GameEngine';
import { RED_SIDE, BLACK_SIDE } from '@/utils/chess/types';
import { getReplay, type ReplayGame } from '@/utils/replayStorage';
import { useBoardLayoutBudget, capHostHeightToViewport } from '@/utils/chess/boardLayoutBudget';
import { boardAlignedRowStyle } from '@/utils/chess/boardContentWidth';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
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
// 窗口高度：用于把棋盘宿主实测高度封顶到视口内，打断宽屏纵向溢出的正反馈
const windowHeight = Dimensions.get('window').height;
// 与人机对战一致：棋盘与下方信息行的间距随屏宽自适应
const dynamicGap = Math.max(Math.round(screenWidth * 0.03), 8);
  // 底部信息行（对局标题 / 时间 / 结果芯片）在棋盘宿主之外、纵向流内的占位高度
  // （StyleSheet 里 infoRow height 28 + marginBottom 2）；实测值可用时以实测优先
  const REPLAY_INFO_FLOW_HEIGHT = 30;
  // 控制区（步数行 + 进度条）在棋盘宿主之外、纵向流内的占位高度
  // （progressRow ≈ 20 + slider 40 + 控件间间距）；实测值可用时以实测优先
  const REPLAY_CONTROLS_FLOW_HEIGHT = 64;

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
  // 安全区：Screen 已在内容之外施加，预算封顶时需据此扣减可用高度
  const insets = useSafeAreaInsets();
  // 当前棋盘样式：控制区宽度需按样式几何换算棋盘本体宽度（用户可在首页设置中切换样式）
  const boardStyle = useBoardStyle();

  const [replay, setReplay] = useState<ReplayGame | null | undefined>(undefined); // undefined=加载中
  const [step, setStep] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  // 棋盘可用纵向空间实测（空间不足时缩小棋盘，避免挤占底部信息行与固定底栏）
  const [boardAreaH, setBoardAreaH] = useState(0);
  // 底部信息行 + 控制区的实测总高（在棋盘宿主之外，以 belowHostHeight 参与预算封顶）
  const [bottomSectionH, setBottomSectionH] = useState(0);
  // 棋盘内容宿主顶边相对页面内容顶边的 Y（含顶部安全区）：预算封顶时用于推算可用高度
  const [boardAreaY, setBoardAreaY] = useState(0);

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

  // 棋盘高度预算 + 垂直定位留白（口径与对局页一致）：
  // 条件 1 —— 棋盘顶边上方无角标行，预留 0；
  // 条件 2 —— 内容（棋盘 + 控制区）在宿主内垂直居中；居中时上方预留不足则整体下移贴住预留区
  //           （把下方空白让给棋盘），棋盘取到预留允许的最大尺寸。
  // 上方流内占位 = 0（无角标行）。
  // hostHeight 经视口封顶：Screen 的 flexGrow 容器会让 flex:1 宿主按内容撑开，
  // 不封顶则「宿主变大 → 棋盘变大 → 内容更高」正反馈会让宽屏页面纵向溢出
  // （详见 capHostHeightToViewport 注释）。
  // 2026-10 第二轮改造：信息行 + 控制区 + 固定底栏全部移到 boardArea 之外（页面最底端），
  // 它们占的是宿主之外的高度，因此走 belowHostHeight 而不是 bottomFlowHeight。
  // 注意 belowHostHeight 不含 insets.bottom —— capHostHeightToViewport 已扣过 bottomInset。
  const { maxBoardHeight, paddingTop: boardPadTop } = useBoardLayoutBudget({
    hostHeight: capHostHeightToViewport(
      boardAreaH,
      windowHeight,
      boardAreaY,
      insets.top,
      insets.bottom,
      // 信息行 + 控制区实测总高 + 底栏主体高度 + 底栏上边距。
      // 注意不含 insets.bottom —— capHostHeightToViewport 已扣过 bottomInset。
      (bottomSectionH > 0 ? bottomSectionH : REPLAY_INFO_FLOW_HEIGHT + REPLAY_CONTROLS_FLOW_HEIGHT)
        + BOTTOM_BAR_HEIGHT + dynamicGap
    ),
    screenWidth,
    topFlowHeight: 0,
    bottomFlowHeight: 0,
  });

  // 控制区宽度：跟随棋盘本体宽度居中，宽屏下不再横贯整个屏幕
  const controlsWidthStyle = useMemo(
    () => boardAlignedRowStyle(screenWidth, boardStyle, maxBoardHeight ?? 0),
    [screenWidth, boardStyle, maxBoardHeight]
  );

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

  // 底部操作栏（与人机/在线对战共用 @/components/GameBottomBar，2026-10 第二轮改造）：
  // 菜单 / 上一步 / 下一步。「菜单」承接顶栏下线的返回与翻转，以及原有的控制区按钮。
  const replayBarActions: GameBottomBarActionInput[] = [
    { key: 'menu', icon: 'bars', label: '菜单' },
    {
      key: 'prev',
      icon: 'backward-step',
      label: '上一步',
      disabled: currentStep <= 0,
      badge: currentStep > 0 ? currentStep : null,
      onPress: () => setStep((s) => Math.max(0, s - 1)),
    },
    {
      key: 'next',
      icon: 'forward-step',
      label: '下一步',
      disabled: currentStep >= totalSteps,
      badge: totalSteps > 0 ? totalSteps - currentStep : null,
      onPress: goNext,
    },
  ];
  const replayMenuItems: GameMenuItem[] = [
    { key: 'flip', icon: 'arrows-rotate', label: '翻转棋盘', onPress: () => setIsFlipped((f) => !f) },
    { key: 'back', icon: 'door-open', label: '返回列表', onPress: () => router.back() },
  ];

  return (
    // 【2026-10】去掉 'bottom' 安全区：底部操作栏是主容器的最后一个子节点（固定通栏），
    // 自己用 insets.bottom 撑开内边距，避免 Screen 的底部安全区把透明黑底截断在半空。
    <Screen safeAreaEdges={['top', 'left', 'right']}>
      <View style={styles.container}>
        {/* 顶部标题栏已于 2026-10 下线：对局标题 + 时间 + 结果芯片移到底部信息行，
            返回与翻转棋盘移入「菜单」弹出列表。 */}
        {/* 棋盘（整体居中；控制区与底栏都已移出宿主，固定在页面最底端） */}
        <View
          style={styles.boardArea}
          onLayout={(e) => {
            setBoardAreaH(e.nativeEvent.layout.height);
            setBoardAreaY(e.nativeEvent.layout.y);
          }}
        >
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
                playerSide={replay.mySide}
                maxBoardHeight={maxBoardHeight}
              />
            </View>
          )}
        </View>

        {/* 底部信息行 + 控制区：整组包一层，onLayout 实测总高，
            在 capHostHeightToViewport 的 belowHostHeight 里扣减（棋盘宿主之外，
            高度随内容变化，实测比常量更准，也避免常量与样式脱节）。 */}
        <View
          style={styles.bottomSection}
          onLayout={(e) => {
            const sectionH = e.nativeEvent.layout.height;
            setBottomSectionH((prev) => (prev === sectionH ? prev : sectionH));
          }}
        >
        {/* 底部信息行：顶栏下线的对局标题 / 时间 / 结果芯片落位 */}
        <View style={[styles.infoRow, controlsWidthStyle]}>
          <Text style={styles.infoRowTitle} numberOfLines={1}>
            {replay ? `${replay.mode === 'pve' ? '人机对战' : '在线对局'} · ${replay.note}` : '复盘'}
          </Text>
          {!!replay && (
            <Text style={styles.infoRowTime}>{formatFullTime(replay.timestamp)}</Text>
          )}
          {!!replay && (
            <View style={styles.resultChip}>
              <Text style={[styles.resultChipText, { color: resultColor }]}>{resultLabel}</Text>
            </View>
          )}
        </View>

        {/* 控制区：进度条（步进按钮已移到底部操作栏） */}
        {!!replay && boardState && (
          <View style={[styles.controls, controlsWidthStyle, { marginTop: dynamicGap }]}>
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
          </View>
        )}
        </View>

        {/* 底部操作栏：固定通栏贴屏幕最底端。菜单 / 上一步 / 下一步 */}
        <GameBottomBar
          widthStyle={controlsWidthStyle}
          style={{ marginTop: dynamicGap }}
          bottomInset={insets.bottom}
          actions={replayBarActions}
          menuItems={replayMenuItems}
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
  // 顶栏已下线（原 topBar / topBarSide / topBarRight / backButtonInner / topBarCenter /
  // topBarTitle / topBarSubtitle 全部删除；标题与结果芯片移到底部信息行）
  // 底部信息行 + 控制区的包裹层：只做 onLayout 实测高度用，本身不参与排版约束
  bottomSection: {
    alignSelf: 'stretch',
  },
  // 底部信息行（顶栏下线的对局标题 / 时间 / 结果芯片落位）
  // 占位高度 28 + marginBottom 2 = REPLAY_INFO_FLOW_HEIGHT(30)，改样式需同步改常量。
  infoRow: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  infoRowTitle: {
    flexShrink: 1,
    fontSize: FONT.caption,
    fontWeight: '700',
    color: COLORS.text,
  },
  infoRowTime: {
    fontSize: FONT.micro,
    color: COLORS.textMuted,
  },
  resultChip: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.bgCard,
  },
  resultChipText: {
    fontSize: FONT.micro,
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
});
