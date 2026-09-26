import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { FontAwesome6 } from '@expo/vector-icons';
import { type GameState } from '@/utils/chess/GameEngine';
import { RED_SIDE } from '@/utils/chess/types';
import ChessBoard, { CapturedPiecesDrawer } from '@/components/ChessBoard';
import { useMoveEffect } from '@/hooks/useMoveEffect';
import { playJiangJunSound, playSound, preloadSounds, unloadAllSounds } from '@/utils/SoundManager';
import { getOnlineServerUrl } from '@/utils/serverConfig';
import { BattleSocket } from '@/utils/battleSocket';
import { useBoardLayoutBudget, capHostHeightToViewport } from '@/utils/chess/capturedDrawerMetrics';
import { boardAlignedRowStyle } from '@/utils/chess/boardContentWidth';
import { useBoardStyle } from '@/utils/chess/boardStyleStore';
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
  }) => {
    if (!mountedRef.current) return;

    if (Array.isArray(data.players)) setPlayers(data.players);
    if (typeof data.spectatorCount === 'number') setSpectatorCount(data.spectatorCount);

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
        const data = await response.json();
        if (data.success) applySnapshotRef.current(data);
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

  // 名字角标（带行棋指示）
  const renderNameChip = (player: RoomPlayer | null, side: 'red' | 'black', align: 'left' | 'right') => {
    const isTurn = gameState ? (side === 'red' ? isRedTurn : !isRedTurn) : false;
    return (
      <View style={[styles.nameRow, align === 'right' ? styles.nameRowMe : undefined, nameRowStyle]} pointerEvents="none">
        <View style={styles.nameChip}>
          {align === 'left' && (
            <View style={[styles.nameChipDot, { backgroundColor: side === 'red' ? COLORS.redPiece : COLORS.blackPiece }]} />
          )}
          <Text style={styles.nameChipText} numberOfLines={1}>
            {player ? player.name : side === 'red' ? '红方' : '黑方'}
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
            {renderNameChip(topPlayer, isFlipped ? 'red' : 'black', 'left')}

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

            {renderNameChip(bottomPlayer, isFlipped ? 'black' : 'red', 'right')}
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
    zIndex: 50,
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
