/**
 * 人机对战游戏页面
 * 移植自原项目的 QiPanPage.xaml.cs
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/components/Screen';
import { AppDialog, GameNotice, type GameNoticeItem } from '@/components/Modal';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { useNavigation } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import ChessBoard, { CapturedPiecesDrawer } from '@/components/ChessBoard';
import JueShaOverlay from '@/components/JueShaOverlay';
import { useMoveEffect } from '@/hooks/useMoveEffect';
import { useGameBoardLayout } from '@/hooks/useGameBoardLayout';
import { usePendingAIMove } from '@/hooks/usePendingAIMove';
import {
  useNewGame,
  buildGameStateFromFen,
  buildInitialGameState,
  ENDGAME_HINT_LIMIT,
  ENDGAME_UNDO_LIMIT,
} from '@/hooks/useNewGame';
import { MOVE_EFFECT_DURATION_MS } from '@/components/MoveEffectOverlay';
import {
  getSelectableMoves,
  getValidMoves,
  isMoveKingSafe,
  makeMove,
  undoMove,
  getWinnerSideTag,
  type GameState,
} from '@/utils/chess/GameEngine';
import { getBestMoveAsync, precomputeHint, cancelHintPonder, recordHistoryHash, clearHistoryHash, computeZobristHash } from '@/utils/chess/AIEngine';
import { getHybridBestMove, getHybridHintMove, getOnlineAiStatus, isOnlineAiBusyRetrying, getOnlineAiInvalidReason, getOnlineAiLongGameNotice, subscribeOnlineAiStatus, type AISource, type HybridMoveResult, type OnlineAiStatus } from '@/utils/chess/aiDispatcher';
import { isMoveBanned, enumerateLegalMoves, getMoveBanReason, banReasonNotice } from '@/utils/chess/RuleEngine';
import { playSound, playJiangJunSound, unloadAllSounds, preloadSounds, preloadGameEndSounds } from '@/utils/SoundManager';
import { RED_SIDE, BLACK_SIDE } from '@/utils/chess/types';
import { saveGame, loadGame, deleteSave, type GameSave } from '@/utils/GameSave';
import { saveReplay } from '@/utils/replayStorage';
import { BUILTIN_ENDGAMES } from '@/utils/chess/endgames';
import {
  markLevelCompleted,
  markCustomCompleted,
  saveEndgameBattle,
  loadEndgameBattle,
  deleteEndgameBattle,
  type EndgameLaunchParams,
} from '@/utils/EndgameProgress';
import { FONT } from '@/utils/typography';

// 主题色 - 浅色复古系
const COLORS = {
  primary: '#8B6914',      // 古铜金
  accent: '#B22222',       // 朱砂红
  gold: '#B8860B',         // 暗金色
  bg: '#F5F0E8',           // 米黄/古纸色背景
  bgCard: '#FFF8F0',       // 暖白卡片
  text: '#3E2723',         // 深棕文字
  textMuted: '#8D6E63',    // 浅棕文字
  border: '#D7CCC8',       // 浅棕边框
  redPiece: '#B22222',
  blackPiece: '#2C2C2C',
};

type Difficulty = 'easy' | 'medium' | 'hard';

// 残局闯关每局限用次数由 @/hooks/useNewGame 统一导出（ENDGAME_HINT_LIMIT / ENDGAME_UNDO_LIMIT），
// 页面与重置逻辑共用同一份常量，避免「按钮禁用阈值」与「重置回的值」各写一遍。

export default function GameScreen() {
  const router = useSafeRouter();
  const params = useSafeSearchParams<{
    difficulty: Difficulty;
    playerSide: 'red' | 'black';
    firstMover?: 'player' | 'ai';
    continueGame?: boolean;
    endgame?: string;
  }>();

  // 残局闯关模式：参数经 JSON 传递（useMemo 避免每次渲染重复解析）
  const initialEndgame = useMemo<EndgameLaunchParams | null>(() => {
    if (!params.endgame) return null;
    try {
      return JSON.parse(params.endgame) as EndgameLaunchParams;
    } catch {
      return null;
    }
  }, [params.endgame]);
  // 当前挑战的残局（过关后切换"下一关"时原地更新，避免同路由导航的状态复用问题）
  const [currentEndgame, setCurrentEndgame] = useState<EndgameLaunchParams | null>(initialEndgame);
  const isEndgame = !!currentEndgame;

  // 残局闯关固定大师难度；人机对战按传入难度
  const difficulty: Difficulty = isEndgame ? 'hard' : ((params.difficulty || 'medium') as Difficulty);
  const shouldContinue = params.continueGame || false;
  const shouldContinueEndgame = initialEndgame?.continueBattle || false;

  // 执棋与先后手（翻转换边时动态交换）
  // 残局模式：玩家固定执红；先后手由 FEN 决定（默认红先，FEN 带 b 段时黑先即 AI 先走）
  const initialPlayerSide = isEndgame ? 'red' : (params.playerSide || 'red');
  const initialFirstMover: 'player' | 'ai' = isEndgame
    ? (currentEndgame!.fen.trim().split(/\s+/)[1] === 'b' ? 'ai' : 'player')
    : (params.firstMover || (initialPlayerSide === 'red' ? 'player' : 'ai'));

  const [currentPlayerSide, setCurrentPlayerSide] = useState<'red' | 'black'>(initialPlayerSide);
  const [currentFirstMover, setCurrentFirstMover] = useState<'player' | 'ai'>(initialFirstMover);

  // 派生：双方 SideTag 与开局走棋方
  const playerSideTag = currentPlayerSide === 'red' ? RED_SIDE : BLACK_SIDE;
  const aiSideTag = currentPlayerSide === 'red' ? BLACK_SIDE : RED_SIDE;
  const initialSideTag = currentFirstMover === 'player' ? playerSideTag : aiSideTag;
  const aiFirst = currentFirstMover === 'ai';

  // 游戏状态（开局局面的构建与 useNewGame 共用同一实现 buildGameStateFromFen /
  // buildInitialGameState：Zobrist 哈希与重复局面历史的初始化不能有两份写法）
  const [gameState, setGameState] = useState<GameState>(() =>
    initialEndgame ? buildGameStateFromFen(initialEndgame.fen) : buildInitialGameState(initialSideTag)
  );
  const [selectedPieceId, setSelectedPieceId] = useState<number | null>(null);
  const [validMoves, setValidMoves] = useState<boolean[][] | null>(null);
  const [lastMove, setLastMove] = useState<{
    fromCol: number; fromRow: number; toCol: number; toRow: number;
  } | null>(null);
  const [isFlipped, setIsFlipped] = useState(initialPlayerSide === 'black');
  const [aiThinking, setAiThinking] = useState(false);
  // AI 引擎来源指示：最近一步 AI 走棋的引擎（null=尚未走棋，默认按本地 AI 展示）
  const [aiSource, setAiSource] = useState<AISource | null>(null);
  // 皮卡鱼返回的搜索深度（仅在线时有值），用于角标展示"深度level"
  const [aiDepth, setAiDepth] = useState<number | null>(null);
  // 在线走法来源引擎：'book'=开局库（此时 depth 恒为 0，不应展示"深度0"）；'pikafish'=皮卡鱼搜索
  const [aiEngine, setAiEngine] = useState<string | null>(null);
  const [moveCount, setMoveCount] = useState(0);
  const [capturedRed, setCapturedRed] = useState(0);
  const [capturedBlack, setCapturedBlack] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [boardKey, setBoardKey] = useState(0);

  // 提示功能：最优解展示（橙色描边 + 橙色落点），长久显示，点击任意棋子/走子/悔棋/换边后消失
  const [hintMove, setHintMove] = useState<{ pieceId: number; toCol: number; toRow: number } | null>(null);
  const [hintLoading, setHintLoading] = useState(false);
  const hintReqRef = useRef(0); // 请求序号：局面变化后使未返回的提示计算失效

  // 清除提示（并使进行中的提示计算结果失效）
  const clearHint = useCallback(() => {
    hintReqRef.current += 1;
    setHintMove(null);
    setHintLoading(false);
  }, []);

  // 卸载时清理后台预计算
  useEffect(() => {
    return () => {
      cancelHintPonder();
    };
  }, []);

  // ===== AI 走子竞态防护（第 3 批抽到 @/hooks/usePendingAIMove）=====
  // 代数（generation）：任何会重置/改变局面的操作（重开、下一关、悔棋、翻转、
  // 返回、读档）都使代数自增；延时中或计算中的 AI 走子在落地前校验代数，
  // 代数已变则丢弃结果，避免旧局面的 AI 着法覆盖新状态（如"重开后 AI 又落一子
  // 把局面拉回旧棋"、"悔棋被延时中的 AI 着法顶掉"）。
  // 与旧实现不同：玩家分支（executeMove）现在**同样**过代数闸——它此前 await 音效
  // 却没有校验，"落子后立刻重开"会把旧局面写回去（CODE_AUDIT.md §8 表 #8）。
  const runAIMoveRef = useRef<(state: GameState) => void>(() => undefined);
  const {
    invalidatePendingAI,
    scheduleAIMove,
    beginMoveTicket,
    isTicketLive,
  } = usePendingAIMove({
    runAIMove: (state) => runAIMoveRef.current(state),
    onDiscard: () => setAiThinking(false),
  });

  // 安全区：Screen 已在内容之外施加，预算封顶时需据此扣减可用高度
  // （screenWidth / windowHeight / dynamicGap 改由 useGameBoardLayout 内的
  //  useWindowDimensions 提供，第 3 批顺带修掉转屏后不再重算的旧问题）
  const insets = useSafeAreaInsets();

  // 游戏结束状态（声明提前，handleFlip 需要引用）
  const [gameOverReason, setGameOverReason] = useState<string | null>(null);
  const [jueShaVisible, setJueShaVisible] = useState(false);

  // 复盘自动保存：已结算的人机对战（非残局）终局时保存到本地历史，每局仅保存一次
  const replaySavedRef = useRef(false);
  const savePveReplay = useCallback((finalState: GameState, playerWon: boolean) => {
    if (isEndgame || replaySavedRef.current) return;
    replaySavedRef.current = true;
    const winnerSide = playerWon ? currentPlayerSide : (currentPlayerSide === 'red' ? 'black' : 'red');
    const diffLabel = { easy: '入门', medium: '进阶', hard: '大师' }[difficulty] || difficulty;
    // 先手方由首着棋子归属确定（换边翻转后依然准确），无着法时兜底红先
    const firstMove = finalState.moveHistory[0];
    const firstMoveSide = firstMove ? (firstMove.pieceId >= 16 ? 'red' : 'black') : 'red';
    saveReplay({
      timestamp: Date.now(),
      mode: 'pve',
      moveCount: finalState.moveHistory.length,
      moves: finalState.moveHistory,
      firstMoveSide,
      winnerSide,
      mySide: currentPlayerSide,
      note: `难度·${diffLabel}`,
    }).catch(() => undefined);
  }, [isEndgame, currentPlayerSide, difficulty]);
  // 残局闯关：本局结局（win=玩家过关 / lose=被将死或棋差 / draw=未能在限招内取胜），
  // 用于结算按钮与文案区分。draw 必须与 lose 区分：自然限招/无进攻子力/重复局面
  // 判和都不是「闯关成功」，也不能当成「挑战失败，再接再厉」的战败提示。
  const endgameResultRef = useRef<'win' | 'lose' | 'draw' | null>(null);
  // 吃子/将军特效（含连续将军节流策略）
  const { moveEffect, triggerMoveEffect } = useMoveEffect();

  // 计算被吃掉的棋子
  //
  // 【P4】改为 useMemo：原来是每次渲染都重新遍历 32 个棋子并新建两个数组，
  // 但 gameState.pieces 这个数组只在局面变化时才换引用，所以只要依赖不变
  // 拿到的就是同一份结果——没有任何理由在每次渲染时重算。
  const { capturedByRed, capturedByBlack } = useMemo(() => {
    const byRed: number[] = []; // 红方吃掉的（黑方棋子）
    const byBlack: number[] = []; // 黑方吃掉的（红方棋子）

    gameState.pieces.forEach(piece => {
      if (!piece.alive) {
        // 棋子ID 0-15 是黑方，16-31 是红方
        if (piece.id < 16) {
          byRed.push(piece.id); // 黑方棋子被红方吃掉
        } else {
          byBlack.push(piece.id); // 红方棋子被黑方吃掉
        }
      }
    });

    return { capturedByRed: byRed, capturedByBlack: byBlack };
  }, [gameState.pieces]);

  // 加载存档；并在进入对局时预加载常用音效、预热音频模式
  // （预加载会为每条音轨做一次静音预热，消除首步音效的按需加载延迟与
  //   音轨首次入混的竞态；成因与对策详见 utils/SoundManager 头注释）
  useEffect(() => {
    preloadSounds();
    preloadGameEndSounds();
    if (shouldContinueEndgame && initialEndgame && !loaded) {
      // 残局闯关：继续挑战（恢复局内存档）
      loadEndgameBattle().then((save) => {
        if (save && save.levelIndex === initialEndgame.levelIndex && save.customId === initialEndgame.customId) {
          save.gameState.zobristHash = computeZobristHash(save.gameState);
          clearHistoryHash();
          recordHistoryHash(save.gameState);
          setGameState(save.gameState);
          setMoveCount(save.moveCount);
          setCapturedRed(save.capturedRed);
          setCapturedBlack(save.capturedBlack);
          setLastMove(save.lastMove);
          setEndgameHintLeft(ENDGAME_HINT_LIMIT); // 恢复残局存档时重置提示次数
          setEndgameUndoLeft(ENDGAME_UNDO_LIMIT); // 同时重置悔棋次数
        }
        setLoaded(true);
        setBoardKey(k => k + 1); // 强制 ChessBoard 重新挂载
      });
    } else if (shouldContinue && !loaded) {
      loadGame().then((save) => {
        if (save) {
          // 重建 Zobrist 哈希（加载存档时）
          save.gameState.zobristHash = computeZobristHash(save.gameState);
          clearHistoryHash();
          recordHistoryHash(save.gameState);
          setGameState(save.gameState);
          setMoveCount(save.moveCount);
          setCapturedRed(save.capturedRed);
          setCapturedBlack(save.capturedBlack);
          setLastMove(save.lastMove);
          setIsFlipped(save.isFlipped);
        }
        setLoaded(true);
        setBoardKey(k => k + 1); // 强制 ChessBoard 重新挂载
      });
    } else {
      setLoaded(true);
    }
    // 退出对局时释放全部音效资源（原生播放器与音频会话），
    // 避免已加载音效被系统媒体会话持续识别为“无声播放中”
    return () => { unloadAllSounds(); };
  }, []);

  // 弹窗状态
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);
  const [showBackConfirm, setShowBackConfirm] = useState(false);
  // 残局"说明"弹窗（不使用全局 alert —— 其在 Release 构建中不可用，调用会导致卡死）
  const [endgameInfoVisible, setEndgameInfoVisible] = useState(false);
  // 残局闯关：每局限 3 次提示 + 10 次悔棋，用完按钮禁用（重开/下一关/恢复存档时重置）
  // 上限常量由 @/hooks/useNewGame 统一导出，重置回的值与按钮禁用阈值共用同一份。
  const [endgameHintLeft, setEndgameHintLeft] = useState(ENDGAME_HINT_LIMIT);
  const [endgameUndoLeft, setEndgameUndoLeft] = useState(ENDGAME_UNDO_LIMIT);

  // ===== 开新局的统一重置（第 3 批抽到 @/hooks/useNewGame）=====
  // 「确认重开 / 再来一局 / 残局下一关」三条路径此前各抄了一份 15 行重置序列；
  // 这里给出全部 setter，重置序列由 Hook 单一实现承担（差异改用显式选项表达）。
  const { startNewGame } = useNewGame({
    endgameResultRef,
    replaySavedRef,
    invalidatePendingAI,
    scheduleAIMove,
    clearHint,
    setGameState,
    setSelectedPieceId,
    setValidMoves,
    setLastMove,
    setMoveCount,
    setCapturedRed,
    setCapturedBlack,
    setIsFlipped,
    setJueShaVisible,
    setGameOverReason,
    setEndgameHintLeft,
    setEndgameUndoLeft,
    setBoardKey,
  });
  // 被吃棋子明细抽屉展开的一侧（null=收起），抽屉渲染在顶部标题行正下方
  const [capturedDrawerSide, setCapturedDrawerSide] = useState<'opponent' | 'mine' | null>(null);
  // 棋盘可用纵向空间实测（宽屏/纵向空间不足时限制棋盘尺寸，避免挤占标题行与底部操作栏）
  const [boardAreaH, setBoardAreaH] = useState(0);
  const [bottomBarH, setBottomBarH] = useState(0);
  // 棋盘内容宿主顶边相对页面内容顶边的 Y（含顶部栏与顶部安全区）：预算封顶时用于推算可用高度
  const [drawerHostY, setDrawerHostY] = useState(0);

  // 长将长捉/判和规则提示（阈值前一步的一次性预警，【提示口径 2026-10】）：
  // 与联机对战一致，统一用覆盖在棋盘中央的 GameNotice 横幅
  // （centerY 的换算依赖下方 jueshaBoardFrame，故放在它之后）
  const [ruleNotice, setRuleNotice] = useState<GameNoticeItem | null>(null);
  // key 用「文案本身」而非自增序号：规则引擎的 noticeKey 是稳定的预警标识，
  // 同一类预警在走子方交替时内容不变。自增序号会让每一步都当成新提示重新计时，
  // 于是提示条常驻刷屏——这正是「过于频繁」的根因。语义不同的提示（「着法送将，
  // 请另走」vs「长将已 5 着…」）文案必然不同，仍会各自重新计时。
  const showRuleNotice = useCallback((text: string) => {
    setRuleNotice((prev) => (prev?.text === text ? prev : { key: `rule-${text}`, text }));
  }, []);
  const hideRuleNotice = useCallback(() => setRuleNotice(null), []);

  // ===== 棋盘几何与纵向预算（第 3 批抽到 @/hooks/useGameBoardLayout）=====
  // 宿主实测 → 视口封顶 → 纵向预算二分 → 棋盘尺寸 → 对齐行宽 → 绝杀特效框 → 提示条中心，
  // 这条依赖链整体搬进了 Hook；页面只按名字消费结果，不再自己串每一环。
  const {
    maxBoardHeight,
    boardPadTop,
    alignedRowStyle,
    jueshaBoardFrame,
    ruleNoticeCenterY,
    // 【P4】不取 boardSize：它在本页从未被读取（只有 onBoardLayout 需要 setBoardSize）。
    // 但解构出来不等于没用——boardSize 变化会触发本页重渲染，
    // 而这个值对渲染结果没有任何影响，属于白白多渲染一次。已从解构里移除。
    setBoardSize,
    screenWidth,
    windowHeight,
    dynamicGap,
    measureBoardFrame,
    containerRef,
    boardRef,
  } = useGameBoardLayout({
    boardAreaH,
    bottomBarH,
    drawerHostY,
    insetsTop: insets.top,
    insetsBottom: insets.bottom,
    jueshaVisible: jueShaVisible,
  });

  // 【P4】稳定化传给 ChessBoard 的 onBoardLayout：setBoardSize 本身已是 React 稳定的
  // state setter，这里再包一层 useCallback 只是为了把意图写明——这个回调会驱动
  // 父级（useGameBoardLayout 内部）setState，进而触发整页重渲染。
  const stableSetBoardSize = useCallback(setBoardSize, [setBoardSize]);

  // 在线 AI 状态订阅：熔断/恢复/服务端繁忙/走法被拒都会主动广播，
  // 这里把它转成 state 触发重渲染——否则角标只能等下一次走子才刷新，
  // 会出现"熔断了但界面毫无变化、一直本地 AI 且看不到任何提示"的死角。
  const [onlineAiStatusState, setOnlineAiStatusState] = useState<OnlineAiStatus>(() => getOnlineAiStatus());
  const [onlineAiStatusTick, setOnlineAiStatusTick] = useState(0);
  useEffect(() => {
    const unsubscribe = subscribeOnlineAiStatus((status) => {
      setOnlineAiStatusState(status);
      // busy / invalid_move / longGameNotice 不在 status 枚举里，用 tick 强制刷新
      setOnlineAiStatusTick((n) => n + 1);
    });
    return unsubscribe;
  }, []);

  // 动画
  const shakeAnim = useRef(new Animated.Value(0)).current;

  // 开局或载入存档后：若当前轮到 AI，自动触发 AI 走棋；
  // 若轮到玩家，后台预计算提示（玩家思考期间完成，点击"提示"即时命中）
  useEffect(() => {
    if (!loaded) return;
    if (gameState.gameStatus === 'playing' && gameState.sideTag === aiSideTag) {
      // 延迟确保组件完全挂载后再触发 AI 走棋
      const timer = setTimeout(() => {
        triggerAIMove(gameState);
      }, 300);
      return () => clearTimeout(timer);
    }
    if (gameState.gameStatus === 'playing' && gameState.sideTag === playerSideTag) {
      precomputeHint(gameState); // 残局闯关提示同样后台预计算，点击"提示"即时命中
    }
  }, [loaded]);

  // 拦截系统返回（Android 侧滑手势/返回键），与界面返回按钮一致弹出保存确认。
  // beforeRemove 在 React Navigation 的返回动作（含系统返回）前触发，可阻止并改为弹窗确认。
  const navigation = useNavigation();
  // 确认弹窗中点击"保存/不保存"后放行，避免被拦截器再次拦下
  const allowLeaveRef = useRef(false);

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e: { preventDefault: () => void }) => {
      if (allowLeaveRef.current) return;
      // 对局未在进行或尚无着法：没有可保存内容，直接放行
      if (gameState.gameStatus !== 'playing' || gameState.moveHistory.length === 0) return;
      e.preventDefault();
      setShowBackConfirm(true);
    });
    return unsubscribe;
  }, [navigation, gameState.gameStatus, gameState.moveHistory.length]);

  // 触发 AI 走棋
  const triggerAIMove = useCallback(async (currentState: GameState) => {
    if (currentState.gameStatus !== 'playing') return;

    // 开一张代数票据：计算期间若发生重开/悔棋/翻转等重置，本次结果作废
    const ticket = beginMoveTicket();
    setAiThinking(true);

    try {
      // 残局闯关：为保证预置残局可行，AI 走子固定使用本地大师难度 AI（不联网皮卡鱼），
      // 仅用户"提示"走皮卡鱼；人机对战：混合 AI（联网优先皮卡鱼，弱网/离线回退本地）。
      let aiMove: HybridMoveResult | null;
      if (isEndgame) {
        const offline = await getBestMoveAsync(currentState, difficulty);
        aiMove = offline ? { ...offline, source: 'offline' } : null;
      } else {
        aiMove = await getHybridBestMove(currentState, difficulty);
      }

      // 计算返回时局面已被重置（重开/悔棋/翻转/退出）→ 丢弃结果
      if (!isTicketLive(ticket)) return;

      if (aiMove) {
        setAiSource(aiMove.source);
        setAiDepth(aiMove.depth ?? null);
        setAiEngine(aiMove.engine ?? null);

        // 长将长捉超限时的 AI 择优（方案 10 娱乐向改造）：落子本身不再被拦截，
        // 但 AI 仍优先选择「变招」着法（搜索根节点已过滤超限着、云端着法经调度器
        // 守卫过滤），此处为最后兜底——AI 不会主动去送长将/长捉僵局。
        if (isMoveBanned(currentState, aiMove.pieceId, aiMove.toCol, aiMove.toRow)) {
          const alternatives = enumerateLegalMoves(currentState, currentState.sideTag)
            .filter(m => !isMoveBanned(currentState, m.pieceId, m.toCol, m.toRow));
          if (alternatives.length > 0) {
            aiMove = { ...aiMove, ...alternatives[0] };
          }
        }

        const { newState, captured, isCheck, isGameOver, gameOverReason } = makeMove(
          currentState,
          aiMove.pieceId,
          aiMove.toCol,
          aiMove.toRow
        );

        // 规则提示（AI 走子触发，如"长将已 N 着，下着将超限"等待玩家应对的场景）
        if (newState.ruleState?.notice) {
          showRuleNotice(newState.ruleState.notice);
        }

        // 更新 Zobrist 哈希（AI 走棋后）
        newState.zobristHash = computeZobristHash(newState);
        recordHistoryHash(newState);

        // 播放音效：将军时播放男声将军语音（替代走子音，避免与吃子/走子音混音重叠）
        //
        // 【P3】不再 await：音效与状态更新无因果依赖，fire-and-forget 即可。
        // playSound 内部按音效名串行化，不会互相打断，也不阻塞界面更新。
        // 真机曾出现的「首个走子/吃子音无声」是「这条音轨这一遍没有被混音器消费」
        // 的播放期竞态，已在 SoundManager 内用「静音预热 + 播放头进度自检重发」处理
        // （详见该文件头注释），与是否 await 无关。
        if (isCheck && !isGameOver) {
          void playJiangJunSound();
        } else if (captured !== -1) {
          void playSound('eat');
        } else {
          void playSound('go');
        }

        // 吃子/将军特效（终局时不播，由绝杀特效接管）
        triggerMoveEffect(captured, isCheck, isGameOver);

        if (isGameOver) {
          // AI 走棋终局不一定 AI 胜（长将判负、不变作和）→ 按引擎真实裁决播放音效
          const isDraw = newState.gameStatus === 'draw';
          const aiWonNow = !isDraw && getWinnerSideTag(newState) === aiSideTag;
          if (!isDraw) {
            // AI 胜=玩家败（gamelose）；AI 被判负=玩家胜（gamewin）；和棋不播胜负音效
            void playSound(aiWonNow ? 'gamelose' : 'gamewin');
          }
        }

        // 落地前校验局面仍然有效（玩家中途重开/悔棋等）
        if (!isTicketLive(ticket)) return;

        setGameState(newState);
        setLastMove({
          fromCol: aiMove.fromCol,
          fromRow: aiMove.fromRow,
          toCol: aiMove.toCol,
          toRow: aiMove.toRow,
        });
        setMoveCount(prev => prev + 1);

        if (captured !== -1) {
          if (captured <= 15) {
            setCapturedRed(prev => prev + 1);
          } else {
            setCapturedBlack(prev => prev + 1);
          }
        }

        if (isGameOver) {
          // 所有对局结束原因均播放绝杀特效，特效持续显示（含按钮）
          setGameOverReason(gameOverReason);
          setJueShaVisible(true);
          // AI 走棋终局不一定 AI 胜（AI 长将未变招时判 AI 负）→ 引擎判定真实胜方
          const isDraw = newState.gameStatus === 'draw';
          // 和棋必须先于胜负判定：getWinnerSideTag 对和棋返回 null，
          // 若不先拦下，aiWon 恒为 false 会被误记成「玩家过关」。
          const aiWon = !isDraw && getWinnerSideTag(newState) === aiSideTag;
          if (isEndgame) {
            // AI 被判负（玩家守和成功）才算闯关成功；和棋与玩家战败都算失败。
            // 注意：只有真正 win 才写通关记录，draw 绝不能调 markLevelCompleted。
            endgameResultRef.current = isDraw ? 'draw' : aiWon ? 'lose' : 'win';
            if (!isDraw && !aiWon && currentEndgame) {
              // AI 被判负等同玩家过关：同样记录通关与评级（本路径玩家未消耗提示）
              if (currentEndgame.levelIndex >= 0) {
                markLevelCompleted(currentEndgame.levelIndex, ENDGAME_HINT_LIMIT - endgameHintLeft);
              } else if (currentEndgame.customId) {
                markCustomCompleted(currentEndgame.customId, ENDGAME_HINT_LIMIT - endgameHintLeft);
              }
            }
            deleteEndgameBattle(); // 残局终局：清除残局局内存档（不动人机存档）
          } else {
            deleteSave(); // 人机对战终局：仅清人机枪局存档
            savePveReplay(newState, !aiWon); // 按真实胜负保存复盘
          }
        } else {
          // AI 走棋完成，轮到玩家：后台预计算提示（搜索核心与预算不变，质量无损）
          precomputeHint(newState);
        }
      }
    } catch (error) {
      console.error('AI 走棋失败:', error);
    } finally {
      // 仅当本次计算未被重置操作作废时才复位思考标记，
      // 避免旧流程的 finally 覆盖新流程（如重开后排定的新 AI 走子）的 aiThinking
      if (isTicketLive(ticket)) setAiThinking(false);
    }
  }, [difficulty, triggerMoveEffect, savePveReplay, isEndgame, aiSideTag, currentEndgame, endgameHintLeft, showRuleNotice, beginMoveTicket, isTicketLive]);

  // triggerAIMove 的最新引用转交排定器：排定器是稳定引用，读 ref 才能避免
  // 「每次 triggerAIMove 重建都让所有排定失效」的死循环式重排定。
  runAIMoveRef.current = triggerAIMove;

  // 点击棋子
  const handlePiecePress = useCallback((pieceId: number) => {
    clearHint(); // 点击任意棋子，提示立即消失
    // 玩家一旦伸手就立刻放弃后台提示预计算：AI 走子后 250ms 启动的那次 ponder 正好
    // 落在玩家准备落子的窗口里，如果让它继续跑，点击会被主线程搜索顶住（"动画结束后
    // 仍有一段时间点不动"的主因）。中止是协作式的，最迟一个分片（约 12ms）内真正停下。
    cancelHintPonder();
    if (aiThinking || gameState.gameStatus !== 'playing') return;

    const piece = gameState.pieces[pieceId];
    if (!piece.alive) return;

    const pieceSide = pieceId <= 15 ? BLACK_SIDE : RED_SIDE;
    const currentSide = gameState.sideTag;

    // 如果点击的是己方棋子，选中它
    if (pieceSide === currentSide) {
      // 检查是否是玩家的棋子
      const isPlayerPiece = (currentPlayerSide === 'red' && pieceSide === RED_SIDE) ||
                           (currentPlayerSide === 'black' && pieceSide === BLACK_SIDE);

      if (!isPlayerPiece) return;

      setSelectedPieceId(pieceId);
      // 落点提示仅按棋子自身走法判定（不因被将军而只剩应将点，避免变相提示）
      const moves = getSelectableMoves(gameState, pieceId);
      setValidMoves(moves);
      return;    }

    // 如果点击的是对方棋子，且已选中己方棋子，尝试吃子
    if (selectedPieceId !== null && validMoves) {
      const canMove = validMoves[piece.col][piece.row];
      if (canMove) {
        executeMove(selectedPieceId, piece.col, piece.row);
      } else {
        // 抖动动画
        Animated.sequence([
          Animated.timing(shakeAnim, { toValue: 5, duration: 50, useNativeDriver: true }),
          Animated.timing(shakeAnim, { toValue: -5, duration: 50, useNativeDriver: true }),
          Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
        ]).start();
      }
    }
  }, [gameState, selectedPieceId, validMoves, aiThinking, currentPlayerSide, clearHint]);

  // 点击空位
  const handleEmptyPress = useCallback((col: number, row: number) => {
    if (aiThinking || gameState.gameStatus !== 'playing') return;

    if (selectedPieceId !== null && validMoves) {
      const canMove = validMoves[col][row];
      if (canMove) {
        executeMove(selectedPieceId, col, row);
      } else {
        // 取消选择
        setSelectedPieceId(null);
        setValidMoves(null);
      }
    }
  }, [gameState, selectedPieceId, validMoves, aiThinking]);

  // 执行走棋
  const executeMove = useCallback(async (pieceId: number, toCol: number, toRow: number) => {
    // 开一张代数票据：与 AI 分支同一道闸，落地前（音效 await 之后）统一校验
    const ticket = beginMoveTicket();
    // 兜底校验：落点必须在该棋子的走法规则内（仅棋子自身走法，不含王安全过滤）。
    // 即使界面落点状态过期，也杜绝任何不合规则的落子
    const legalMoves = getValidMoves(gameState, pieceId);
    if (!legalMoves[toCol]?.[toRow]) {
      setSelectedPieceId(null);
      setValidMoves(null);
      return;
    }

    // 送将拦截（2026-09 线上事故修复）：落点判定仍按 4ccdae5 的口径给出全部走点
    // （被将军时不只剩应将点，避免"变相提示"），但**真的要点下去**时，若这步走后
    // 己方将/帅仍会被攻击（含将帅照面/白脸将），则拦下这一步并说明原因。
    //
    // 为什么不能指望"送将后对方一步终局"：服务端 Pikafish 是标准象棋引擎，
    // 其合法着法生成**不含吃将**——对方将/帅摆在可吃位置它也不会去吃（实测 5/5），
    // 于是对局会停在「正被将军却无人应招」的非法局面里，绝杀/困毙都不会触发。
    // 判据复用 MoveCheck.afterMoveStillJiangJun，与 hasAnyLegalMove / isJueSha /
    // isKunBi / AIEngine.isSideInCheck 完全同口径，保证盘上不会出现"该方被将且轮到该方"。
    //
    // 注意这里**故意不清 selectedPieceId/validMoves**：被拦下的只是这一个落点，
    // 该子的其他落点和换子重选都还合法。清掉选中等于让用户重走一遍"点棋子→点落点"，
    // 保留选中则直接改点另一个落点即可（提示条给了原因，落点表本来就是全量显示）。
    if (!isMoveKingSafe(gameState, pieceId, toCol, toRow)) {
      showRuleNotice('着法送将，请另走');
      return;
    }

    // 长将长捉超限禁着（规则二）：一方达到阈值后，再走会继续长将/长捉的着法
    // 预超过阈值，该落点被禁——拦下落子并按理由提示「禁止长将/长捉，请变招」。
    // 拦的是超限着法本身，变招（不继续长将/长捉的落点）始终合法。
    //
    // 与送将拦截一致：**不清选中态**，被拦的只是这一个落点，该子的其他落点和换子
    // 重选都还合法，玩家直接改点另一个落点即可。
    //
    // AI 侧另有同一道过滤（AIEngine.ts / aiDispatcher.ts 读 isMoveBanned），
    // 因此这里拦的是人的落子，不会出现「AI 走禁着」的不一致局面。
    const banReason = getMoveBanReason(gameState, pieceId, toCol, toRow);
    if (banReason) {
      showRuleNotice(banReasonNotice(banReason));
      return;
    }

    clearHint(); // 走子后提示失效
    cancelHintPonder(); // 玩家走棋：立即中止后台提示预计算，算力让给 AI 思考
    const { newState, captured, isCheck, isGameOver, gameOverReason } = makeMove(
      gameState, pieceId, toCol, toRow
    );

    // 规则提示（接近阈值"请尽快变招"等，方案 10.3 / 12）
    if (newState.ruleState?.notice) {
      showRuleNotice(newState.ruleState.notice);
    }

    // 更新 Zobrist 哈希（玩家走棋后）
    newState.zobristHash = computeZobristHash(newState);
    recordHistoryHash(newState);

    // 播放音效：将军时播放男声将军语音（替代走子音，避免与吃子/走子音混音重叠）
    //
    // 【P3】不再 await：见 AI 分支同处说明。音效与状态落地无因果依赖。
    // playSound 内部按音效名串行化并做静音预热/播放头进度自检，
    // fire-and-forget 不会导致音效互相打断。
    if (isCheck && !isGameOver) {
      void playJiangJunSound();
    } else if (captured !== -1) {
      void playSound('eat');
    } else {
      void playSound('go');
    }

    // 【第 3 批 / §8 表 #8】与 AI 分支同口径的代数闸：音效 await 期间玩家可能已
    // 重开/悔棋/翻转/退出（音效播放不是瞬时的），此时不能再把这步落回界面——
    // 否则「落子后立刻点重开」会被旧 newState 覆盖回去，重开形同虚设。
    if (!isTicketLive(ticket)) return;

    // 吃子/将军特效（终局时不播，由绝杀特效接管）；返回实际播放的特效类型
    const shownEffect = triggerMoveEffect(captured, isCheck, isGameOver);

    setGameState(newState);
    setLastMove({
      fromCol: gameState.pieces[pieceId].col,
      fromRow: gameState.pieces[pieceId].row,
      toCol,
      toRow,
    });
    setSelectedPieceId(null);
    setValidMoves(null);
    setMoveCount(prev => prev + 1);

    if (captured !== -1) {
      if (captured <= 15) {
        setCapturedRed(prev => prev + 1);
      } else {
        setCapturedBlack(prev => prev + 1);
      }
    }

    if (isGameOver) {
      // 所有对局结束原因均播放绝杀特效，特效持续显示（含按钮）
      setGameOverReason(gameOverReason);
      setJueShaVisible(true);
      // 走棋方不一定获胜（二将一还时长将方判负、不变作和）→ 统一由引擎判定胜方
      const isDraw = newState.gameStatus === 'draw';
      const playerWon = !isDraw && getWinnerSideTag(newState) === playerSideTag;
      if (isEndgame && currentEndgame) {
        if (playerWon) {
          // 残局闯关：玩家获胜 → 标记过关并解锁下一关，仅清除残局局内存档（不动人机存档）
          // 同时记录本局使用的提示次数（取历史最佳），用于选关页金/银/铜冠评级；
          // 悔棋次数不参与评级（仅统计提示），故此处只取提示消耗量
          endgameResultRef.current = 'win';
          deleteEndgameBattle();
          if (currentEndgame.levelIndex >= 0) {
            markLevelCompleted(currentEndgame.levelIndex, ENDGAME_HINT_LIMIT - endgameHintLeft);
          } else if (currentEndgame.customId) {
            // 自定义残局：同样按提示次数记录金/银/铜冠评级
            markCustomCompleted(currentEndgame.customId, ENDGAME_HINT_LIMIT - endgameHintLeft);
          }
        } else if (isDraw) {
          // 残局闯关：和棋（自然限招/无进攻子力/重复局面）＝ 未能按时取胜，不是战败
          endgameResultRef.current = 'draw';
          deleteEndgameBattle();
        } else {
          // 残局闯关：玩家走棋被判负（如长将未变招）→ 挑战失败
          endgameResultRef.current = 'lose';
          deleteEndgameBattle();
        }
      } else {
        deleteSave(); // 人机对战终局：仅清人机枪局存档
        savePveReplay(newState, playerWon); // 玩家走棋终局：按真实胜负保存复盘
      }
      // 按真实胜负播放结算音效（和棋不播胜负音效）
      // 【P3】同样 fire-and-forget：结算界面（胜/负/续局）此时已经渲染完成，
      // 再等音频链路只是让"再来一局"按钮晚 ~半秒可点。
      if (!isDraw) {
        void playSound(playerWon ? 'gamewin' : 'gamelose');
      }
      return;
    }

    // AI 走棋：若玩家这步触发了特效，等特效完整播完再让 AI 落子，
    // 避免 AI 秒回导致特效被下一步棋的特效/棋盘变化打断；无特效时保持 300ms 的轻思考停顿
    const aiDelay = shownEffect ? MOVE_EFFECT_DURATION_MS[shownEffect] + 120 : 300;
    scheduleAIMove(newState, aiDelay);
  }, [gameState, clearHint, isEndgame, currentEndgame, endgameHintLeft, triggerMoveEffect, savePveReplay, playerSideTag, scheduleAIMove, showRuleNotice, beginMoveTicket, isTicketLive]);

  // 悔棋（人机对战不限次数；残局闯关每局限 ENDGAME_UNDO_LIMIT 次，且不计入金/银/铜冠评定）
  const handleUndo = useCallback(() => {
    if (aiThinking) return;
    // 残局闯关：悔棋额度用尽后不再提供（按钮同步禁用，双保险）
    if (isEndgame && endgameUndoLeft <= 0) return;
    invalidatePendingAI(); // 取消延时中/计算中的 AI 走子，防止旧走子覆盖悔棋后的局面

    if (gameState.moveHistory.length < 2) return;

    clearHint(); // 悔棋后提示失效
    // 悔两步（玩家 + AI）
    let state = gameState;
    state = undoMove(state)!;
    state = undoMove(state)!;
    // 边界：在 AI 延时窗口内悔棋时，悔两步后可能仍轮到 AI（最后一步是玩家刚走的）→
    // 继续悔至玩家回合，避免局面停在 AI 回合却无 AI 走子触发的软锁
    while (state.sideTag !== playerSideTag && state.gameStatus === 'playing' && state.moveHistory.length > 0) {
      state = undoMove(state)!;
    }
    const undone = gameState.moveHistory.length - state.moveHistory.length;

    // 残局闯关：成功悔棋才消耗一次额度（无历史可悔时已提前返回，不扣次）；
    // 评级只看提示次数，此处扣减悔棋额度不影响金/银/铜冠判定
    if (isEndgame) setEndgameUndoLeft(prev => Math.max(0, prev - 1));

    setGameState(state);
    setSelectedPieceId(null);
    setValidMoves(null);
    setMoveCount(prev => Math.max(0, prev - undone));
    setLastMove(null);
    if (state.sideTag === playerSideTag) {
      // 悔棋后轮到玩家：后台预计算提示（内部会先取消旧局面的预计算）
      precomputeHint(state);
    } else {
      // 空盘且 AI 先手：让 AI 重新走开局第一步
      scheduleAIMove(state, 500);
    }
  }, [gameState, aiThinking, clearHint, playerSideTag, invalidatePendingAI, scheduleAIMove, isEndgame, endgameUndoLeft]);

  // 换边翻转（交换执棋方 + 先后手 + 棋盘方向）
  const handleFlip = useCallback(() => {
    if (aiThinking || jueShaVisible || gameState.gameStatus !== 'playing') return;
    invalidatePendingAI(); // 取消旧执棋方延时中/计算中的 AI 走子

    clearHint(); // 换边后提示失效
    const newSide = currentPlayerSide === 'red' ? 'black' : 'red';
    const newFirstMover = currentFirstMover === 'player' ? 'ai' : 'player';
    setCurrentPlayerSide(newSide);
    setCurrentFirstMover(newFirstMover);
    setIsFlipped(prev => !prev);
    setSelectedPieceId(null);
    setValidMoves(null);

    // 换边后若轮到 AI（当前走棋方是 AI 的新颜色），自动触发 AI 走棋
    const newAiSideTag = newSide === 'red' ? BLACK_SIDE : RED_SIDE;
    if (gameState.sideTag === newAiSideTag) {
      scheduleAIMove(gameState, 500);
    }
  }, [aiThinking, jueShaVisible, gameState, currentPlayerSide, currentFirstMover, clearHint, invalidatePendingAI, scheduleAIMove]);

  // 重新开始
  const handleRestart = useCallback(() => {
    setShowRestartConfirm(true);
  }, []);

  // 确认重新开始（残局模式：重置为当前关卡的 FEN 局面）
  // 第 3 批：重置序列不再在此手写，改由 @/hooks/useNewGame 的单一实现承担
  // （此前「确认重开 / 再来一局 / 残局下一关」各有一份 15 行副本，见 §8 表）。
  const confirmRestart = useCallback(() => {
    setShowRestartConfirm(false);
    startNewGame({
      endgameFen: isEndgame && currentEndgame ? currentEndgame.fen : undefined,
      initialSideTag,
      initialFlipped: currentPlayerSide === 'black',
      aiFirst,
    });
  }, [startNewGame, isEndgame, currentEndgame, initialSideTag, currentPlayerSide, aiFirst]);

  // 返回（对局中且有有效着法时弹保存确认，与系统返回行为一致）
  const handleBack = useCallback(() => {
    if (gameState.gameStatus !== 'playing' || gameState.moveHistory.length === 0) {
      router.back();
      return;
    }
    setShowBackConfirm(true);
  }, [gameState.gameStatus, gameState.moveHistory.length]);

  // 确认返回（保存对局；残局模式保存为残局局内存档）
  const confirmBackWithSave = useCallback(async () => {
    setShowBackConfirm(false);
    invalidatePendingAI(); // 离场取消延时中/计算中的 AI 走子
    if (isEndgame && currentEndgame) {
      await saveEndgameBattle({
        levelIndex: currentEndgame.levelIndex,
        customId: currentEndgame.customId,
        name: currentEndgame.name,
        fen: currentEndgame.fen,
        gameState,
        moveCount,
        capturedRed,
        capturedBlack,
        lastMove,
        timestamp: Date.now(),
      });
    } else {
      const save: GameSave = {
        gameState,
        difficulty,
        playerSide: currentPlayerSide,
        firstMover: currentFirstMover,
        moveCount,
        capturedRed,
        capturedBlack,
        lastMove,
        isFlipped,
        timestamp: Date.now(),
      };
      await saveGame(save);
    }
    allowLeaveRef.current = true;
    router.back();
  }, [gameState, difficulty, currentPlayerSide, currentFirstMover, moveCount, capturedRed, capturedBlack, lastMove, isFlipped, isEndgame, currentEndgame, invalidatePendingAI]);

  // 确认返回（不保存）
  const confirmBackWithoutSave = useCallback(() => {
    setShowBackConfirm(false);
    invalidatePendingAI(); // 离场取消延时中/计算中的 AI 走子
    // 用户明确选择不保存：清除旧存档，避免下次误入"继续对局/继续挑战"
    if (isEndgame) {
      deleteEndgameBattle();
    } else {
      deleteSave();
    }
    allowLeaveRef.current = true;
    router.back();
  }, [isEndgame, invalidatePendingAI]);

  // 处理再来一局（残局模式：重新挑战当前关）
  // 第 3 批：与「确认重开」共用 useNewGame 的单一重置实现，参数完全一致
  const handlePlayAgain = useCallback(() => {
    startNewGame({
      endgameFen: isEndgame && currentEndgame ? currentEndgame.fen : undefined,
      initialSideTag,
      initialFlipped: currentPlayerSide === 'black',
      aiFirst,
    });
  }, [startNewGame, isEndgame, currentEndgame, initialSideTag, currentPlayerSide, aiFirst]);

  // 残局闯关：进入下一关（原地重置棋盘为新关 FEN，避免同路由导航的状态复用问题）
  // 第 3 批：重置序列同样走 useNewGame，差异只剩三项（棋盘重挂载、固定正向显示、
  // 按新关 FEN 决定谁先走），原先这些差异是"复制整段后手工改几行"。
  const handleNextLevel = useCallback(() => {
    if (!currentEndgame || currentEndgame.levelIndex < 0) return;
    const nextIndex = currentEndgame.levelIndex + 1;
    const nextLevel = BUILTIN_ENDGAMES[nextIndex];
    if (!nextLevel) return;
    const next: EndgameLaunchParams = {
      levelIndex: nextIndex,
      customId: '',
      name: nextLevel.name,
      comment: nextLevel.comment,
      fen: nextLevel.fen,
    };
    setCurrentEndgame(next);
    startNewGame({
      endgameFen: next.fen,
      initialSideTag: RED_SIDE, // 残局下一关的红先由 aiFirstByFen 覆盖，此处仅占位
      initialFlipped: false,
      aiFirst: false,
      forceFlipped: false, // 新关固定正向显示（玩家固定执红）
      remountBoard: true, // 换关必须让 ChessBoard 重新挂载，旧关的内部测量不可复用
      aiFirstByFen: true, // FEN 带 b 段（黑先）时由 AI 走第一步
    });
  }, [currentEndgame, startNewGame]);

  // 判断当前是否是玩家回合
  const isPlayerTurn = (currentPlayerSide === 'red' && gameState.sideTag === RED_SIDE) ||
                       (currentPlayerSide === 'black' && gameState.sideTag === BLACK_SIDE);

  // 残局闯关：提示可用条件（每局限 3 次，次数用完按钮禁用；需轮到玩家、非思考中且无提示在算）
  const canEndgameHint = isEndgame && endgameHintLeft > 0 && isPlayerTurn && !aiThinking &&
                         gameState.gameStatus === 'playing' && !hintLoading;

  // 残局闯关：悔棋可用条件（每局限 10 次；需有可悔的历史着法、非思考中、对局进行中且未进入结算特效）
  const canEndgameUndo = isEndgame && endgameUndoLeft > 0 && gameState.moveHistory.length >= 2 &&
                         !aiThinking && gameState.gameStatus === 'playing' && !jueShaVisible;

  // 提示：为玩家计算当前最优解（橙色描边 + 橙色落点，长久显示，点击任意棋子后消失）
  const canHint = isPlayerTurn && !aiThinking && gameState.gameStatus === 'playing' && !hintLoading;

  const handleHint = useCallback(async () => {
    if (!isPlayerTurn || aiThinking || gameState.gameStatus !== 'playing' || hintLoading) return;
    // 残局闯关：提示限 3 次，用尽后不再提供
    if (isEndgame && endgameHintLeft <= 0) return;

    // 请求提示时，先让已选中的棋子恢复正常（清除选中态与允许落点，避免与提示标记混杂）
    setSelectedPieceId(null);
    setValidMoves(null);

    const reqId = ++hintReqRef.current;
    setHintLoading(true);
    try {
      // 提示走混合调度（与 AI 走子同一套调用逻辑）：联网优先服务端皮卡鱼 hard（纯最佳、确定性、
      // 高优先级插队），网络不可用/超时/熔断时回退本地提示搜索。区别于 AI 走法的多样化与反循环策略。
      const best = await getHybridHintMove(gameState);
      // 计算期间局面已变化（走子/悔棋/换边等）或已有新请求 → 丢弃结果
      if (reqId !== hintReqRef.current) return;
      if (!best) return;

      // 兜底：提示着法同样不得送将。
      // 本地提示搜索走 isSideInCheck 过滤、本来不含送将；但"提示"在线优先请求服务端
      // 皮卡鱼，而实测过一种病态局面——历史里含送将着法时皮卡鱼拒绝重放，会在"送将
      // 之前"的局面上搜索并返回**对方的着法**，那种着法有时恰能通过落子形状校验。
      // aiDispatcher 已在出口拦一道（rejectMoverUnsafe），这里再按落子入口同一判据兜底，
      // 避免把一步必然被拦的着法标成"推荐走法"。
      if (!isMoveKingSafe(gameState, best.pieceId, best.toCol, best.toRow)) return;

      // 残局闯关：成功给出提示才消耗一次次数（计算失败/局面已变不扣次）
      if (isEndgame) setEndgameHintLeft(prev => Math.max(0, prev - 1));

      // 提示长久显示，不再自动消失（仅在点击棋子/走子/悔棋/换边时清除）
      setHintMove({ pieceId: best.pieceId, toCol: best.toCol, toRow: best.toRow });
    } finally {
      if (reqId === hintReqRef.current) setHintLoading(false);
    }
  }, [isPlayerTurn, aiThinking, gameState, hintLoading, isEndgame, endgameHintLeft]);

  const difficultyLabel = { easy: '入门', medium: '进阶', hard: '大师' }[difficulty];

  // AI 标识角标文案：绿指示灯=皮卡鱼（在线，含搜索深度）；灰指示灯=本地AI（离线，含难度）
  // 首步 AI 走棋前来源未知，默认按本地 AI 展示，走棋后立即刷新为真实来源
  const aiIsOnline = aiSource === 'online';
  // 在线 AI 连接状态：熔断中（走本地，稍后自动探测恢复）/ 冷却后将先探测再决定是否联网
  // 修复"较长时间仍保持本地AI、似乎没有重连"的观感——明确告知用户系统在自救
  const onlineAiStatus = onlineAiStatusState;
  // 服务端繁忙退避中：说明"还在连，只是服务端此刻排队"，与"连不上"要区分开
  const onlineAiBusy = isOnlineAiBusyRetrying();
  const onlineAiInvalidReason = getOnlineAiInvalidReason();
  const longGameNotice = getOnlineAiLongGameNotice();
  // 角标之外的说明条文案：把静默降级的原因讲清楚（拒收原因 / 对局过长 / 繁忙重试）。
  // 用 GameNotice 横幅承载（覆盖在棋盘中央、不阻塞落子），不新增常驻行，
  // 避免打乱棋盘高度预算（useBoardLayoutBudget 的 topFlowHeight）。
  // 主文案控制在 12 字以内：窄屏（手机竖屏）提示条每行只排得下十来字，主文案再长
  // 就得挤成三四行、把棋盘中心糊住；更细的原因放在 detail 里，由 GameNotice 断行。
  // key 只跟文案走：同一原因反复出现时不重复弹横幅（常驻指示靠角标，避免刷屏）；
  // 靠 onlineAiStatusTick 消费掉"订阅有更新"这一信号（状态枚举外的变化靠角标读数体现）。
  void onlineAiStatusTick;
  const onlineAiNoticeText = onlineAiInvalidReason
    ? '在线走法异常，改用本地'
    : longGameNotice
      ? '对局过长，建议求和'
      : onlineAiBusy
        ? '服务端繁忙，正在重试'
        : null;
  const onlineAiNoticeItem: GameNoticeItem | null = useMemo(
    () =>
      onlineAiNoticeText
        ? {
            key: `online-ai-${onlineAiNoticeText}`,
            text: onlineAiNoticeText,
            // 细分原因（拒收原因 / 超限步数）放 detail：主文案一行说完，
            // 细节由 GameNotice 摘掉尾部「（…）」诊断注解后断行排版
            ...(onlineAiInvalidReason ? { detail: onlineAiInvalidReason } : {}),
            ...(longGameNotice ? { detail: longGameNotice } : {}),
            duration: 2600,
          }
        : null,
    [onlineAiNoticeText, onlineAiInvalidReason, longGameNotice]
  );
  // 开局库命中时服务端 depth 恒为 0，展示"开局库"而非误导性的"深度0"；
  // 皮卡鱼搜索才展示真实深度（且深度>0 才显示，兜底避免异常 0 值）
  const aiChipLabel = aiIsOnline
    ? (aiEngine === 'book'
        ? '皮卡鱼（开局库）'
        : (aiDepth != null && aiDepth > 0 ? `皮卡鱼（深度${aiDepth}）` : '皮卡鱼'))
    : [
        `本地AI（${difficultyLabel}）`,
        onlineAiBusy ? '服务端繁忙，重试中' : null,
        onlineAiStatus === 'invalid_move' ? '在线走法被拒' : null,
        onlineAiStatus === 'circuit' ? '重连中' : null,
        onlineAiStatus === 'probing' ? '探测中' : null,
      ]
        .filter(Boolean)
        .join('·');

  return (
    <Screen>
      <View style={styles.container} ref={containerRef}>
        {/* 顶部信息栏 */}
        <View style={styles.topBar}>
          <View style={styles.backButton}>
            <TouchableOpacity onPress={handleBack} style={styles.backButtonInner}>
              <FontAwesome6 name="chevron-left" size={20} color={COLORS.text} />
            </TouchableOpacity>
          </View>

          <View style={styles.gameInfo}>
            {/* 标题行：标题 + 标题右侧紧邻的玩法说明标识（残局闯关专用，样式与选关页标题行一致） */}
            <View style={styles.gameTitleRow}>
              <Text style={styles.gameTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
                {isEndgame && currentEndgame
                  ? (currentEndgame.levelIndex >= 0 ? `残局闯关 · 第${currentEndgame.levelIndex + 1}关` : '残局闯关 · 自定义')
                  : '人机对战'}
              </Text>
              {isEndgame && currentEndgame && (
                <TouchableOpacity
                  onPress={() => setEndgameInfoVisible(true)}
                  accessibilityLabel="玩法说明"
                  accessibilityRole="button"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <FontAwesome6 name="circle-info" size={14} color={COLORS.primary} />
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.gameSubtitle}>
              {isEndgame && currentEndgame
                ? `${currentEndgame.name}${currentEndgame.tier ? ` · ${currentEndgame.tier}` : ''} · 大师难度\n第 ${Math.ceil(moveCount / 2) + 1} 回合`
                : `${difficultyLabel} · 执${currentPlayerSide === 'red' ? '红' : '黑'}${aiFirst ? '后手' : '先手'}\n第 ${Math.ceil(moveCount / 2) + 1} 回合`}
            </Text>
          </View>

          <View style={styles.turnIndicator}>
            <View style={[
              styles.turnDot,
              // 圆点跟随"当前走棋方"的棋子颜色（红方走=红、黑方走=黑），
              // 翻转换边后仍与棋盘上一致；不能按 isPlayerTurn 取色（执黑时会反色）
              { backgroundColor: gameState.sideTag === RED_SIDE ? COLORS.redPiece : COLORS.blackPiece },
            ]} />
            <Text style={styles.turnText}>
              {aiThinking ? 'AI思考中' : (isPlayerTurn ? '你的回合' : 'AI回合')}
            </Text>
          </View>
        </View>

        {/* 标题行下方内容宿主（相对定位，被吃棋子抽屉锚定于此 = 标题行正下方） */}
        <View
          style={styles.capturedDrawerHost}
          onLayout={(e) => {
            setBoardAreaH(e.nativeEvent.layout.height);
            setDrawerHostY(e.nativeEvent.layout.y);
          }}
        >
          {/* 被吃棋子明细抽屉：点击摘要文字后自标题行向下展开（浮层，棋盘不动） */}
          <CapturedPiecesDrawer
            side={capturedDrawerSide}
            gameState={gameState}
            playerSide={currentPlayerSide}
            maxBoardHeight={maxBoardHeight}
          />

          {/* 棋盘区域 + 底部操作栏（顶部留白由预算控制：优先垂直居中，预留不足时整体下移贴住预留区） */}
          <View style={[styles.boardContainer, { paddingTop: boardPadTop }]}>
            {/* AI 标识角标行：棋盘上方独立行，左对齐（参照联机对战对手名称角标样式），
                实时指示当前 AI 引擎来源——绿色指示灯=云端皮卡鱼（含深度），灰色指示灯=本地AI（含难度） */}
            <View style={[styles.aiNameRow, alignedRowStyle]} pointerEvents="none">
              <View style={styles.aiNameChip}>
                <View style={[styles.aiNameChipDot, aiIsOnline && styles.aiNameChipDotOnline]} />
                <Text style={styles.aiNameChipText} numberOfLines={1}>
                  {aiChipLabel}
                </Text>
              </View>
            </View>

            {/* 棋盘几何测量包裹层：绝杀特效据此锁定棋盘中心/底边（collapsable=false 保证 Android 可测量） */}
            <View ref={boardRef} onLayout={measureBoardFrame} collapsable={false}>
            <ChessBoard
              key={boardKey}
              gameState={gameState}
              selectedPieceId={selectedPieceId}
              validMoves={validMoves}
              lastMove={lastMove}
              isFlipped={isFlipped}
              onPiecePress={handlePiecePress}
              onEmptyPress={handleEmptyPress}
              onMove={handleEmptyPress}
              aiThinking={aiThinking}
              capturedByRed={capturedByRed}
              capturedByBlack={capturedByBlack}
              hideCaptured={jueShaVisible}
              playerSide={currentPlayerSide}
              hintMove={hintMove}
              onCapturedPress={(side) => setCapturedDrawerSide(prev => (prev === side ? null : side))}
              maxBoardHeight={maxBoardHeight}
              capturedStripOffset={30}
              moveEffect={moveEffect}
              // 【提示口径 2026-10】不再向棋盘下发 banMoves 标红：提示统一收敛到
              // 「阈值前一步的一次性提示条」。banMoves 本身仍在 RuleState 里计算，
              // 因为 AI 择优（isMoveBanned）要用它过滤会走进僵局的着法。
              banMoves={null}
              // 【P4】稳定引用：ChessBoard 用 onBoardLayoutRef 读取它，
              // 不再因为每次渲染新建函数而让子组件的 memo 失效
              onBoardLayout={stableSetBoardSize}
            />
            </View>

          {/* 底部操作栏（绝杀特效显示时隐藏但保持占位，防止棋盘位置移动）
              残局闯关规则：不允许翻转；每局限 3 次提示（走皮卡鱼）+ 10 次悔棋，
              剩余次数以按钮右上角数字角标展示；「说明」已移至标题行右侧标识 */}
          <View
            style={[styles.bottomBar, alignedRowStyle, { marginTop: dynamicGap }, jueShaVisible && { opacity: 0 }]}
            pointerEvents={jueShaVisible ? 'none' : 'auto'}
            onLayout={(e) => setBottomBarH(e.nativeEvent.layout.height)}
          >
            {isEndgame ? (
              <>
                <TouchableOpacity
                  style={[styles.actionButton, !canEndgameHint && styles.actionButtonDisabled]}
                  onPress={handleHint}
                  disabled={!canEndgameHint}
                >
                  {/* 图标/加载指示器置于固定尺寸容器内：切换 icon↔spinner 时按钮高度不变，
                      避免 bottomBarH 抖动 → 棋盘预算重算 → 棋盘忽大忽小 */}
                  <View style={styles.actionIconFrame}>
                    {hintLoading ? (
                      <ActivityIndicator size="small" color={COLORS.textMuted} />
                    ) : (
                      <FontAwesome6 name="lightbulb" size={16} color={canEndgameHint ? COLORS.text : COLORS.textMuted} />
                    )}
                  </View>
                  <Text style={[styles.actionButtonText, !canEndgameHint && { color: COLORS.textMuted }]}>
                    提示
                  </Text>
                  {/* 剩余提示次数：按钮右上角数字角标（样式同棋盘棋子数量角标） */}
                  <View style={styles.countBadge}>
                    <Text style={styles.countBadgeText}>{endgameHintLeft}</Text>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.actionButton, !canEndgameUndo && styles.actionButtonDisabled]}
                  onPress={handleUndo}
                  disabled={!canEndgameUndo}
                >
                  <FontAwesome6
                    name="rotate-left"
                    size={16}
                    color={canEndgameUndo ? COLORS.text : COLORS.textMuted}
                  />
                  <Text style={[styles.actionButtonText, !canEndgameUndo && { color: COLORS.textMuted }]}>
                    悔棋
                  </Text>
                  {/* 剩余悔棋次数：按钮右上角数字角标（悔棋不参与金/银/铜冠评定） */}
                  <View style={styles.countBadge}>
                    <Text style={styles.countBadgeText}>{endgameUndoLeft}</Text>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity style={styles.actionButton} onPress={handleRestart}>
                  <FontAwesome6 name="rotate-right" size={16} color={COLORS.text} />
                  <Text style={styles.actionButtonText}>重开</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity
                  style={[styles.actionButton, !canHint && styles.actionButtonDisabled]}
                  onPress={handleHint}
                  disabled={!canHint}
                >
                  <FontAwesome6 name="lightbulb" size={16} color={canHint ? '#F57C00' : COLORS.textMuted} solid />
                  <Text style={[styles.actionButtonText, !canHint && { color: COLORS.textMuted }]}>提示</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.actionButton, gameState.moveHistory.length < 2 && styles.actionButtonDisabled]}
                  onPress={handleUndo}
                  disabled={gameState.moveHistory.length < 2 || aiThinking}
                >
                  <FontAwesome6 name="rotate-left" size={16} color={COLORS.text} />
                  <Text style={styles.actionButtonText}>悔棋</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.actionButton} onPress={handleFlip}>
                  <FontAwesome6 name="arrows-rotate" size={16} color={COLORS.text} />
                  <Text style={styles.actionButtonText}>翻转</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.actionButton} onPress={handleRestart}>
                  <FontAwesome6 name="rotate-right" size={16} color={COLORS.text} />
                  <Text style={styles.actionButtonText}>重开</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
          </View>

          {/* 长将长捉规则提示（方案 12 文案）：接近阈值/禁着/违规警告。
              与联机对战页同款 GameNotice —— 绝对定位在棋盘中心、pointerEvents="box-none"
              不阻塞落子、3s 后自动淡出；绝杀特效展示期间让位避免与结算文字重叠。
              在线 AI 提示走同一通道（优先级低于规则提示：规则提示优先，规则提示没有时才显示）。 */}
          <GameNotice
            notice={jueShaVisible ? null : (ruleNotice ?? onlineAiNoticeItem)}
            centerY={ruleNoticeCenterY}
            onHide={hideRuleNotice}
          />
        </View>

        {/* 绝杀特效（含结果与按钮，替代结算弹窗） */}
        {jueShaVisible && (() => {
          // 仅绝杀/困毙播放「绝/杀」字符特效；长将/长捉判负、和棋等规则终局只淡入结果文字
          const showJueEffect = gameOverReason === 'juesha' || gameOverReason === 'kunbi';
          const isDrawGame = gameState.gameStatus === 'draw';
          // 和棋文案（方案 12）：按终局原因细分
          const drawText =
            gameOverReason === 'mutual_long_check' ? '双方长将，判和！'
            : gameOverReason === 'mutual_long_chase' ? '双方长捉，判和！'
            : gameOverReason === 'natural_limit' ? '自然限招，判和！'
            : gameOverReason === 'total_limit' ? '达到总步数上限，判和！'
            : gameOverReason === 'no_attacking' ? '双方无进攻子力，判和！'
            : '双方不变，和棋！';
          // 残局闯关结算：胜利 → 下一关（若有）+ 返回选关；和棋/失败 → 重新挑战 + 返回选关
          if (isEndgame && currentEndgame) {
            const outcome = endgameResultRef.current;
            const won = outcome === 'win';
            // 和棋单独成句：残局里没在限招内取胜就是挑战超时，不该显示成「闯关成功」，
            // 也不该复用「挑战失败，再接再厉」的战败口吻。
            const drawResultText = `挑战超时，请重试（${drawText}）`;
            const hasNext = currentEndgame.levelIndex >= 0 && currentEndgame.levelIndex + 1 < BUILTIN_ENDGAMES.length;
            return (
              <JueShaOverlay
                visible={jueShaVisible}
                boardFrame={jueshaBoardFrame}
                showEffect={showJueEffect}
                resultText={
                  won ? '闯关成功！' : outcome === 'draw' ? drawResultText : '挑战失败，再接再厉！'
                }
                onNextLevel={won && hasNext ? handleNextLevel : undefined}
                onPlayAgain={won && hasNext ? undefined : handlePlayAgain}
                primaryText={won ? '再玩一次' : '重新挑战'}
                onGoHome={() => router.back()}
                secondaryText="返回选关"
              />
            );
          }
          // 规则终局的判负方：gameStatus 的胜方对面即违规方（二将一还时长将方判负）
          const ruleLoserName = gameState.gameStatus === 'black_win' ? '红方' : '黑方';
          return (
            <JueShaOverlay
              visible={jueShaVisible}
              boardFrame={jueshaBoardFrame}
              showEffect={showJueEffect}
              resultText={
                gameOverReason === 'juesha'
                  ? (gameState.sideTag === RED_SIDE ? '红方' : '黑方') + '被绝杀！'
                  : gameOverReason === 'kunbi'
                  ? (gameState.sideTag === RED_SIDE ? '红方' : '黑方') + '被困毙！'
                  : gameOverReason === 'changjiang'
                  ? ruleLoserName + '长将判负！'
                  : isDrawGame
                  ? drawText
                  : ((gameOverReason === 'red_win' && currentPlayerSide === 'red') ||
                     (gameOverReason === 'black_win' && currentPlayerSide === 'black'))
                    ? '你击败了 AI 对手！'
                    : (gameOverReason === 'red_win' ? '红方获胜' : '黑方获胜')
              }
              onPlayAgain={handlePlayAgain}
              onGoHome={() => {
                // 优先 dismissAll 回到栈底首页：replace 只是替换栈顶，会把设置页压在
                // 新首页之下（表现为"首页再返回又到了设置页"）；Web 刷新等无栈场景兜底 replace
                if (router.canGoBack()) {
                  router.dismissAll();
                } else {
                  router.replace('/');
                }
              }}
            />
          );
        })()}
      </View>

      {/* 残局说明弹窗 */}
      <AppDialog
        visible={endgameInfoVisible}
        title={
          currentEndgame
            ? `${currentEndgame.customId ? '自定义残局' : `第${currentEndgame.levelIndex + 1}关`} · ${currentEndgame.name}${currentEndgame.tier ? ` · ${currentEndgame.tier}` : ''}`
            : '残局说明'
        }
        message={currentEndgame?.comment?.trim() ? currentEndgame.comment : '本关无特别说明，将杀对方即获胜。'}
        confirmText="知道了"
        onConfirm={() => setEndgameInfoVisible(false)}
      />

      {/* 重开确认弹窗 */}
      <AppDialog
        visible={showRestartConfirm}
        title="确认重开"
        message="当前对局将丢失，确定要重新开始吗？"
        cancelText="取消"
        confirmText="确定"
        onCancel={() => setShowRestartConfirm(false)}
        onConfirm={confirmRestart}
      />

      {/* 返回确认弹窗 */}
      <AppDialog
        visible={showBackConfirm}
        title="保存对局"
        message="是否保存当前对局，以便下次继续？"
        cancelText="不保存"
        confirmText="保存"
        onCancel={confirmBackWithoutSave}
        onConfirm={confirmBackWithSave}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
    alignItems: 'center',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    width: '100%',
    // 与其他界面标题行一致的暖白底色 + 底部分隔线
    backgroundColor: COLORS.bgCard,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  backButton: {
    width: 100,
    justifyContent: 'center',
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
  gameInfo: {
    flex: 1,
    alignItems: 'center',
  },
  // 标题行：标题 + 紧邻其右侧的玩法说明标识（残局闯关；与选关页 headerTitleRow 同款）
  gameTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  gameTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.text,
  },
  gameSubtitle: {
    fontSize: FONT.caption,
    color: COLORS.textMuted,
    marginTop: 2,
    textAlign: 'center',
    lineHeight: 17,
  },
  turnIndicator: {
    width: 100,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    backgroundColor: COLORS.bgCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  turnDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  turnText: {
    fontSize: FONT.caption,
    color: COLORS.text,
    fontWeight: '600',
  },
  // AI 标识角标行：棋盘上方独立行（与联机对战名字角标同款药丸样式），左对齐
  aiNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 26,
    marginBottom: 4,
    paddingHorizontal: 12,
  },
  aiNameChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.bgCard,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 4,
    paddingHorizontal: 10,
    // 角标文案会随在线状态追加状态后缀（如"·重连中""·在线走法被拒"），放宽上限避免截断
    maxWidth: '86%',
  },
  // 指示灯：默认灰色=本地AI
  aiNameChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#9E9E9E',
  },
  // 绿色指示灯=云端皮卡鱼
  aiNameChipDotOnline: {
    backgroundColor: '#2E7D32',
  },
  aiNameChipText: {
    fontSize: FONT.caption,
    fontWeight: '600',
    color: COLORS.text,
    flexShrink: 1,
  },
  // 标题行下方内容宿主：被吃棋子抽屉（绝对定位）锚定于此容器顶部
  capturedDrawerHost: {
    flex: 1,
  },
  boardContainer: {
    flex: 1,
    justifyContent: 'flex-start',
    alignItems: 'center',
  },
  bottomBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    // 宽度在渲染处以数值屏宽传入（部分 Android 设备的 Yoga 对百分比/strech
    // 处理不可靠），按钮 flex:1 等分可用宽度，保证任何屏宽下不溢出
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
  // 固定尺寸的图标容器：提示按钮在 icon↔加载指示器间切换时占位不变，
  // 保证底部操作栏高度稳定，棋盘布局预算不随之抖动
  actionIconFrame: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonText: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.text,
  },
  // 次数角标：按钮右上角红色圆形数字标识（样式与棋盘/摆子栏的棋子数量角标一致：
  // 红底白字 + 白细边），略微越出按钮边缘形成叠加感；数字为剩余可用次数
  countBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 3,
    backgroundColor: '#C62828',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.85)',
  },
  countBadgeText: {
    color: '#FFFFFF',
    fontSize: FONT.micro,
    fontWeight: '700',
    lineHeight: 13,
  },
  // 弹窗遮罩/卡片/按钮样式已收敛到 @/components/Modal（AppModal / AppDialog / ModalButton），
  // 尺寸与配色统一走 @/constants/modal 的 Design Tokens。
});
