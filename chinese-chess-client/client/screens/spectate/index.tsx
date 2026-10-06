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
import ChessBoard from '@/components/ChessBoard';
import GameBottomBar, {
  BOTTOM_BAR_HEIGHT,
  type GameBottomBarActionInput,
  type GameMenuItem,
} from '@/components/GameBottomBar';
import { useMoveEffect } from '@/hooks/useMoveEffect';
import { playJiangJunSound, playSound, preloadSounds, unloadAllSounds } from '@/utils/SoundManager';
import { getOnlineServerUrl } from '@/utils/serverConfig';
import { serverNow } from '@/utils/serverClock';
import { BattleSocket } from '@/utils/battleSocket';
import { useBattleStateSync } from '@/hooks/useBattleStateSync';
import { type BattlePlayer } from '@/utils/battleProtocol';
import { useBoardLayoutBudget, capHostHeightToViewport } from '@/utils/chess/boardLayoutBudget';
import { boardAlignedRowStyle } from '@/utils/chess/boardContentWidth';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
import { useBackgroundStyle } from '@/utils/chess/backgroundStyleStore';
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

// 底部信息行（房间名 / 观众数 / 回合进度 / 行棋方）在棋盘宿主之外、纵向流内的占位高度。
// 与 StyleSheet 里 infoRow height 30 + marginBottom 2 保持一致；该行与固定底栏
// 都在棋盘宿主之外，参与 capHostHeightToViewport 的 belowHostHeight 扣减。
// 实测值可用时以实测优先（见下方 infoRowH），常量只作为首帧兜底，避免常量与样式脱节。
const BOARD_INFO_ROW_FLOW_HEIGHT = 32;

// 观战页只读取 id / name / side：直接改用协议层类型，避免本地接口与负载形状重复定义
type RoomPlayer = BattlePlayer;

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
  // 整屏背景（首页「样式设置 → 背景」所选）。未选背景图时不产生任何视觉变化。
  const background = useBackgroundStyle();
  const hasBackground = background.image != null;
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
  // 【C-53】步时限额的镜像 ref：useBattleStateSync 同时会写这个 ref 与 setTurnTimeLimit
  // （见 hook 内 :263 附近），本页原先只传 setter、不传 ref，那个 ref 分支永远不生效。
  const turnTimeLimitRef = useRef(0);
  const lastMoveTimeRef = useRef<number>(0);
  const serverTimeOffsetRef = useRef(0);
  // 房间读秒时长（byoyomi）：基本用时耗尽后展示「读 M:SS」
  const byoyomiRef = useRef(0);
  // 活跃表情：按首次接收时间本地计时，超时移除（与服务端 EMOJI_TTL 无关，纯展示生命周期）
  const [activeEmojis, setActiveEmojis] = useState<{ id: string; playerId: string; emoji: string; receivedAt: number }[]>([]);

  const { moveEffect, triggerMoveEffect } = useMoveEffect();
  const phaseRef = useRef<SpectatePhase>('connecting');
  const mountedRef = useRef(true);
  // 观众身份 ID 必须全程稳定：心跳靠它续期、离场靠它注销，每次现生成会导致服务端无法匹配
  const spectatorIdRef = useRef(`spec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  // 观战 WebSocket：实时接收对局状态推送（替代轮询），断线自动重连由 BattleSocket 内部处理
  const spectateSocketRef = useRef<BattleSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  // 棋盘区域尺寸测算（与人机/在线对局一致的居中布局）
  const [boardAreaH, setBoardAreaH] = useState(0);
  // 棋盘内容宿主顶边相对页面内容顶边的 Y（含顶部安全区）：预算封顶时用于推算可用高度
  const [boardHostY, setBoardHostY] = useState(0);
  // 底部信息行实测高度（棋盘宿主之外，随内容变化）；0 = 未测得，用常量兜底
  const [infoRowH, setInfoRowH] = useState(0);
  const dynamicGap = Math.max(Math.round(screenWidth * 0.03), 8);
  // 当前棋盘样式：角标行宽度需按样式几何换算棋盘本体宽度
  const boardStyle = useBoardStyle();
  // 棋盘高度预算 + 垂直定位留白（口径与对局页一致）：
  // 条件 1 —— 棋盘顶边上方常驻预留「名称角标行(30)」，棋盘取到预留允许的最大尺寸；
  // 条件 2 —— 内容（上角标行 + 棋盘 + 下角标行）在宿主内垂直居中；居中时上方预留不足则整体
  //           下移贴住预留区（把下方空白让给棋盘）。
  // 底部信息行 + 固定底栏在宿主之外（宿主高本身已不含它们），需作为 belowHostHeight 扣减；
  // 宿主内下方流内占位仅计下方名称角标行(26+2×2=30)。
  // 宿主未测得时维持返回 0 的既有行为（载入占位框依赖该数值）。
  // hostHeight 经视口封顶：Screen 的 flexGrow 容器会让 flex:1 宿主按内容撑开，
  // 不封顶则「宿主变大 → 棋盘变大 → 内容更高」正反馈会让宽屏页面纵向溢出
  // （详见 capHostHeightToViewport 注释）。
  // 注意 belowHostHeight 不含 insets.bottom —— capHostHeightToViewport 已扣过 bottomInset。
  const { maxBoardHeight: budgetBoardHeight, paddingTop: boardPadTop } = useBoardLayoutBudget({
    hostHeight: capHostHeightToViewport(
      boardAreaH,
      windowHeight,
      boardHostY,
      insets.top,
      insets.bottom,
      (infoRowH > 0 ? infoRowH : BOARD_INFO_ROW_FLOW_HEIGHT) + dynamicGap + BOTTOM_BAR_HEIGHT
    ),
    screenWidth,
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

  // 底部信息行宽度：同样跟随棋盘本体宽度居中，宽屏下不再横贯整个屏幕
  const bottomBarWidthStyle = useMemo(
    () => boardAlignedRowStyle(screenWidth, boardStyle, maxBoardHeight),
    [boardStyle, maxBoardHeight]
  );

  const setPhaseSafe = useCallback((p: SpectatePhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  // 服务端负载 → 页面状态：与在线对局共用同一实现（hooks/useBattleStateSync）。
  // 合并前本页另有一份 applySnapshot，与 lanBattle 的 applyServerState 已分叉
  // （观战侧无乐观保护、不读 returnedToRoom），且缺少「控制信息不受局面延迟影响」的保证。
  // 观战者不参与对局动作，故不注入乐观保护/协商/断线标记相关配置。
  const { applyPayload: applySnapshot } = useBattleStateSync({
    selfId: spectatorIdRef.current,
    // 观战页的阶段由本页自己的状态机管理，仅供 Hook 判断「结算 → 重赛」迁移
    currentPhase: () => phaseRef.current,
    // 观战页 enter 是异步的，响应可能晚于卸载；经 mountedRef 丢弃已卸载后的帧
    isActive: () => mountedRef.current,
    serverTimeOffsetRef,
    lastMoveTimeRef,
    turnTimeLimitRef,
    byoyomiRef,
    clockSnapRef,
    setGameState,
    setPlayers,
    setSpectatorCount,
    setTurnTimeLimit,
    handlers: {
      // 阶段流转（服务端驱动）：结束 → 结算页；重开一局 → 提示观战已结束
      onPhaseChange: ({ serverPhase, prevPhase }) => {
        if (serverPhase === 'ended') {
          setPhaseSafe('ended');
        } else if (serverPhase === 'waiting') {
          // 对局被重新开一局（rematch），观战结束
          if (prevPhase === 'playing' || prevPhase === 'ended') setPhaseSafe('restarted');
        } else if (serverPhase === 'playing') {
          setPhaseSafe('playing');
        }
      },
      onEnded: info => setWinner(info.winner),
      onEmoji: message =>
        setActiveEmojis(prev => [
          ...prev,
          { id: message.id, playerId: message.playerId, emoji: message.emoji, receivedAt: Date.now() },
        ]),
      // 局面已应用：着法数增加 → 触发吃子/将军特效与音效
      // 【P4】最新一手直接取自负载（增量载荷不再下发完整 moveHistory）
      onBoardApplied: ({ state, isNewMove, lastMove }) => {
        if (!isNewMove) return;
        if (!lastMove) return;
        const last = lastMove;
        const ended = phaseRef.current === 'ended';
        triggerMoveEffect(last.capturedPieceId, state.isCheck, ended);
        // 走子音效：将军时播男声将军语音（内置节流），否则吃子/走子音（终局不播）
        if (ended) return;
        if (state.isCheck) {
          playJiangJunSound();
        } else if (last.capturedPieceId !== -1) {
          playSound('eat');
        } else {
          playSound('go');
        }
      },
    },
  });

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
      // 第 3 批：走 serverNow（§8 表 #7）
      const correctedNow = serverNow(serverTimeOffsetRef);
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
      // 第 3 批：走 serverNow（§8 表 #7）
      const correctedNow = serverNow(serverTimeOffsetRef);
      // 【C-41 同源】协商期间（悔棋/求和）服务端冻结棋钟，步时展示也要跟着冻结
      const anchorNow = clockSnapRef.current?.clockPausedAt ?? correctedNow;
      const elapsed = Math.floor(Math.max(0, anchorNow - lastMoveTimeRef.current) / 1000);
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
        onState: data => applySnapshot(data),
        onStatusChange: connected => {
          setWsConnected(connected);
          // 连上即清除断线提示/错误遮罩：否则一次瞬时网络故障的提示会永久留在页面上
          if (connected) setErrorMsg('');
        },
        onFatalError: (message, kind) => {
          setWsConnected(false);
          // kind='network'（自动重连用尽）只是长时间离线：会话可能仍有效，
          // 切 error 终态会误报"无法进入观战"并停掉 2s 兜底轮询，故只提示不切阶段。
          if (kind === 'network') {
            setErrorMsg('网络连接已断开，请检查网络后重新进入观战');
            return;
          }
          setErrorMsg(message || '无法进入观战');
          setPhaseSafe('error');
        },
        // 协议级失败帧（「观战者无法执行该操作」「未知消息类型」等）：观战侧无操作可做，
        // 但仍要透出，否则服务端拒绝时页面毫无反应。观战页的错误态是终态展示，故只记文案。
        onError: message => setErrorMsg(message),
      },
      'spectator',
    );
    spectateSocketRef.current = socket;
    socket.connect();
    return () => {
      spectateSocketRef.current = null;
      socket.close();
    };
  }, [roomId, setPhaseSafe, applySnapshot]);

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
        if (data && Array.isArray(data.players)) applySnapshot(data);
      } catch {
        // 轮询瞬时失败忽略，下一轮重试
      } finally {
        inFlight = false;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [roomId, wsConnected, applySnapshot]);

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

  // 【P4】最近一步与着法数：增量载荷的 gameState 不含 moveHistory，
  // 但 useBattleStateSync 会把 lastMove 合并进本地棋谱，故这里仍从本地历史读。
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

  // 观战页底部操作栏：观战者不参与对局，唯一入口是「菜单」弹出列表
  const spectateBarActions: GameBottomBarActionInput[] = [{ key: 'menu', icon: 'bars', label: '菜单' }];
  const spectateMenuItems: GameMenuItem[] = [
    {
      key: 'flip',
      icon: 'arrows-rotate',
      label: '翻转棋盘',
      onPress: () => setIsFlipped((v) => !v),
    },
    { key: 'exit', icon: 'door-open', label: '退出观战', onPress: handleExit },
  ];

  return (
    // 【2026-10】去掉 'bottom' 安全区：底部操作栏是主容器的最后一个子节点（固定通栏），
    // 自己用 insets.bottom 撑开内边距，避免 Screen 的底部安全区把透明黑底截断在半空。
    <Screen
      safeAreaEdges={['top', 'left', 'right']}
      backgroundImage={background.image}
      // 深色背景图（华彩红顶 / 茶室木梁）下黑色状态栏图标看不清，切成浅色
      statusBarStyle={background.tone === 'dark' ? 'light' : 'dark'}
    >
      <View style={[styles.container, hasBackground && styles.containerTransparent]}>
        {/* 顶部信息栏已于 2026-10 下线：返回与翻转棋盘移入底部操作栏的「菜单」弹出列表，
            房间名 / 观众数移到底部信息行（棋盘下方、底栏之上），保持信息不丢失。 */}
        {/* 棋盘区域 */}
        <View
          style={styles.boardHost}
          onLayout={(e) => {
            setBoardAreaH(e.nativeEvent.layout.height);
            setBoardHostY(e.nativeEvent.layout.y);
          }}
        >
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
                playerSide="red"
                maxBoardHeight={maxBoardHeight}
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

        {/* 底部信息行：房间名 / 观众数 / 回合进度 / 当前行棋方（顶栏下线后的落位） */}
        <View
          style={[styles.infoRow, bottomBarWidthStyle]}
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            setInfoRowH((prev) => (prev === h ? prev : h));
          }}
        >
          <Text style={[styles.infoRowTitle, hasBackground && styles.textHalo]} numberOfLines={1}>
            {roomName || '在线对局'}
          </Text>
          <View style={styles.infoPill}>
            <FontAwesome6 name="chess-board" size={14} color={COLORS.textLight} />
            <Text style={styles.infoPillText}>第 {Math.floor(moveCount / 2) + 1} 回合 · 共 {moveCount} 步</Text>
          </View>
          <View style={styles.infoPill}>
            <View style={[styles.turnDot, { backgroundColor: isRedTurn ? COLORS.redPiece : COLORS.blackPiece }]} />
            <Text style={styles.infoPillText}>{isRedTurn ? '红方行棋' : '黑方行棋'}</Text>
          </View>
          {/* 人数这枚没有药丸托底（左两个 infoPill 才有），直接落在页面底色上 ⇒ 需要描边 */}
          <Text style={[styles.infoPillText, hasBackground && styles.textHalo]}>
            {spectatorCount} 人观看
          </Text>
        </View>

        {/* 底部操作栏（与人机/在线对战共用 @/components/GameBottomBar，2026-10 第二轮改造）：
            固定通栏贴屏幕最底端。观战无对局操作，只有「菜单」（翻转棋盘 / 退出观战）。 */}
        <GameBottomBar
          widthStyle={bottomBarWidthStyle}
          style={{ marginTop: dynamicGap }}
          bottomInset={insets.bottom}
          actions={spectateBarActions}
          menuItems={spectateMenuItems}
        />

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

        {/* 出错遮罩：以 errorMsg 为准而非 phase === 'error'——网络断开/协议级失败时
            我们刻意不切 error 阶段（那会停掉 2s 兜底轮询并误判为终态），若仍用阶段判断，
            这些提示就会写进 state 却永远看不见 */}
        {!!errorMsg && (
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
  /**
   * 选中整屏背景图时容器必须让位：容器是 Screen 背景图之后的兄弟节点，
   * 实色底会整块盖住背景图。未选背景图时不加此样式 ⇒ 观感与改造前一致。
   */
  containerTransparent: {
    backgroundColor: 'transparent',
  },
  // 顶栏已下线（原 topBar / backBtnZone / backBtn / gameInfo / gameTitle / gameSubtitle）
  boardHost: {
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
  // 底部信息行（顶栏下线后承接房间名 / 观众数 / 回合进度 / 行棋方）。
  // 占位高度 30 + marginBottom 2 = BOARD_INFO_ROW_FLOW_HEIGHT(32)，改样式需同步改常量。
  infoRow: {
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  infoRowTitle: {
    flexShrink: 1,
    fontSize: FONT.caption,
    fontWeight: '700',
    color: COLORS.textPrimary,
  },
  /**
   * 整屏背景图下的文字外描边（浅色光晕）。
   *
   * 背景图可能是深色的（注册表里 tone='dark' 的那一档），而本页前景色一直是深棕。
   * 信息行里有几处文字直接落在页面底色上（没有 infoPill 那样的不透明药丸托底），
   * 深色字压在深色图上会糊成一片。
   *
   * 之所以用 textShadow 而不是给药丸：textShadow **不参与布局测量**，
   * 加在文字上不会改变 infoRow 那条 `height: 30`（与 BOARD_INFO_ROW_FLOW_HEIGHT = 32 常量绑定），
   * 也不会有撑破纵向预算的风险。零偏移 + 圆角半径 = 对称外描边，对任意底色都成立。
   *
   * 颜色取应用卡片底色 #FFF8F0。未选背景图时页面底色本就是 #F5F0E8，两者几乎同色
   * ⇒ 光晕不可见、观感零回归，所以只在 hasBackground 时挂载。
   */
  textHalo: {
    textShadowColor: 'rgba(255, 248, 240, 0.92)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
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
