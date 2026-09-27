import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Animated,
  Easing,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { FontAwesome6 } from '@expo/vector-icons';
import { type GameState } from '@/utils/chess/GameEngine';
import { RED_SIDE, type SideTag } from '@/utils/chess/types';
import ChessBoard, { CapturedPiecesDrawer } from '@/components/ChessBoard';
import { useMoveEffect } from '@/hooks/useMoveEffect';
import { playJiangJunSound, playSound, preloadSounds, unloadAllSounds } from '@/utils/SoundManager';
import { getOnlineServerUrl } from '@/utils/serverConfig';
import { BattleSocket } from '@/utils/battleSocket';
import { useBoardLayoutBudget, capHostHeightToViewport } from '@/utils/chess/capturedDrawerMetrics';
import { boardAlignedRowStyle } from '@/utils/chess/boardContentWidth';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
import { Z_INDEX, ELEVATION } from '@/constants/modal';
import { FONT } from '@/utils/typography';

const COLORS = {
  background: '#F5F0E8',
  card: '#FFF8F0',
  primary: '#8B6914',
  danger: '#C62828',
  textPrimary: '#3E2723',
  textSecondary: '#5D4037',
  textLight: '#8D6E63',
  borderSolid: '#D7CCC8',
  success: '#2E7D32',
  redPiece: '#B22222',
  blackPiece: '#2C2C2C',
};

const screenWidth = Dimensions.get('window').width;
// 窗口高度：用于把棋盘宿主实测高度封顶到视口内，打断宽屏纵向溢出的正反馈
const windowHeight = Dimensions.get('window').height;

interface RoomPlayer {
  id: string;
  name: string;
  side: string | null;
  ready: boolean;
}

// 服务端权威钟面（毫秒）+ 插值锚点：与在线对局同口径，观战端据此展示双方局时
interface ClockSnap {
  red: number;
  black: number;
  lastMoveTime: number;
  sideTag: SideTag;
  clockPausedAt: number | null;
}

// 结算后「已返回房间」记录：观战端用于感知对局是否即将重开（不参与对局，仅提示）
interface ReturnedRecord {
  [playerId: string]: number;
}

// 单条表情本地展示时长（毫秒）：与在线对局一致，弹入 → 停留 → 淡出后移除
const EMOJI_DISPLAY_MS = 4000;

// 表情气泡：弹入 → 停留 → 淡出缩小（与 lanBattle 同款，观战端复用同一视觉）
function EmojiBubble({ emoji, lifetime }: { emoji: string; lifetime: number }) {
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.sequence([
      Animated.timing(anim, {
        toValue: 1,
        duration: 240,
        easing: Easing.out(Easing.back(1.6)),
        useNativeDriver: true,
      }),
      Animated.delay(Math.max(0, lifetime - 640)),
      Animated.timing(anim, { toValue: 0, duration: 380, useNativeDriver: true }),
    ]).start();
  }, [anim, lifetime]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.emojiBubble, { opacity: anim, transform: [{ scale: anim }] }]}
    >
      <Text style={styles.emojiBubbleText}>{emoji}</Text>
    </Animated.View>
  );
}

// 观战阶段：连接中 / 对局进行中 / 对局已结束 / 对局已重开 / 出错
type SpectatePhase = 'connecting' | 'playing' | 'ended' | 'restarted' | 'error';

export default function SpectateScreen() {
  const router = useSafeRouter();
  // 安全区：Screen 已在内容之外施加，预算封顶时需据此扣减可用高度
  const insets = useSafeAreaInsets();
  const params = useSafeSearchParams<{ roomId: string; roomName?: string }>();
  const roomId = params.roomId || '';
  const roomName = params.roomName || '';

  const [phase, setPhase] = useState<SpectatePhase>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [players, setPlayers] = useState<RoomPlayer[]>([]);
  const [spectatorCount, setSpectatorCount] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);
  const [winner, setWinner] = useState<string | null>(null);
  // 局时/步时（与在线对局同源同口径）：
  // clockSnapRef 存服务端权威钟面 + 锚点，1s 本地插值出展示文案；turnTimeLimit/turnTimeLeft
  // 为步时（单回合）限制，锚点为 lastMoveTime。此前观战端完全没有时钟，这是缺失功能的根因。
  const clockSnapRef = useRef<ClockSnap | null>(null);
  const [clockText, setClockText] = useState<{ red: string | null; black: string | null; redUrgent: boolean; blackUrgent: boolean }>({ red: null, black: null, redUrgent: false, blackUrgent: false });
  const [turnTimeLimit, setTurnTimeLimit] = useState(0); // 秒，0=不限时
  const [turnTimeLeft, setTurnTimeLeft] = useState(0);
  const lastMoveTimeRef = useRef<number>(0);
  const serverTimeOffsetRef = useRef(0);
  // 房间读秒时长（byoyomi）：基本用时耗尽后展示「读 M:SS」
  const byoyomiRef = useRef(0);
  // 活跃表情：按首次接收时间本地计时，超时移除（与服务端 EMOJI_TTL 无关，纯展示生命周期）
  const [activeEmojis, setActiveEmojis] = useState<{ id: string; playerId: string; emoji: string; receivedAt: number }[]>([]);
  const seenEmojiIdsRef = useRef<Set<string>>(new Set());

  const { moveEffect, triggerMoveEffect } = useMoveEffect();
  const seenHistoryLenRef = useRef(0);
  // 被吃棋子明细抽屉展开的一侧（null=收起），抽屉渲染在顶部标题行正下方（与人机对战一致）
  const [capturedDrawerSide, setCapturedDrawerSide] = useState<'opponent' | 'mine' | null>(null);
  const phaseRef = useRef<SpectatePhase>('connecting');
  const mountedRef = useRef(true);
  // 观众身份 ID 必须全程稳定：心跳靠它续期、离场靠它注销，每次现生成会导致服务端无法匹配
  const spectatorIdRef = useRef(`spec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  // 观战 WebSocket：实时接收对局状态推送（替代轮询），断线自动重连由 BattleSocket 内部处理
  const spectateSocketRef = useRef<BattleSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  // 棋盘区域尺寸测算（与人机/在线对局一致的居中布局）
  const [boardAreaH, setBoardAreaH] = useState(0);
  const [bottomBarH, setBottomBarH] = useState(0);
  // 棋盘内容宿主顶边相对页面内容顶边的 Y（含顶部栏与顶部安全区）：预算封顶时用于推算可用高度
  const [drawerHostY, setDrawerHostY] = useState(0);
  const dynamicGap = Math.max(Math.round(screenWidth * 0.03), 8);
  // 当前棋盘样式：角标行宽度需按样式几何换算棋盘本体宽度
  const boardStyle = useBoardStyle();
  // 棋盘高度预算 + 垂直定位留白（二分求解，口径与抽屉真实尺寸一致）：
  // 条件 1 —— 棋盘顶边上方常驻预留「名称角标行(30) + 摘要条悬浮区(38+30) + 抽屉展开高度」，
  //           无论抽屉是否点开都预留，保证展开时底边不压棋盘、不与摘要条/角标重叠；
  // 条件 2 —— 内容（上角标行 + 棋盘 + 下角标行）在宿主内垂直居中；居中时上方预留不足则整体
  //           下移贴住预留区（把下方空白让给棋盘），棋盘取到预留允许的最大尺寸。
  // 底部信息栏在宿主之外（宿主高本身已不含它，不再重复扣减），下方流内占位仅计下方名称角标行(26+2×2=30)。
  // 宿主未测得时维持返回 0 的既有行为（载入占位框依赖该数值）。
  // hostHeight 经视口封顶：Screen 的 flexGrow 容器会让 flex:1 宿主按内容撑开，
  // 不封顶则「宿主变大 → 棋盘变大 → 内容更高」正反馈会让宽屏页面纵向溢出
  // （详见 capHostHeightToViewport 注释）。本屏底部信息栏在宿主之外，需作为
  // belowHostHeight 扣减（宿主内只含上下两行名称角标行，已由 top/bottomFlowHeight 计入）。
  const { maxBoardHeight: budgetBoardHeight, paddingTop: boardPadTop } = useBoardLayoutBudget({
    hostHeight: capHostHeightToViewport(
      boardAreaH,
      windowHeight,
      drawerHostY,
      insets.top,
      insets.bottom,
      dynamicGap + bottomBarH
    ),
    screenWidth,
    stripOffset: 30,
    topFlowHeight: 30,
    bottomFlowHeight: 30,
  });
  const maxBoardHeight = budgetBoardHeight ?? 0;

  // 名称角标行宽度：取棋盘本体宽度并水平居中，使角标行左右边缘与棋盘边缘对齐
  // （宽屏下棋盘因纵向预算被压缩居中，角标行若铺满整屏会贴到屏幕最左/最右）
  const nameRowStyle = useMemo(
    () => boardAlignedRowStyle(screenWidth, boardStyle, maxBoardHeight),
    [boardStyle, maxBoardHeight]
  );

  // 底部信息栏宽度：同样跟随棋盘本体宽度居中，宽屏下不再横贯整个屏幕
  const bottomBarWidthStyle = useMemo(
    () => boardAlignedRowStyle(screenWidth, boardStyle, maxBoardHeight),
    [boardStyle, maxBoardHeight]
  );

  const setPhaseSafe = useCallback((p: SpectatePhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  // 应用服务端返回的对局快照：更新局面、玩家、阶段，并检测新走棋触发特效
  const applySnapshot = useCallback((data: {
    gameState?: GameState | null;
    players?: RoomPlayer[];
    phase?: string;
    winner?: string | null;
    spectatorCount?: number;
    clocks?: { red: number; black: number } | null;
    clockPausedAt?: number | null;
    lastMoveTime?: number;
    serverNow?: number;
    settings?: { turnTimeLimit?: number; byoyomiSeconds?: number } | null;
    emojiMessages?: { id: string; playerId: string; emoji: string }[];
    returnedToRoom?: ReturnedRecord;
  }) => {
    if (!mountedRef.current) return;

    if (Array.isArray(data.players)) setPlayers(data.players);
    if (typeof data.spectatorCount === 'number') setSpectatorCount(data.spectatorCount);

    // 服务端时钟校正：所有与服务端时间戳的比较统一走校正时间（否则局时/步时会随时钟漂移）
    if (typeof data.serverNow === 'number') {
      serverTimeOffsetRef.current = data.serverNow - Date.now();
    }

    // 房间读秒与步时设置同步
    if (data.settings) {
      if (typeof data.settings.turnTimeLimit === 'number') setTurnTimeLimit(data.settings.turnTimeLimit);
      if (typeof data.settings.byoyomiSeconds === 'number') byoyomiRef.current = data.settings.byoyomiSeconds;
    }

    // 表情同步：服务端按 id 下发，本地按 id 去重（WS 与轮询双通道都会带，按 id 幂等）
    if (Array.isArray(data.emojiMessages)) {
      for (const m of data.emojiMessages) {
        if (!m || typeof m.id !== 'string' || typeof m.emoji !== 'string') continue;
        if (seenEmojiIdsRef.current.has(m.id)) continue;
        seenEmojiIdsRef.current.add(m.id);
        setActiveEmojis(prev =>
          [...prev, { id: m.id, playerId: m.playerId, emoji: m.emoji, receivedAt: Date.now() }]
        );
      }
    }

    // 步时倒计时锚点：对方走棋/悔棋后服务端刷新 lastMoveTime
    if (typeof data.lastMoveTime === 'number' && data.lastMoveTime > 0) {
      lastMoveTimeRef.current = data.lastMoveTime;
    }

    // 局时钟面快照（服务端权威毫秒 + 锚点）：与在线对局同口径，本地 1s 插值展示
    if (data.clocks && typeof data.clocks.red === 'number' && typeof data.clocks.black === 'number' && data.gameState) {
      clockSnapRef.current = {
        red: data.clocks.red,
        black: data.clocks.black,
        lastMoveTime: typeof data.lastMoveTime === 'number' ? data.lastMoveTime : Date.now(),
        sideTag: data.gameState.sideTag,
        clockPausedAt: typeof data.clockPausedAt === 'number' ? data.clockPausedAt : null,
      };
    } else if (!data.clocks) {
      // 对局未启用局时（或房间被重置）：清空展示，避免残留上一局残留时间
      clockSnapRef.current = null;
    }

    // 对局阶段流转
    if (data.phase === 'ended') {
      setWinner(data.winner ?? null);
      setPhaseSafe('ended');
    } else if (data.phase === 'waiting') {
      // 对局被重新开一局（rematch），观战结束
      if (phaseRef.current === 'playing' || phaseRef.current === 'ended') {
        setPhaseSafe('restarted');
      }
    } else if (data.phase === 'playing') {
      setPhaseSafe('playing');
    }

    if (data.gameState) {
      const newState = data.gameState;
      setGameState(newState);

      // 走棋检测：着法数增加 → 触发吃子/将军特效与音效
      const historyLen = newState.moveHistory.length;
      if (historyLen > seenHistoryLenRef.current) {
        const last = newState.moveHistory[historyLen - 1];
        triggerMoveEffect(last.capturedPieceId, newState.isCheck, data.phase === 'ended');
        // 走子音效：将军时播男声将军语音（内置节流），否则吃子/走子音（终局不播）
        if (data.phase !== 'ended') {
          if (newState.isCheck) {
            playJiangJunSound();
          } else if (last.capturedPieceId !== -1) {
            playSound('eat');
          } else {
            playSound('go');
          }
        }
        seenHistoryLenRef.current = historyLen;
      } else if (historyLen < seenHistoryLenRef.current) {
        seenHistoryLenRef.current = historyLen;
      }
    }
  }, [setPhaseSafe, triggerMoveEffect]);

  // 局时展示：服务端快照为锚点做 1s 本地插值（仅走棋方钟走动；悔棋/求和协商期以暂停锚点冻结）
  // 观战端不做任何超时判负——判负由服务端裁定，观战只如实呈现钟面。
  useEffect(() => {
    if (phase !== 'playing') return undefined;

    const formatClock = (ms: number): string => {
      const totalSec = Math.max(0, Math.ceil(ms / 1000));
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const tick = () => {
      const snap = clockSnapRef.current;
      if (!snap) {
        setClockText(prev => (prev.red === null && prev.black === null ? prev : { red: null, black: null, redUrgent: false, blackUrgent: false }));
        return;
      }
      const correctedNow = Date.now() + serverTimeOffsetRef.current;
      const anchorNow = snap.clockPausedAt ?? correctedNow;
      const elapsed = Math.max(0, anchorNow - snap.lastMoveTime);
      const toMove: 'red' | 'black' = snap.sideTag === RED_SIDE ? 'red' : 'black';
      const byoMs = byoyomiRef.current * 1000;

      const displayFor = (color: 'red' | 'black'): { text: string; urgent: boolean } => {
        const moving = toMove === color;
        const net = moving ? snap[color] - elapsed : snap[color];
        if (net > 0) return { text: formatClock(net), urgent: moving && net <= 30000 };
        if (byoMs > 0) {
          const byoRemain = moving ? byoMs + net : byoMs;
          return { text: `读${formatClock(byoRemain)}`, urgent: moving && byoRemain <= 10000 };
        }
        return { text: formatClock(0), urgent: moving };
      };

      const redD = displayFor('red');
      const blackD = displayFor('black');
      setClockText(prev =>
        prev.red === redD.text && prev.black === blackD.text && prev.redUrgent === redD.urgent && prev.blackUrgent === blackD.urgent
          ? prev
          : { red: redD.text, black: blackD.text, redUrgent: redD.urgent, blackUrgent: blackD.urgent }
      );
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // 步时（单回合）倒计时：锚点为服务端 lastMoveTime，对局开启限时步时才有值
  useEffect(() => {
    if (phase !== 'playing' || turnTimeLimit <= 0) return undefined;
    const tick = () => {
      const correctedNow = Date.now() + serverTimeOffsetRef.current;
      const elapsed = Math.floor(Math.max(0, correctedNow - lastMoveTimeRef.current) / 1000);
      setTurnTimeLeft(Math.max(0, turnTimeLimit - elapsed));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [phase, turnTimeLimit]);

  // 表情生命周期：超过展示时长即移除（观战端不发送表情，只接收展示）
  useEffect(() => {
    if (activeEmojis.length === 0) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      setActiveEmojis(prev => prev.filter(e => now - e.receivedAt <= EMOJI_DISPLAY_MS + 400));
    }, 500);
    return () => clearInterval(timer);
  }, [activeEmojis.length]);

  // applySnapshot 的最新引用（供 WS/轮询回调使用，避免把不稳定的依赖塞进 effect 依赖数组）
  const applySnapshotRef = useRef(applySnapshot);
  useEffect(() => {
    applySnapshotRef.current = applySnapshot;
  });

  // 预加载常用音效并预热音频模式（观战同样播放走子音效，避免首声漏播）；退出观战时释放全部音效
  useEffect(() => {
    preloadSounds();
    return () => { unloadAllSounds(); };
  }, []);

  // 进入观战：注册观战者并拉取初始快照
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    const enter = async () => {
      try {
        const base = await getOnlineServerUrl();
        const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}/spectate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spectatorId: spectatorIdRef.current, spectatorName: '观众' }),
        });
        const data = await response.json();
        if (cancelled) return;
        if (!data.success) {
          setErrorMsg(data.message || '无法进入观战');
          setPhaseSafe('error');
          return;
        }
        applySnapshot(data);
        // 若尚未拿到局面（对局刚开始、初始局面未上传），保持连接中等待轮询补齐
        if (!data.gameState) setPhaseSafe('connecting');
      } catch {
        if (!cancelled) {
          setErrorMsg('网络异常，无法进入观战');
          setPhaseSafe('error');
        }
      }
    };

    enter();
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [roomId, applySnapshot, setPhaseSafe]);

  // 观战 WebSocket：实时接收对局状态推送（替代轮询）；断线自动重连由 BattleSocket 内部处理
  useEffect(() => {
    if (!roomId) return undefined;
    const socket = new BattleSocket(
      roomId,
      spectatorIdRef.current,
      {
        onState: data => applySnapshotRef.current(data),
        onStatusChange: connected => setWsConnected(connected),
        onFatalError: message => {
          setErrorMsg(message || '无法进入观战');
          setPhaseSafe('error');
        },
      },
      'spectator',
    );
    spectateSocketRef.current = socket;
    socket.connect();
    return () => {
      spectateSocketRef.current = null;
      socket.close();
    };
  }, [roomId, setPhaseSafe]);

  // 轮询对局状态（开放端点）：WebSocket 兜底通道，仅在 WS 未连接时启用
  useEffect(() => {
    if (!roomId) return undefined;
    if (wsConnected) return undefined; // WS 已连接时由服务端推送驱动，无需轮询
    let inFlight = false; // 并发防护：慢网下跳过重叠请求，避免旧响应乱序覆盖
    const timer = setInterval(async () => {
      if (phaseRef.current === 'ended' || phaseRef.current === 'restarted' || phaseRef.current === 'error') {
        return;
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const base = await getOnlineServerUrl();
        const response = await fetch(`${base}/api/v1/lan/rooms/${roomId}/gameState`);
        if (!response.ok) return;
        const data = await response.json();
        // GET /gameState 返回的是对局负载本体（无 success 包装字段），
        // 旧写法 if (data.success) 恒为假，导致 WS 断线后的轮询兜底从未生效
        if (data && Array.isArray(data.players)) applySnapshotRef.current(data);
      } catch {
        // 轮询瞬时失败忽略，下一轮重试
      } finally {
        inFlight = false;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [roomId, wsConnected]);

  // 观战心跳：保持在观众计数中
  useEffect(() => {
    if (!roomId) return undefined;
    const timer = setInterval(async () => {
      if (phaseRef.current === 'ended' || phaseRef.current === 'restarted' || phaseRef.current === 'error') return;
      try {
        const base = await getOnlineServerUrl();
        await fetch(`${base}/api/v1/lan/rooms/${roomId}/spectate/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spectatorId: spectatorIdRef.current }),
        });
      } catch {
        // 心跳失败忽略
      }
    }, 10000);
    return () => clearInterval(timer);
  }, [roomId]);

  const handleExit = useCallback(() => {
    // 关闭观战 WS（服务端会随即从观众列表移除该观战者）
    if (spectateSocketRef.current) {
      spectateSocketRef.current.close();
      spectateSocketRef.current = null;
    }
    // 尽力以 HTTP 兜底通知服务端移除观战者（失败不影响退出）
    (async () => {
      try {
        const base = await getOnlineServerUrl();
        await fetch(`${base}/api/v1/lan/rooms/${roomId}/spectate/leave`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ spectatorId: spectatorIdRef.current }),
        });
      } catch {
        // 忽略
      }
    })();
    if (router.canGoBack()) router.back();
    else router.replace('/lanGame');
  }, [roomId, router]);

  // 玩家信息
  const redPlayer = players.find(p => p.side === 'red') || null;
  const blackPlayer = players.find(p => p.side === 'black') || null;
  // 依据棋盘朝向决定上下方显示的玩家（未翻转：红下黑上；翻转：黑下红上）
  const topPlayer = isFlipped ? redPlayer : blackPlayer;
  const bottomPlayer = isFlipped ? blackPlayer : redPlayer;
  const isRedTurn = gameState ? gameState.sideTag === RED_SIDE : false;

  // 被吃棋子统计
  const capturedByRed: number[] = [];
  const capturedByBlack: number[] = [];
  if (gameState) {
    gameState.pieces.forEach(piece => {
      if (!piece.alive) {
        if (piece.id < 16) capturedByRed.push(piece.id);
        else capturedByBlack.push(piece.id);
      }
    });
  }

  const lastMove = gameState && gameState.moveHistory.length > 0
    ? (() => {
        const m = gameState.moveHistory[gameState.moveHistory.length - 1];
        return { fromCol: m.fromCol, fromRow: m.fromRow, toCol: m.toCol, toRow: m.toRow };
      })()
    : null;

  const moveCount = gameState ? gameState.moveHistory.length : 0;

  // 步时倒计时文案（与 lanBattle 的 formatTurnClock 同口径）
  const formatTurnClock = (totalSeconds: number): string => {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // 按玩家过滤表情：观战端只展示对局双方发送的表情
  const topEmojis = useMemo(
    () => activeEmojis.filter(e => e.playerId === topPlayer?.id),
    [activeEmojis, topPlayer?.id]
  );
  const bottomEmojis = useMemo(
    () => activeEmojis.filter(e => e.playerId === bottomPlayer?.id),
    [activeEmojis, bottomPlayer?.id]
  );

  // 局时按实际执棋方映射到上下行（未翻转：红下黑上；翻转：黑下红上）
  const topClock = isFlipped ? clockText.red : clockText.black;
  const topUrgent = isFlipped ? clockText.redUrgent : clockText.blackUrgent;
  const bottomClock = isFlipped ? clockText.black : clockText.red;
  const bottomUrgent = isFlipped ? clockText.blackUrgent : clockText.redUrgent;

  // 名字角标（带行棋指示 + 局时 + 表情）
  // 布局与在线对局一致：顶行「名称 → 局时 → 表情 →····→ 步时（右对齐）」，底行镜像。
  // 局时/步时此前观战端完全没有，是用户反馈的「观战看不到双方局时和步时」。
  const renderNameChip = (
    player: RoomPlayer | null,
    side: 'red' | 'black',
    align: 'left' | 'right',
    clock: { text: string | null; urgent: boolean },
    emojis: { id: string; emoji: string }[],
  ) => {
    const isTurn = gameState ? (side === 'red' ? isRedTurn : !isRedTurn) : false;
    // 顶行是普通 row（从左到右），底行是 nameRowMe 右对齐镜像。两者视觉顺序相反：
    //   顶行：名称 → 局时 → 表情 →····→ 步时（行尾）
    //   底行：表情 → 局时 → 名称（右对齐）
    // 局时紧贴名称：顶行用 marginLeft 落在名称右侧，底行用 marginRight 落在名称左侧，
    // nameRow 没有 gap，两侧间距的唯一来源就是这两个 margin（必须同值，否则两侧不一致）。
    const nameChip = (
      <View style={styles.nameChip}>
        {align === 'left' && (
          <View style={[styles.nameChipDot, { backgroundColor: side === 'red' ? COLORS.redPiece : COLORS.blackPiece }]} />
        )}
        <Text style={styles.nameChipText} numberOfLines={1}>
          {/* 席位缺失即玩家已离场：说「红方/黑方」会把一次离场伪装成正常对局，
              这里显式告知席位空缺的原因。正常对局两端席位齐备，不会走到此分支。 */}
          {player ? player.name : '（玩家已离开）'}
        </Text>
        {isTurn && phase === 'playing' && (
          <View style={[styles.readyTag, styles.readyTagOn]}>
            <Text style={[styles.readyTagText, styles.readyTagTextOn]}>行棋中</Text>
          </View>
        )}
        {align === 'right' && (
          <View style={[styles.nameChipDot, { backgroundColor: side === 'red' ? COLORS.redPiece : COLORS.blackPiece }]} />
        )}
      </View>
    );

    const clockChip = clock.text !== null ? (
      <View style={[styles.nameChip, align === 'right' ? styles.timerChipMine : styles.timerChip]}>
        <FontAwesome6 name="hourglass-half" size={10} color={clock.urgent ? COLORS.danger : COLORS.textLight} />
        <Text style={[styles.timerChipText, clock.urgent && styles.timerChipTextUrgent]}>
          {clock.text}
        </Text>
      </View>
    ) : null;

    const emojiBubbles = emojis.map(e => (
      <EmojiBubble key={e.id} emoji={e.emoji} lifetime={EMOJI_DISPLAY_MS} />
    ));

    return (
      <View style={[styles.nameRow, align === 'right' ? styles.nameRowMe : undefined, nameRowStyle]} pointerEvents="none">
        {align === 'right' ? (
          <>
            {emojiBubbles}
            {clockChip}
            {nameChip}
          </>
        ) : (
          <>
            {nameChip}
            {clockChip}
            {emojiBubbles}
            {/* 步时（单回合）倒计时：与对局一致固定在顶行行尾 */}
            {phase === 'playing' && turnTimeLimit > 0 && (
              <View style={[styles.nameChip, styles.timerChipPinned]}>
                <FontAwesome6
                  name="clock"
                  size={11}
                  color={turnTimeLeft <= 30 ? COLORS.danger : COLORS.textLight}
                />
                <Text style={[styles.timerChipText, turnTimeLeft <= 30 && styles.timerChipTextUrgent]}>
                  {formatTurnClock(turnTimeLeft)}
                </Text>
              </View>
            )}
          </>
        )}
      </View>
    );
  };

  return (
    <Screen>
      <View style={styles.container}>
        {/* 顶部信息栏 */}
        <View style={styles.topBar}>
          <View style={styles.backBtnZone}>
            <TouchableOpacity style={styles.backBtn} onPress={handleExit}>
              <FontAwesome6 name="chevron-left" size={20} color={COLORS.textPrimary} />
            </TouchableOpacity>
          </View>

          <View style={styles.gameInfo}>
            <Text style={styles.gameTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
              {roomName || '在线对局'}
            </Text>
            <Text style={styles.gameSubtitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              观战 · {spectatorCount} 人观看
            </Text>
          </View>

          <View style={[styles.backBtnZone, { alignItems: 'flex-end' }]}>
            <TouchableOpacity style={styles.backBtn} onPress={() => setIsFlipped(v => !v)} activeOpacity={0.8}>
              <FontAwesome6 name="rotate" size={18} color={COLORS.textPrimary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* 棋盘区域 */}
        <View
          style={styles.capturedDrawerHost}
          onLayout={(e) => {
            setBoardAreaH(e.nativeEvent.layout.height);
            setDrawerHostY(e.nativeEvent.layout.y);
          }}
        >
          {/* 被吃棋子明细抽屉：点击摘要文字后自标题行向下展开（浮层，棋盘不动），与人机对战一致 */}
          {gameState && (
            <CapturedPiecesDrawer
              side={capturedDrawerSide}
              gameState={gameState}
              playerSide="red"
              maxBoardHeight={maxBoardHeight}
            />
          )}
          {/* 顶部留白由预算控制：优先垂直居中，预留不足时整体下移贴住预留区 */}
          <View style={[styles.boardContainer, { paddingTop: boardPadTop }]}>
            {renderNameChip(
              topPlayer,
              isFlipped ? 'red' : 'black',
              'left',
              { text: topClock, urgent: topUrgent },
              topEmojis,
            )}

            {gameState ? (
              <ChessBoard
                gameState={gameState}
                selectedPieceId={null}
                validMoves={null}
                lastMove={lastMove}
                isFlipped={isFlipped}
                onPiecePress={() => undefined}
                onEmptyPress={() => undefined}
                capturedByRed={capturedByRed}
                capturedByBlack={capturedByBlack}
                playerSide="red"
                maxBoardHeight={maxBoardHeight}
                capturedStripOffset={30}
                onCapturedPress={(side) => setCapturedDrawerSide(prev => (prev === side ? null : side))}
                moveEffect={moveEffect}
              />
            ) : (
              <View style={[styles.loadingBox, { height: Math.max(maxBoardHeight, 240) }]}>
                <Text style={styles.loadingText}>正在载入棋局…</Text>
              </View>
            )}

            {renderNameChip(
              bottomPlayer,
              isFlipped ? 'black' : 'red',
              'right',
              { text: bottomClock, urgent: bottomUrgent },
              bottomEmojis,
            )}
          </View>
        </View>

        {/* 底部信息栏 */}
        <View style={[styles.bottomBar, bottomBarWidthStyle, { marginTop: dynamicGap }]}
          onLayout={(e) => setBottomBarH(e.nativeEvent.layout.height)}
        >
          <View style={styles.infoPill}>
            <FontAwesome6 name="chess-board" size={14} color={COLORS.textLight} />
            <Text style={styles.infoPillText}>第 {Math.floor(moveCount / 2) + 1} 回合 · 共 {moveCount} 步</Text>
          </View>
          <View style={styles.infoPill}>
            <View style={[styles.turnDot, { backgroundColor: isRedTurn ? COLORS.redPiece : COLORS.blackPiece }]} />
            <Text style={styles.infoPillText}>{isRedTurn ? '红方行棋' : '黑方行棋'}</Text>
          </View>
        </View>

        {/* 连接中遮罩 */}
        {phase === 'connecting' && (
          <View style={styles.overlay}>
            <View style={styles.overlayCard}>
              <Text style={styles.overlayTitle}>正在进入观战…</Text>
              <Text style={styles.overlayDesc}>连接对局房间中，请稍候</Text>
            </View>
          </View>
        )}

        {/* 对局结束遮罩 */}
        {phase === 'ended' && (
          <View style={styles.overlay}>
            <View style={styles.overlayCard}>
              <FontAwesome6 name="flag-checkered" size={34} color={COLORS.primary} />
              <Text style={styles.overlayTitle}>对局结束</Text>
              <Text style={styles.overlayDesc}>
                {winner === 'red' ? '红方获胜' : winner === 'black' ? '黑方获胜' : '双方和棋'}
              </Text>
              <TouchableOpacity style={styles.overlayBtn} onPress={handleExit}>
                <Text style={styles.overlayBtnText}>退出观战</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* 对局重开遮罩 */}
        {phase === 'restarted' && (
          <View style={styles.overlay}>
            <View style={styles.overlayCard}>
              <FontAwesome6 name="arrows-rotate" size={34} color={COLORS.primary} />
              <Text style={styles.overlayTitle}>对局已重新开始</Text>
              <Text style={styles.overlayDesc}>双方已开启新一局，本次观战结束</Text>
              <TouchableOpacity style={styles.overlayBtn} onPress={handleExit}>
                <Text style={styles.overlayBtnText}>退出观战</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* 出错遮罩 */}
        {phase === 'error' && (
          <View style={styles.overlay}>
            <View style={styles.overlayCard}>
              <FontAwesome6 name="circle-exclamation" size={34} color={COLORS.danger} />
              <Text style={styles.overlayTitle}>无法观战</Text>
              <Text style={styles.overlayDesc}>{errorMsg}</Text>
              <TouchableOpacity style={styles.overlayBtn} onPress={handleExit}>
                <Text style={styles.overlayBtnText}>返回大厅</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: COLORS.card,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderSolid,
  },
  backBtnZone: {
    width: 56,
    alignItems: 'flex-start',
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.borderSolid,
    backgroundColor: COLORS.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gameInfo: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  gameTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  gameSubtitle: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
    marginTop: 2,
  },
  capturedDrawerHost: {
    flex: 1,
  },
  boardContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  nameRow: {
    height: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 12,
    marginVertical: 2,
  },
  nameRowMe: {
    justifyContent: 'flex-end',
  },
  nameChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.card,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.borderSolid,
    maxWidth: '60%',
  },
  nameChipDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  nameChipText: {
    fontSize: FONT.caption,
    fontWeight: '600',
    color: COLORS.textPrimary,
    flexShrink: 1,
  },
  readyTag: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: 1,
  },
  readyTagOn: {
    borderColor: COLORS.success,
    backgroundColor: 'rgba(46, 125, 50, 0.12)',
  },
  readyTagText: {
    fontSize: FONT.micro,
    fontWeight: '600',
  },
  readyTagTextOn: {
    color: COLORS.success,
  },
  // 局时/步时芯片：与 lanBattle 同款。nameRow 没有 gap，两侧「名称↔局时」间距唯一来源是
  // 各自的 margin——顶行（普通 row）用 marginLeft，底行（右对齐镜像）必须用 marginRight，
  // 否则同一个 marginLeft 会落到底行行尾外侧，造成两侧间距不一致。
  timerChip: {
    marginLeft: 6,
  },
  timerChipMine: {
    marginRight: 6,
  },
  // 步时倒计时固定在顶行行尾
  timerChipPinned: {
    marginLeft: 'auto',
  },
  timerChipText: {
    fontSize: FONT.micro,
    color: COLORS.textLight,
  },
  timerChipTextUrgent: {
    color: COLORS.danger,
  },
  // 表情气泡：观战端只接收展示，不发送（样式与 lanBattle 保持一致）
  emojiBubble: {
    marginHorizontal: 5,
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.borderSolid,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primary,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  emojiBubbleText: {
    // 表情为图形符号，字号随气泡尺寸微调，不套用正文字阶
    fontSize: 18,
    lineHeight: 22,
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  infoPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: COLORS.card,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.borderSolid,
  },
  infoPillText: {
    fontSize: FONT.caption,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  turnDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  loadingBox: {
    width: screenWidth - 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.borderSolid,
  },
  loadingText: {
    fontSize: FONT.body,
    color: COLORS.textLight,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    // 棋盘内部存在 elevation 层，仅 zIndex 不足以盖住，需同时给 elevation
    zIndex: Z_INDEX.drawer,
    elevation: ELEVATION.drawer,
  },
  overlayCard: {
    width: '78%',
    backgroundColor: COLORS.card,
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    gap: 10,
  },
  overlayTitle: {
    fontSize: FONT.title,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  overlayDesc: {
    fontSize: FONT.caption,
    color: COLORS.textLight,
    textAlign: 'center',
  },
  overlayBtn: {
    marginTop: 8,
    backgroundColor: COLORS.primary,
    paddingHorizontal: 28,
    paddingVertical: 11,
    borderRadius: 999,
  },
  overlayBtnText: {
    color: '#FFFFFF',
    fontSize: FONT.control,
    fontWeight: '700',
  },
});
