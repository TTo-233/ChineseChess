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
  Dimensions,
  Animated,
  Modal,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { useNavigation } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import ChessBoard, { CapturedPiecesDrawer } from '@/components/ChessBoard';
import JueShaOverlay from '@/components/JueShaOverlay';
import { useMoveEffect } from '@/hooks/useMoveEffect';
import { useBoardFrame } from '@/hooks/useBoardFrame';
import { MOVE_EFFECT_DURATION_MS } from '@/components/MoveEffectOverlay';
import {
  createInitialState,
  createFromFen,
  getValidMoves,
  makeMove,
  undoMove,
  getWinnerSideTag,
  type GameState,
} from '@/utils/chess/GameEngine';
import { getBestMoveAsync, precomputeHint, cancelHintPonder, recordHistoryHash, clearHistoryHash, computeZobristHash } from '@/utils/chess/AIEngine';
import { getHybridBestMove, getHybridHintMove, getOnlineAiStatus, type AISource, type HybridMoveResult } from '@/utils/chess/aiDispatcher';
import { isMoveBanned, recordBanViolation, enumerateLegalMoves } from '@/utils/chess/RuleEngine';
import { playSound, playJiangJunSound, unloadAllSounds, preloadSounds, preloadGameEndSounds } from '@/utils/SoundManager';
import { RED_SIDE, BLACK_SIDE } from '@/utils/chess/types';
import { saveGame, loadGame, deleteSave, type GameSave } from '@/utils/GameSave';
import { saveReplay } from '@/utils/replayStorage';
import { BUILTIN_ENDGAMES } from '@/utils/chess/endgames';
import { useBoardLayoutBudget, capHostHeightToViewport } from '@/utils/chess/capturedDrawerMetrics';
import { boardAlignedRowStyle } from '@/utils/chess/boardContentWidth';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
import {
  markLevelCompleted,
  markCustomCompleted,
  saveEndgameBattle,
  loadEndgameBattle,
  deleteEndgameBattle,
  type EndgameLaunchParams,
} from '@/utils/EndgameProgress';
import { FONT } from '@/utils/typography';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// 棋盘尺寸根据屏幕宽度自适应


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

// 残局闯关每局限用次数：提示 3 次、悔棋 10 次。
// 悔棋不参与金/银/铜冠评定——评级只统计提示次数（悔棋属于过程性辅助，不作为评级依据）
const ENDGAME_HINT_LIMIT = 3;
const ENDGAME_UNDO_LIMIT = 10;

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

  // 从残局 FEN 构建初始局面（含 Zobrist 初始化与历史记录）
  const buildEndgameState = useCallback((fen: string): GameState => {
    const state = createFromFen(fen.trim());
    state.zobristHash = computeZobristHash(state);
    clearHistoryHash();
    recordHistoryHash(state);
    return state;
  }, []);

  // 游戏状态
  const [gameState, setGameState] = useState<GameState>(() => {
    if (initialEndgame) {
      return buildEndgameState(initialEndgame.fen);
    }
    const state = createInitialState(initialSideTag);
    // 初始化 Zobrist 哈希
    state.zobristHash = computeZobristHash(state);
    // 清空历史记录（新对局开始）
    clearHistoryHash();
    // 记录初始局面
    recordHistoryHash(state);
    return state;
  });
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

  // ===== AI 走子竞态防护 =====
  // 代数（generation）：任何会重置/改变局面的操作（重开、下一关、悔棋、翻转、
  // 返回、读档）都使代数自增；延时中或计算中的 AI 走子在落地前校验代数，
  // 代数已变则丢弃结果，避免旧局面的 AI 着法覆盖新状态（如"重开后 AI 又落一子
  // 把局面拉回旧棋"、"悔棋被延时中的 AI 着法顶掉"）。
  const gameGenRef = useRef(0);
  // 待执行的 AI 延时定时器（executeMove/重开/翻转等排定的 AI 走子）
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 使所有排队中/计算中的 AI 走子失效（局面重置类操作的统一前置动作） */
  const invalidatePendingAI = useCallback(() => {
    gameGenRef.current += 1;
    if (aiTimerRef.current) {
      clearTimeout(aiTimerRef.current);
      aiTimerRef.current = null;
    }
  }, []);

  // 卸载时清理 AI 延时定时器
  useEffect(() => {
    return () => {
      if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    };
  }, []);

  // 动态间距：随屏幕宽度/棋盘缩放比例自适应
  const screenWidth = Dimensions.get('window').width;
  // 窗口高度：用于把棋盘宿主实测高度封顶到视口内，打断宽屏纵向溢出的正反馈
  const windowHeight = Dimensions.get('window').height;
  const dynamicGap = Math.max(Math.round(screenWidth * 0.03), 8);
  // 安全区：Screen 已在内容之外施加，预算封顶时需据此扣减可用高度
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
  // 残局闯关：本局胜负（win=玩家过关 / lose=挑战失败），用于结算按钮区分
  const endgameResultRef = useRef<'win' | 'lose' | null>(null);
  // 吃子/将军特效（含连续将军节流策略）
  const { moveEffect, triggerMoveEffect } = useMoveEffect();

  // 计算被吃掉的棋子
  const getCapturedPieces = () => {
    const capturedByRed: number[] = []; // 红方吃掉的（黑方棋子）
    const capturedByBlack: number[] = []; // 黑方吃掉的（红方棋子）
    
    gameState.pieces.forEach(piece => {
      if (!piece.alive) {
        // 棋子ID 0-15 是黑方，16-31 是红方
        if (piece.id < 16) {
          capturedByRed.push(piece.id); // 黑方棋子被红方吃掉
        } else {
          capturedByBlack.push(piece.id); // 红方棋子被黑方吃掉
        }
      }
    });
    
    return { capturedByRed, capturedByBlack };
  };

  const { capturedByRed, capturedByBlack } = getCapturedPieces();

  // 加载存档；并在进入对局时预加载常用音效、预热音频模式
  // （预加载消除首步音效按需加载的延迟与音频会话建立时序问题，修复概率性漏音）
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
  const [endgameHintLeft, setEndgameHintLeft] = useState(ENDGAME_HINT_LIMIT);
  const [endgameUndoLeft, setEndgameUndoLeft] = useState(ENDGAME_UNDO_LIMIT);
  // 被吃棋子明细抽屉展开的一侧（null=收起），抽屉渲染在顶部标题行正下方
  const [capturedDrawerSide, setCapturedDrawerSide] = useState<'opponent' | 'mine' | null>(null);
  // 棋盘可用纵向空间实测（宽屏/纵向空间不足时限制棋盘尺寸，避免挤占标题行与底部操作栏）
  const [boardAreaH, setBoardAreaH] = useState(0);
  const [bottomBarH, setBottomBarH] = useState(0);
  // 棋盘内容宿主顶边相对页面内容顶边的 Y（含顶部栏与顶部安全区）：预算封顶时用于推算可用高度
  const [drawerHostY, setDrawerHostY] = useState(0);

  // 长将长捉规则提示横幅（接近阈值"请尽快变招"/达到阈值"禁着请变招"/违规警告，
  // 方案 10.3 / 12）：短暂展示后自动消失
  const [ruleNotice, setRuleNotice] = useState<string | null>(null);
  const ruleNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showRuleNotice = useCallback((text: string) => {
    setRuleNotice(text);
    if (ruleNoticeTimerRef.current) clearTimeout(ruleNoticeTimerRef.current);
    ruleNoticeTimerRef.current = setTimeout(() => setRuleNotice(null), 3500);
  }, []);
  useEffect(() => {
    return () => {
      if (ruleNoticeTimerRef.current) clearTimeout(ruleNoticeTimerRef.current);
    };
  }, []);

  // 棋盘高度预算 + 垂直定位留白（二分求解，口径与抽屉真实尺寸一致）：
  // 条件 1 —— 棋盘顶边上方常驻预留「AI 角标行(30) + 摘要条悬浮区(38+30) + 抽屉展开高度」，
  //           无论抽屉是否点开都预留，保证展开时底边不压棋盘、不与摘要条/角标重叠；
  // 条件 2 —— 内容（角标行 + 棋盘 + 底部栏）在宿主内垂直居中；居中时上方预留不足则整体下移
  //           贴住预留区（把下方空白让给棋盘），棋盘取到预留允许的最大尺寸。
  // 宽屏下棋盘由纵向预算决定而缩小，抽屉随棋盘同步缩小，预留与真实抽屉高度精确一致，
  // 不再像旧实现那样按宽度缩放高估抽屉、把棋盘压缩得过小。
  // 上方流内占位 = AI 角标行(26+4=30)；下方流内占位 = dynamicGap + 底部操作栏。
  // hostHeight 经视口封顶：Screen 的 flexGrow 容器会让 flex:1 宿主按内容撑开，
  // 不封顶则「宿主变大 → 棋盘变大 → 内容更高」正反馈会让宽屏页面纵向溢出
  // （详见 capHostHeightToViewport 注释）。
  const { maxBoardHeight, paddingTop: boardPadTop } = useBoardLayoutBudget({
    hostHeight: capHostHeightToViewport(
      boardAreaH,
      windowHeight,
      drawerHostY,
      insets.top,
      insets.bottom,
      0 // 底部栏在 capturedDrawerHost 之内，已由 bottomFlowHeight 计入
    ),
    screenWidth,
    stripOffset: 30,
    topFlowHeight: 30,
    bottomFlowHeight: dynamicGap + bottomBarH,
  });

  // 棋盘真实几何（相对主容器）：供绝杀特效锁定棋盘中心、把结算文字/按钮排到棋盘正下方
  const { containerRef, boardRef, boardFrame, measure: measureBoardFrame } = useBoardFrame();

  // 当前棋盘样式：AI 角标行宽度需按样式几何换算棋盘本体宽度（用户可在首页设置中切换样式）
  const boardStyle = useBoardStyle();

  // AI 角标行宽度：取棋盘本体宽度并水平居中，使角标行左右边缘与棋盘边缘对齐
  // （宽屏下棋盘因纵向预算被压缩居中，角标行若铺满整屏会贴到屏幕最左/最右）
  const nameRowStyle = useMemo(
    () => boardAlignedRowStyle(screenWidth, boardStyle, maxBoardHeight ?? 0),
    [boardStyle, maxBoardHeight]
  );

  // 底部操作栏宽度：同样跟随棋盘本体宽度居中，宽屏下不再横贯整个屏幕
  const bottomBarWidthStyle = useMemo(
    () => boardAlignedRowStyle(screenWidth, boardStyle, maxBoardHeight ?? 0),
    [boardStyle, maxBoardHeight]
  );

  // 绝杀特效弹出前兜底重测：boardPadTop/maxBoardHeight 变化只挪动棋盘（相对父级布局不变，
  // 包裹层 onLayout 可能不触发），此处按绝对坐标重新测量，保证特效对齐的是最新棋盘位置
  useEffect(() => {
    if (!jueShaVisible) return;
    measureBoardFrame();
  }, [jueShaVisible, boardPadTop, maxBoardHeight, measureBoardFrame]);

  // 棋盘本体真实尺寸（外层容器宽=屏宽，onBoardLayout 回报的才是棋盘宽），由 ChessBoard 回报
  const [boardSize, setBoardSize] = useState<{ width: number; height: number } | null>(null);

  // 绝杀特效对齐用的棋盘框：测量框宽=屏宽（外层容器），按棋盘本体宽度在其中水平居中换算，
  // 得到棋盘本体的真实 x/宽，保证特效中心与按钮宽度口径都落在棋盘本体上
  const jueshaBoardFrame = useMemo(() => {
    if (!boardFrame) return null;
    const w = boardSize?.width ?? boardFrame.width;
    const h = boardSize?.height ?? boardFrame.height;
    return {
      x: boardFrame.x + (boardFrame.width - w) / 2,
      y: boardFrame.y,
      width: w,
      height: h,
    };
  }, [boardFrame, boardSize]);

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

    // 记录当前代数：计算期间若发生重开/悔棋/翻转等重置，结果作废
    const gen = gameGenRef.current;
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
      if (gameGenRef.current !== gen) return;

      if (aiMove) {
        setAiSource(aiMove.source);
        setAiDepth(aiMove.depth ?? null);
        setAiEngine(aiMove.engine ?? null);

        // 长将长捉禁着防御（方案 10.3）：AI 搜索根节点已过滤禁着、云端着法经调度器
        // 守卫拦截，此处为最后兜底——若仍返回禁着着法则改走任意非禁着合法着
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

        // 规则提示（AI 走子触发，如"AI 长将禁着，请变招"等待玩家应对的场景）
        if (newState.ruleState?.notice) {
          showRuleNotice(newState.ruleState.notice);
        }

        // 更新 Zobrist 哈希（AI 走棋后）
        newState.zobristHash = computeZobristHash(newState);
        recordHistoryHash(newState);

        // 播放音效：将军时播放男声将军语音（替代走子音，避免与吃子/走子音混音重叠）
        if (isCheck && !isGameOver) {
          await playJiangJunSound();
        } else if (captured !== -1) {
          await playSound('eat');
        } else {
          await playSound('go');
        }

        // 吃子/将军特效（终局时不播，由绝杀特效接管）
        triggerMoveEffect(captured, isCheck, isGameOver);

        if (isGameOver) {
          // AI 走棋终局不一定 AI 胜（长将判负、不变作和）→ 按引擎真实裁决播放音效
          const isDraw = newState.gameStatus === 'draw';
          const aiWonNow = !isDraw && getWinnerSideTag(newState) === aiSideTag;
          if (!isDraw) {
            // AI 胜=玩家败（gamelose）；AI 被判负=玩家胜（gamewin）；和棋不播胜负音效
            await playSound(aiWonNow ? 'gamelose' : 'gamewin');
          }
        }

        // 音效播放期间局面也可能被重置（如玩家中途重开）→ 落地前再校验一次
        if (gameGenRef.current !== gen) return;

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
          const aiWon = getWinnerSideTag(newState) === aiSideTag;
          if (isEndgame) {
            endgameResultRef.current = aiWon ? 'lose' : 'win'; // AI 胜=挑战失败；AI 被判负=挑战成功
            if (!aiWon && currentEndgame) {
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
      if (gameGenRef.current === gen) setAiThinking(false);
    }
  }, [difficulty, triggerMoveEffect, savePveReplay, isEndgame, aiSideTag, currentEndgame, endgameHintLeft, showRuleNotice]);

  /** 延时排定一次 AI 走子（可被 invalidatePendingAI 取消） */
  const scheduleAIMove = useCallback((state: GameState, delayMs: number) => {
    if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    const gen = gameGenRef.current;
    aiTimerRef.current = setTimeout(() => {
      aiTimerRef.current = null;
      if (gameGenRef.current !== gen) return; // 局面已被重置，放弃
      triggerAIMove(state);
    }, delayMs);
  }, [triggerAIMove]);

  // 点击棋子
  const handlePiecePress = useCallback((pieceId: number) => {
    clearHint(); // 点击任意棋子，提示立即消失
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
      const moves = getValidMoves(gameState, pieceId);
      setValidMoves(moves);
      return;
    }

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
    // 兜底校验：落点必须在该棋子当前合法走法内（基于棋子本身走法 + 王安全过滤），
    // 即使界面落点状态过期，也杜绝任何非法落子
    const legalMoves = getValidMoves(gameState, pieceId);
    if (!legalMoves[toCol]?.[toRow]) {
      setSelectedPieceId(null);
      setValidMoves(null);
      return;
    }

    // 长将长捉禁着拦截（方案 10.1/10.3：禁着期间客户端不得提交禁着）：
    // 点击禁着点 → 提示"请变招"并累计违规；连续 3 次坚持禁着自动判负
    if (isMoveBanned(gameState, pieceId, toCol, toRow)) {
      const rs = gameState.ruleState!;
      const playerSideTag = currentPlayerSide === 'red' ? RED_SIDE : BLACK_SIDE;
      const banLabel = rs.banReason === 'LONG_CHECK' ? '长将'
        : rs.banReason === 'LONG_CHASE' ? '长捉' : '将捉';
      const violation = recordBanViolation(rs, playerSideTag);
      if (violation === 'lose' || violation === 'draw') {
        // 连续 3 次坚持禁着 → 自动判负（方案 10.1）；双方均拒绝变着 → 判和（方案 2.4）
        const reason = violation === 'draw' ? 'repetition'
          : rs.banReason === 'LONG_CHECK' ? 'changjiang' : 'changzhuo';
        const finalState: GameState = {
          ...gameState,
          gameStatus: violation === 'draw' ? 'draw'
            : playerSideTag === RED_SIDE ? 'black_win' : 'red_win',
        };
        setGameState(finalState);
        setGameOverReason(reason);
        setJueShaVisible(true);
        endgameResultRef.current = 'lose';
        if (isEndgame) {
          deleteEndgameBattle();
        } else {
          deleteSave();
          savePveReplay(finalState, false);
        }
        showRuleNotice(violation === 'draw' ? '双方均拒绝变着，判和' : `${banLabel}违规三次，判负`);
        return;
      }
      const count = rs.banViolations[currentPlayerSide] ?? 0;
      showRuleNotice(`${banLabel}禁着，请变招（已违规 ${count} 次，满 3 次判负）`);
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
    if (isCheck && !isGameOver) {
      await playJiangJunSound();
    } else if (captured !== -1) {
      await playSound('eat');
    } else {
      await playSound('go');
    }

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
      // 走棋方不一定获胜（长将/长捉判负、不变作和）→ 统一由引擎判定胜方
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
        } else {
          // 残局闯关：玩家走棋被判负（如长将未变招）或和棋 → 挑战失败
          endgameResultRef.current = 'lose';
          deleteEndgameBattle();
        }
      } else {
        deleteSave(); // 人机对战终局：仅清人机枪局存档
        savePveReplay(newState, playerWon); // 玩家走棋终局：按真实胜负保存复盘
      }
      // 按真实胜负播放结算音效（和棋不播胜负音效）
      if (!isDraw) {
        await playSound(playerWon ? 'gamewin' : 'gamelose');
      }
      return;
    }

    // AI 走棋：若玩家这步触发了特效，等特效完整播完再让 AI 落子，
    // 避免 AI 秒回导致特效被下一步棋的特效/棋盘变化打断；无特效时保持 300ms 的轻思考停顿
    const aiDelay = shownEffect ? MOVE_EFFECT_DURATION_MS[shownEffect] + 120 : 300;
    scheduleAIMove(newState, aiDelay);
  }, [gameState, triggerAIMove, clearHint, isEndgame, currentEndgame, endgameHintLeft, triggerMoveEffect, savePveReplay, playerSideTag, scheduleAIMove, showRuleNotice, currentPlayerSide]);

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
  const confirmRestart = useCallback(() => {
    setShowRestartConfirm(false);
    invalidatePendingAI(); // 取消延时中/计算中的旧局 AI 走子，防止覆盖重开后的局面
    clearHint();
    cancelHintPonder(); // 中止旧局面的后台预计算
    const newState = isEndgame && currentEndgame
      ? buildEndgameState(currentEndgame.fen)
      : (() => {
          const s = createInitialState(initialSideTag);
          s.zobristHash = computeZobristHash(s);
          clearHistoryHash();
          recordHistoryHash(s);
          return s;
        })();
    setGameState(newState);
    setSelectedPieceId(null);
    setValidMoves(null);
    setLastMove(null);
    setMoveCount(0);
    setCapturedRed(0);
    setCapturedBlack(0);
    setIsFlipped(currentPlayerSide === 'black');
    setJueShaVisible(false);
    setGameOverReason(null);
    endgameResultRef.current = null;
    replaySavedRef.current = false; // 新一局允许再次自动保存复盘
    setEndgameHintLeft(ENDGAME_HINT_LIMIT); // 残局提示次数重置
    setEndgameUndoLeft(ENDGAME_UNDO_LIMIT); // 残局悔棋次数同步重置

    if (aiFirst) {
      scheduleAIMove(newState, 500);
    } else {
      // 玩家先手：后台预计算提示
      precomputeHint(newState);
    }
  }, [currentPlayerSide, initialSideTag, aiFirst, clearHint, isEndgame, currentEndgame, buildEndgameState, invalidatePendingAI, scheduleAIMove]);

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
  const handlePlayAgain = useCallback(() => {
    invalidatePendingAI(); // 取消延时中/计算中的旧局 AI 走子
    clearHint();
    cancelHintPonder(); // 中止旧局面的后台预计算
    const newState = isEndgame && currentEndgame
      ? buildEndgameState(currentEndgame.fen)
      : (() => {
          const s = createInitialState(initialSideTag);
          s.zobristHash = computeZobristHash(s);
          clearHistoryHash();
          recordHistoryHash(s);
          return s;
        })();
    setGameState(newState);
    setSelectedPieceId(null);
    setValidMoves(null);
    setLastMove(null);
    setMoveCount(0);
    setCapturedRed(0);
    setCapturedBlack(0);
    setIsFlipped(currentPlayerSide === 'black');
    setGameOverReason(null);
    setJueShaVisible(false);
    endgameResultRef.current = null;
    replaySavedRef.current = false; // 新一局允许再次自动保存复盘
    setEndgameHintLeft(ENDGAME_HINT_LIMIT); // 残局提示次数重置
    setEndgameUndoLeft(ENDGAME_UNDO_LIMIT); // 残局悔棋次数同步重置
    if (aiFirst) {
      scheduleAIMove(newState, 500);
    } else {
      // 玩家先手：后台预计算提示
      precomputeHint(newState);
    }
  }, [currentPlayerSide, initialSideTag, aiFirst, clearHint, isEndgame, currentEndgame, buildEndgameState, invalidatePendingAI, scheduleAIMove]);

  // 残局闯关：进入下一关（原地重置棋盘为新关 FEN，避免同路由导航的状态复用问题）
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
    clearHint();
    cancelHintPonder();
    invalidatePendingAI(); // 取消旧关卡延时中/计算中的 AI 走子
    setCurrentEndgame(next);
    const newState = buildEndgameState(next.fen);
    setGameState(newState);
    setSelectedPieceId(null);
    setValidMoves(null);
    setLastMove(null);
    setMoveCount(0);
    setCapturedRed(0);
    setCapturedBlack(0);
    setIsFlipped(false);
    setGameOverReason(null);
    setJueShaVisible(false);
    endgameResultRef.current = null;
    replaySavedRef.current = false; // 新一局允许再次自动保存复盘
    setEndgameHintLeft(ENDGAME_HINT_LIMIT); // 残局提示次数重置
    setEndgameUndoLeft(ENDGAME_UNDO_LIMIT); // 残局悔棋次数同步重置
    setBoardKey(k => k + 1);
    // 下一关 FEN 若为黑先（AI 先走），自动触发 AI
    if (next.fen.trim().split(/\s+/)[1] === 'b') {
      scheduleAIMove(newState, 500);
    }
  }, [currentEndgame, clearHint, buildEndgameState, invalidatePendingAI, scheduleAIMove]);

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
  const onlineAiStatus = getOnlineAiStatus();
  // 开局库命中时服务端 depth 恒为 0，展示"开局库"而非误导性的"深度0"；
  // 皮卡鱼搜索才展示真实深度（且深度>0 才显示，兜底避免异常 0 值）
  const aiChipLabel = aiIsOnline
    ? (aiEngine === 'book'
        ? '皮卡鱼（开局库）'
        : (aiDepth != null && aiDepth > 0 ? `皮卡鱼（深度${aiDepth}）` : '皮卡鱼'))
    : `本地AI（${difficultyLabel}）${onlineAiStatus === 'circuit' ? '（重连中）' : ''}`;

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
                ? `${currentEndgame.name} · 大师难度\n第 ${Math.ceil(moveCount / 2) + 1} 回合`
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
            <View style={[styles.aiNameRow, nameRowStyle]} pointerEvents="none">
              <View style={styles.aiNameChip}>
                <View style={[styles.aiNameChipDot, aiIsOnline && styles.aiNameChipDotOnline]} />
                <Text style={styles.aiNameChipText} numberOfLines={1}>
                  {aiChipLabel}
                </Text>
              </View>
            </View>

            {/* 长将长捉规则提示横幅（方案 12 文案）：接近阈值/禁着/违规警告 */}
            {ruleNotice && !jueShaVisible && (
              <View style={styles.ruleNoticeBanner}>
                <FontAwesome6 name="triangle-exclamation" size={14} color="#8a5a00" />
                <Text style={styles.ruleNoticeText}>{ruleNotice}</Text>
              </View>
            )}

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
              banMoves={
                gameState.ruleState?.banActive &&
                gameState.ruleState.banSide === (currentPlayerSide === 'red' ? RED_SIDE : BLACK_SIDE) &&
                gameState.sideTag === (currentPlayerSide === 'red' ? RED_SIDE : BLACK_SIDE)
                  ? gameState.ruleState.banMoves
                  : null
              }
              onBoardLayout={setBoardSize}
            />
            </View>

          {/* 底部操作栏（绝杀特效显示时隐藏但保持占位，防止棋盘位置移动）
              残局闯关规则：不允许翻转；每局限 3 次提示（走皮卡鱼）+ 10 次悔棋，
              剩余次数以按钮右上角数字角标展示；「说明」已移至标题行右侧标识 */}
          <View
            style={[styles.bottomBar, bottomBarWidthStyle, { marginTop: dynamicGap }, jueShaVisible && { opacity: 0 }]}
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
          // 残局闯关结算：胜利 → 下一关（若有）+ 返回选关；失败/和棋 → 重新挑战 + 返回选关
          if (isEndgame && currentEndgame) {
            const won = endgameResultRef.current === 'win';
            const hasNext = currentEndgame.levelIndex >= 0 && currentEndgame.levelIndex + 1 < BUILTIN_ENDGAMES.length;
            return (
              <JueShaOverlay
                visible={jueShaVisible}
                boardFrame={jueshaBoardFrame}
                showEffect={showJueEffect}
                resultText={won ? '闯关成功！' : isDrawGame ? drawText : '挑战失败，再接再厉！'}
                onNextLevel={won && hasNext ? handleNextLevel : undefined}
                onPlayAgain={won && hasNext ? undefined : handlePlayAgain}
                primaryText={won ? '再玩一次' : '重新挑战'}
                onGoHome={() => router.back()}
                secondaryText="返回选关"
              />
            );
          }
          // 规则终局的判负方：gameStatus 的胜方对面即违规方（长将/长捉）
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
                  : gameOverReason === 'changzhuo'
                  ? ruleLoserName + '长捉判负！'
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
      <Modal
        visible={endgameInfoVisible}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setEndgameInfoVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {currentEndgame
                ? `${currentEndgame.customId ? '自定义残局' : `第${currentEndgame.levelIndex + 1}关`} · ${currentEndgame.name}`
                : '残局说明'}
            </Text>
            <Text style={styles.modalMessage}>
              {currentEndgame?.comment?.trim() ? currentEndgame.comment : '本关无特别说明，将杀对方即获胜。'}
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalButton}
                onPress={() => setEndgameInfoVisible(false)}
              >
                <Text style={styles.modalButtonText}>知道了</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 重开确认弹窗 */}
      <Modal
        visible={showRestartConfirm}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setShowRestartConfirm(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>确认重开</Text>
            <Text style={styles.modalMessage}>当前对局将丢失，确定要重新开始吗？</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonSecondary]}
                onPress={() => setShowRestartConfirm(false)}
              >
                <Text style={styles.modalButtonSecondaryText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalButton}
                onPress={confirmRestart}
              >
                <Text style={styles.modalButtonText}>确定</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 返回确认弹窗 */}
      <Modal
        visible={showBackConfirm}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setShowBackConfirm(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>保存对局</Text>
            <Text style={styles.modalMessage}>是否保存当前对局，以便下次继续？</Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonSecondary]}
                onPress={confirmBackWithoutSave}
              >
                <Text style={styles.modalButtonSecondaryText}>不保存</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalButton}
                onPress={confirmBackWithSave}
              >
                <Text style={styles.modalButtonText}>保存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // 长将长捉规则提示横幅（接近阈值/禁着/违规警告）
  ruleNoticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'center',
    backgroundColor: '#FFF7E0',
    borderWidth: 1,
    borderColor: '#E8C96A',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 6,
    maxWidth: '92%',
  },
  ruleNoticeText: {
    fontSize: FONT.body,
    color: '#8a5a00',
    flexShrink: 1,
  },
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
    maxWidth: '60%',
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
  capturedBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    paddingHorizontal: 24,
    marginBottom: 8,
  },
  capturedSide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  capturedLabel: {
    fontSize: FONT.caption,
    fontWeight: '500',
  },
  capturedCount: {
    fontSize: FONT.body,
    fontWeight: '700',
    color: COLORS.text,
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
  gameOverOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  gameOverCard: {
    backgroundColor: COLORS.bgCard,
    borderRadius: 20,
    padding: 32,
    marginHorizontal: 40,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  gameOverTitle: {
    fontSize: FONT.displayLg,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 8,
  },
  gameOverMessage: {
    fontSize: FONT.body,
    color: COLORS.textMuted,
    marginBottom: 24,
  },
  gameOverButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  gameOverButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  gameOverButtonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  gameOverButtonText: {
    fontSize: FONT.control,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  gameOverButtonSecondaryText: {
    color: COLORS.primary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    backgroundColor: COLORS.bgCard,
    borderRadius: 20,
    padding: 24,
    marginHorizontal: 40,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
    minWidth: 280,
  },
  modalTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 12,
  },
  modalMessage: {
    fontSize: FONT.body,
    color: COLORS.textMuted,
    marginBottom: 24,
    textAlign: 'center',
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  modalButton: {
    flex: 1,
    backgroundColor: COLORS.primary,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalButtonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  modalButtonText: {
    fontSize: FONT.control,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  modalButtonSecondaryText: {
    fontSize: FONT.body,
    fontWeight: '600',
    color: COLORS.text,
  },
});
