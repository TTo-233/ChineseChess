/**
 * 在线对局状态同步 Hook
 *
 * 背景：服务端对局负载（GameStatePayload）此前在**两个页面各处理一遍**——
 *   · screens/lanBattle/index.tsx:800-1052  applyServerState（对局玩家，带乐观保护与协商/断线处理）
 *   · screens/spectate/index.tsx:194-292    applySnapshot（观战者，字段子集）
 * 两份实现已经分叉（观战侧不读 returnedToRoom、无乐观保护），且 lanBattle 那份存在
 * 一个会吞帧的缺陷。本 Hook 把「负载 → 页面状态」的映射收敛为单一实现。
 *
 * ── 修复的缺陷：乐观保护的提前 return 会吞掉整个负载 ──
 * 旧实现在「服务端局面比本端着法数旧」时直接 `return`，退出的是**整个函数**，
 * 于是同一帧里的 returnedToRoom、phase==='ended' 结算、phase==='waiting' 重赛跟随、
 * 表情、协商结果、断线标记**全部被跳过**。若该着法恰好被服务端 400 拒绝
 * （服务端拒绝时不广播 state），客户端会连续 8 秒丢弃所有状态推送并停在旧画面。
 *
 * 现在改为**只延迟局面块**（deferred），控制信息（phase / returnedToRoom / 协商 /
 * 断线 / 表情）在任何情况下都照常处理——这些判断本就不依赖 gameState（服务端把房间
 * 重置为 waiting 时负载里根本没有 gameState，正是同一条教训）。
 *
 * 页面差异通过配置注入，Hook 不假定发送通道与 UI 形态：
 * - 对局玩家：传入 pendingMove / pendingUndo / pendingDraw 等 ref 与对应回调；
 * - 观战者：只传 players / phase / 时钟与 board 回调即可。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { GameState } from '@/utils/chess/GameEngine';
import {
  BattleActionRejectedError,
  BattleActionTimeoutError,
  type BattleClocks,
  type BattleDrawResult,
  type BattleEmojiMessage,
  type BattleEndReason,
  type BattlePendingDraw,
  type BattlePendingUndo,
  type BattlePlayer,
  type BattleSettings,
  type BattleUndoResult,
  type GameStatePayload,
} from '@/utils/battleProtocol';

/** 本端走子的乐观保护窗口：超过该时长仍未在服务端局面里看到本端着法，即判定上传失败 */
const OPTIMISTIC_SYNC_TIMEOUT_MS = 8000;
/** 协商（悔棋/求和）连续被对方拒绝多少次后封禁入口 */
const NEGOTIATION_REFUSAL_LIMIT = 2;
/** 对方断线等待判负的总时长（与服务端 detectDisconnect 的 60s 对齐，仅用于展示倒计时） */
const DISCONNECT_WAIT_SECONDS = 60;

/** 页面提供的回调集合（全部可选：各页面只传自己关心的部分） */
export interface BattleStateSyncHandlers {
  /** 结算后的胜负展示（phase === 'ended'） */
  onEnded?: (info: {
    winner: string | null;
    isDraw: boolean;
    surrenderBy: string | null;
    /** 已收窄为字面量联合（白名单外回退为按胜负推断），可直接写入页面 state */
    endReason: BattleEndReason;
    /** 结算时的着法数（房间已被重置为 waiting 时为 undefined） */
    moveCount?: number;
    /** gameStartTime 存在时为「本端时钟」算出的时长，仅供展示兜底 */
    duration: number;
  }) => void;
  /** 对局被重置回 waiting，且本端已表态跟随（或兜底倒计时归零）→ 页面应回到准备界面 */
  onRematchFollowed?: () => void;
  /**
   * 服务端阶段流转（在局面块之前触发，不受乐观保护影响）。
   * 页面自有的阶段状态机（如观战页的 connecting/playing/ended/restarted）据此迁移。
   */
  onPhaseChange?: (info: {
    /** 服务端负载里的阶段 */
    serverPhase: 'waiting' | 'playing' | 'ended' | 'other';
    /** 本帧之前的页面阶段（由 options.currentPhase() 读出） */
    prevPhase: string;
  }) => void;
  /** 对手已返回房间（结算页提示用；观战页不关心） */
  onOpponentReturned?: (returned: boolean) => void;
  /** 局面已应用（未因乐观保护被延迟）。historyLen > prevHistoryLen 表示本帧新增了着法 */
  onBoardApplied?: (info: {
    state: GameState;
    historyLen: number;
    /** 本帧之前已见的着法数 */
    prevHistoryLen: number;
    /** 本帧着法数是否增加 */
    isNewMove: boolean;
  }) => void;
  /** 收到表情消息（已按 id 去重；页面据此入列展示） */
  onEmoji?: (message: BattleEmojiMessage) => void;
  /** 我方发起的悔棋被处理 */
  onUndoResult?: (result: BattleUndoResult, blocked: boolean) => void;
  /** 我方发起的求和被处理 */
  onDrawResult?: (result: BattleDrawResult, blocked: boolean) => void;
  /** 对方断线状态变化（含剩余等待秒数） */
  onOpponentDisconnected?: (info: { disconnected: boolean; countdown: number }) => void;
  /** 本端被服务端标记为断线（页面应立即上报重连） */
  onSelfMarkedDisconnected?: () => void;
  /** 服务端拒绝/未响应本端动作 */
  onActionFailure?: (message: string) => void;
}

/** 页面注入的同步配置：ref 由页面持有（与页面其它逻辑共享），回调由 Hook 调用 */
export interface BattleStateSyncOptions {
  /** 本端身份（玩家 id 或观战者 id）：用于判断「对手」与「自己」 */
  selfId: string;
  /**
   * 我方阵营标识取值函数（'red' | 'black' | 'r' | 'b' …）。
   * 用函数而非快照：选边结果与重赛可能改变阵营，快照会读到陈旧值。
   * 仅对局玩家需要（用于判断某步是否对手所走）；观战者不传。
   */
  resolveMySide?: () => string;
  /** 当前阶段（读 phaseRef.current）。用于判断「结算页 → 重赛跟随」的迁移 */
  currentPhase?: () => string;
  /**
   * 页面是否仍然挂载（读 mountedRef.current）。返回 false 时整帧被丢弃。
   * 观战页用它在异步 enter/轮询回调晚于卸载时避免向已卸载组件写状态。
   */
  isActive?: () => boolean;
  /** 本端是否已表态跟随重赛（读 returnFallbackFiredRef.current） */
  rematchFollowedFallback?: () => boolean;

  // ---- 时钟 / 设置 ----
  serverTimeOffsetRef?: { current: number };
  /** 服务端回合计时锚点（步时倒计时起点）：对方走棋/悔棋后由服务端刷新 */
  lastMoveTimeRef?: { current: number };
  /** 单回合限时（秒）镜像；房间详情轮询也会改写它，故按 ref 注入 */
  turnTimeLimitRef?: { current: number };
  /** 读秒（秒）镜像 */
  byoyomiRef?: { current: number };
  /** 局时钟面快照（服务端权威值 + 锚点） */
  clockSnapRef?: {
    current: {
      red: number;
      black: number;
      lastMoveTime: number;
      sideTag: unknown;
      clockPausedAt: number | null;
    } | null;
  };

  // ---- 对局玩家专用 ----
  /** 本端走子乐观保护：命中保护时本帧的局面块被延迟，但控制信息仍照常处理 */
  pendingMoveRef?: { current: { historyLen: number; at: number; snapshot: GameState } | null };
  pendingUndoRef?: { current: boolean };
  pendingDrawRef?: { current: boolean };
  undoBlockedRef?: { current: boolean };
  drawBlockedRef?: { current: boolean };
  selfDisconnectedRef?: { current: boolean };
  requestReconnect?: () => void;

  // ---- 状态写入 ----
  setGameState: (state: GameState) => void;
  setPlayers?: (players: BattlePlayer[]) => void;
  setSpectatorCount?: (count: number) => void;
  setTurnTimeLimit?: (seconds: number) => void;
  setBaseTimeSeconds?: (seconds: number) => void;
  roomIncrementRef?: { current: number };
  roomByoyomiRef?: { current: number };
  roomHandicapRef?: { current: number[] };
  setRoomHandicap?: (handicap: number[]) => void;
  setUndoBlocked?: (blocked: boolean) => void;
  setDrawBlocked?: (blocked: boolean) => void;
  setUndoPending?: (pending: boolean) => void;
  setDrawPending?: (pending: boolean) => void;
  setUndoRequestFromOpponent?: (pending: boolean) => void;
  setDrawRequestFromOpponent?: (pending: boolean) => void;
  setOpponentDisconnected?: (disconnected: boolean) => void;
  setDisconnectCountdown?: (seconds: number) => void;

  handlers?: BattleStateSyncHandlers;
}

export interface BattleStateSyncApi {
  /** 处理一帧服务端负载（welcome / state / HTTP 轮询响应共用） */
  applyPayload: (raw: Record<string, unknown>) => void;
  /** 本端走子已本地落地：登记乐观保护基线（同时保存回滚快照） */
  markOptimisticMove: (historyLen: number, snapshot: GameState) => void;
  /** 撤销乐观更新，回到服务端最后确认的局面（动作被拒绝/超时时调用） */
  rollbackOptimisticMove: () => boolean;
  /** 服务端拒绝了本端动作：统一处理（回退乐观更新 + 清理在途协商状态 + 通知页面） */
  handleActionRejected: (error: unknown) => void;
  /** 重开一局：重置着法基线与乐观保护 */
  resetSyncBaseline: () => void;
  /** 已见着法数（页面侧若有额外用途可读，一般无需使用） */
  seenHistoryLenRef: { current: number };
}

/** 把负载里的未知字段安全地读成对象（服务端字段缺失/类型异常时不抛错） */
function asObject<T>(value: unknown): T | undefined {
  return value && typeof value === 'object' ? (value as T) : undefined;
}

const BATTLE_END_REASONS: readonly string[] = [
  'checkmate',
  'resign',
  'draw',
  'disconnect',
  'timeout',
  'leave',
];

/**
 * 结算原因收窄：服务端字段是 string，页面 state 是字面量联合。
 * 白名单外（理论上不会出现）回退为按 winner/surrenderBy 推断的默认值，
 * 避免把任意字符串塞进页面 state。
 */
function narrowEndReason(
  raw: unknown,
  fallback: 'draw' | 'checkmate' | 'resign',
): BattleEndReason {
  return typeof raw === 'string' && BATTLE_END_REASONS.includes(raw)
    ? (raw as BattleEndReason)
    : fallback;
}

export function useBattleStateSync(options: BattleStateSyncOptions): BattleStateSyncApi {
  // 每次渲染都刷新最新配置：applyPayload 经 ref 被 WS/轮询回调调用，
  // 依赖数组无法表达「页面每个函数都是新引用」这件事，用 optionsRef 规避闭包捕获旧回调。
  // 必须在 effect 中写入而非渲染期间赋值（react-hooks/refs 规则禁止渲染期改 ref）；
  // 该 effect 无依赖数组 → 每次渲染后同步，首次 applyPayload 调用发生在页面事件/推送回调，
  // 那时 options 已完成首次赋值（useRef 初值即为 options），不存在读到 null 的窗口。
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // 已见着法数：识别「本帧是否有新着法」（对手走棋检测、悔棋回退基线）
  const seenHistoryLenRef = useRef(0);
  // 表情按 id 去重：WS 与轮询双通道都会下发同一批，必须幂等
  const seenEmojiIdsRef = useRef<Set<string>>(new Set());

  const applyPayload = useCallback((raw: Record<string, unknown>) => {
    const opt = optionsRef.current;
    const h = opt.handlers;
    const data = raw as GameStatePayload;

    // 页面已卸载（异步 enter/轮询回调晚于卸载）：丢弃整帧，避免向已卸载组件写状态
    if (opt.isActive && !opt.isActive()) return;

    // ---- 玩家 / 观战人数 ----
    if (Array.isArray(data.players) && opt.setPlayers) opt.setPlayers(data.players);
    if (typeof data.spectatorCount === 'number' && opt.setSpectatorCount) {
      opt.setSpectatorCount(data.spectatorCount);
    }

    // ---- 表情（不依赖 gameState：准备阶段、结算后都要能收到） ----
    if (Array.isArray(data.emojiMessages)) {
      for (const m of data.emojiMessages) {
        if (!m || typeof m.id !== 'string' || typeof m.emoji !== 'string') continue;
        if (seenEmojiIdsRef.current.has(m.id)) continue;
        seenEmojiIdsRef.current.add(m.id);
        // 页面提供了回调时由页面自行入列（调用方需自行维护去重语义）；否则此处不承担入列职责
        h?.onEmoji?.(m);
      }
    }

    // ---- 服务端时钟校正（所有与服务端时间戳的比较都必须走校正时间） ----
    if (typeof data.serverNow === 'number' && opt.serverTimeOffsetRef) {
      opt.serverTimeOffsetRef.current = data.serverNow - Date.now();
    }

    // ---- 房间设置同步 ----
    const settings = asObject<BattleSettings>(data.settings);
    if (settings) {
      // 单回合限时由 room 轮询与对局负载双向同步（两者都写同一镜像 ref）
      if (typeof settings.turnTimeLimit === 'number' && opt.turnTimeLimitRef) {
        opt.turnTimeLimitRef.current = settings.turnTimeLimit;
      }
      if (typeof settings.byoyomiSeconds === 'number' && opt.byoyomiRef) {
        opt.byoyomiRef.current = settings.byoyomiSeconds;
      }
      if (typeof settings.baseTimeSeconds === 'number' && opt.setBaseTimeSeconds) {
        opt.setBaseTimeSeconds(settings.baseTimeSeconds || 0);
      }
      if (opt.roomIncrementRef) opt.roomIncrementRef.current = settings.incrementSeconds || 0;
      if (opt.roomByoyomiRef) opt.roomByoyomiRef.current = settings.byoyomiSeconds || 0;
      if (Array.isArray(settings.handicap)) {
        if (opt.roomHandicapRef) opt.roomHandicapRef.current = settings.handicap;
        opt.setRoomHandicap?.(settings.handicap);
      }
    }

    // ---- 回合计时锚点（步时倒计时起点） ----
    // 放在局面块之外：悔棋回退也会刷新该锚点，不应因乐观保护被延迟
    if (typeof data.lastMoveTime === 'number' && data.lastMoveTime > 0 && opt.lastMoveTimeRef) {
      opt.lastMoveTimeRef.current = data.lastMoveTime;
    }

    // ---- 局时钟面快照（服务端权威毫秒 + 锚点，本地按 1s 插值展示） ----
    // 刻意放在局面块之外：协商暂停锚点等信息的同步不应被乐观保护延迟
    if (opt.clockSnapRef) {
      const clocks = asObject<BattleClocks>(data.clocks);
      if (clocks && data.gameState) {
        opt.clockSnapRef.current = {
          red: clocks.red,
          black: clocks.black,
          lastMoveTime: typeof data.lastMoveTime === 'number' ? data.lastMoveTime : Date.now(),
          sideTag: data.gameState.sideTag,
          clockPausedAt: typeof data.clockPausedAt === 'number' ? data.clockPausedAt : null,
        };
      } else if (!clocks) {
        // 对局未启用局时（或房间被重置）：清空展示，避免残留上一局时间
        opt.clockSnapRef.current = null;
      }
    }

    // ---- 对局阶段流转（结算 / 重赛观战结束 / 进行中） ----
    // 必须在局面块之前且不受其影响：服务端把房间重置为 waiting 时负载里没有 gameState
    h?.onPhaseChange?.({
      serverPhase:
        data.phase === 'waiting' || data.phase === 'playing' || data.phase === 'ended'
          ? data.phase
          : 'other',
      prevPhase: opt.currentPhase?.() ?? '',
    });
    if (data.phase === 'ended') {
      h?.onEnded?.({
        winner: data.winner ?? null,
        isDraw: !data.winner,
        surrenderBy: data.surrenderBy ?? null,
        // 服务端可能给出白名单外的原因：收窄后再交给页面，避免任意字符串进入 state
        endReason: narrowEndReason(
          data.endReason,
          !data.winner ? 'draw' : data.surrenderBy ? 'resign' : 'checkmate',
        ),
        moveCount: data.gameState?.moveHistory?.length,
        duration: data.gameStartTime ? Date.now() - data.gameStartTime : 0,
      });
    }

    // ---- 局面块（可能因乐观保护被延迟） ----
    const newState = data.gameState ?? undefined;
    if (newState) {
      const historyLen = newState.moveHistory?.length ?? 0;
      const pendingMove = opt.pendingMoveRef?.current;
      let applyBoard = true;

      if (pendingMove) {
        if (historyLen >= pendingMove.historyLen) {
          // 服务端已包含本端着法（或更多）→ 解除保护，恢复正常同步
          opt.pendingMoveRef!.current = null;
        } else if (Date.now() - pendingMove.at < OPTIMISTIC_SYNC_TIMEOUT_MS) {
          // 仍是走子前的旧局面（上报尚在途）→ 只延迟本帧的局面覆盖，控制信息继续处理
          applyBoard = false;
        } else {
          // 长时间未见本端着法 → 判定上报失败，放弃保护，按服务端局面恢复
          opt.pendingMoveRef!.current = null;
        }
      }

      if (applyBoard) {
        const prevHistoryLen = seenHistoryLenRef.current;
        opt.setGameState(newState);
        if (historyLen !== prevHistoryLen) seenHistoryLenRef.current = historyLen;

        h?.onBoardApplied?.({
          state: newState,
          historyLen,
          prevHistoryLen,
          isNewMove: historyLen > prevHistoryLen,
        });
      }
    }

    // ▼▼▼ 以下均为「控制信息」，无论局面是否被延迟都必须处理 ▼▼▼

    // ---- 协商封禁状态（先于结果提示读取） ----
    const undoRefusals = asObject<Record<string, number>>(data.undoRefusals);
    const drawRefusals = asObject<Record<string, number>>(data.drawRefusals);
    const undoBlocked = !!(undoRefusals && (undoRefusals[opt.selfId] ?? 0) >= NEGOTIATION_REFUSAL_LIMIT);
    const drawBlocked = !!(drawRefusals && (drawRefusals[opt.selfId] ?? 0) >= NEGOTIATION_REFUSAL_LIMIT);
    if (opt.undoBlockedRef) opt.undoBlockedRef.current = undoBlocked;
    if (opt.drawBlockedRef) opt.drawBlockedRef.current = drawBlocked;
    opt.setUndoBlocked?.(undoBlocked);
    opt.setDrawBlocked?.(drawBlocked);

    // ---- 对方发起的悔棋/求和请求 ----
    const pendingUndo = asObject<BattlePendingUndo>(data.pendingUndo);
    opt.setUndoRequestFromOpponent?.(!!(pendingUndo && pendingUndo.playerId !== opt.selfId));

    // ---- 我方发起的悔棋请求有了处理结果 ----
    const undoResult = asObject<BattleUndoResult>(data.undoResult);
    if (undoResult && undoResult.playerId === opt.selfId && opt.pendingUndoRef?.current) {
      opt.pendingUndoRef.current = false;
      opt.setUndoPending?.(false);
      if (!undoResult.agreed) h?.onUndoResult?.(undoResult, undoBlocked);
    } else if (!pendingUndo && opt.pendingUndoRef?.current) {
      // 请求因对方走棋等原因失效且无处理结果 → 静默清除
      opt.pendingUndoRef.current = false;
      opt.setUndoPending?.(false);
    }

    // ---- 对方发起的求和请求 ----
    const pendingDraw = asObject<BattlePendingDraw>(data.pendingDraw);
    opt.setDrawRequestFromOpponent?.(!!(pendingDraw && pendingDraw.playerId !== opt.selfId));

    // ---- 我方发起的求和请求有了处理结果 ----
    const drawResult = asObject<BattleDrawResult>(data.drawResult);
    if (drawResult && drawResult.playerId === opt.selfId && opt.pendingDrawRef?.current) {
      opt.pendingDrawRef.current = false;
      opt.setDrawPending?.(false);
      if (!drawResult.agreed) h?.onDrawResult?.(drawResult, drawBlocked);
    } else if (!pendingDraw && opt.pendingDrawRef?.current) {
      opt.pendingDrawRef.current = false;
      opt.setDrawPending?.(false);
    }

    // ---- 断线检测 ----
    if (data.disconnectedPlayerId && data.disconnectedPlayerId !== opt.selfId) {
      let countdown = DISCONNECT_WAIT_SECONDS;
      if (data.disconnectTime) {
        const elapsed = Math.floor((Date.now() - data.disconnectTime) / 1000);
        countdown = Math.max(0, DISCONNECT_WAIT_SECONDS - elapsed);
      }
      opt.setOpponentDisconnected?.(true);
      opt.setDisconnectCountdown?.(countdown);
      h?.onOpponentDisconnected?.({ disconnected: true, countdown });
    } else {
      opt.setOpponentDisconnected?.(false);
      opt.setDisconnectCountdown?.(DISCONNECT_WAIT_SECONDS);
      h?.onOpponentDisconnected?.({ disconnected: false, countdown: DISCONNECT_WAIT_SECONDS });
    }
    // 本端被标记断线（如切后台导致心跳超时）：本页面正存活接收状态，立即显式上报重连
    if (data.disconnectedPlayerId === opt.selfId) {
      if (opt.selfDisconnectedRef) opt.selfDisconnectedRef.current = true;
      opt.requestReconnect?.();
    }

    // ---- 结算后「已返回房间」记录 ----
    const returnedToRoom = asObject<Record<string, number>>(data.returnedToRoom);
    if (returnedToRoom && Array.isArray(data.players)) {
      const opponentId = data.players.find(p => p.id !== opt.selfId)?.id;
      h?.onOpponentReturned?.(!!opponentId && !!returnedToRoom[opponentId]);
    }

    // ---- 结算页 → 重赛跟随 ----
    if (data.phase === 'waiting' && opt.currentPhase?.() === 'ended') {
      // 是否跟随回到准备界面取决于**本端**是否已表态：本端点过「返回房间」
      // 或结算兜底倒计时已归零 → 跟随；仅对手表态 → 留在结算页（双方互不干扰）
      const followed = !!returnedToRoom?.[opt.selfId] || !!opt.rematchFollowedFallback?.();
      if (followed) h?.onRematchFollowed?.();
    }
  }, []);

  const markOptimisticMove = useCallback((historyLen: number, snapshot: GameState) => {
    const ref = optionsRef.current.pendingMoveRef;
    if (ref) ref.current = { historyLen, at: Date.now(), snapshot };
  }, []);

  const rollbackOptimisticMove = useCallback((): boolean => {
    const ref = optionsRef.current.pendingMoveRef;
    const pending = ref?.current;
    if (!ref || !pending) return false;
    ref.current = null;
    optionsRef.current.setGameState(pending.snapshot);
    return true;
  }, []);

  const handleActionRejected = useCallback(
    (error: unknown) => {
      const opt = optionsRef.current;
      const name = error instanceof Error ? error.name : '';
      // 帧未发出（连接不可用）由页面走 HTTP 兜底，不属于「服务端拒绝」，此处不处理
      if (name === 'BattleActionNotSentError') return;

      const message =
        error instanceof BattleActionRejectedError || error instanceof BattleActionTimeoutError
          ? error.message
          : '操作未送达服务端，请重试';

      // 结果未知或明确被拒：本端乐观更新必须回退，否则棋子会长期停在服务端从未接受的位置
      rollbackOptimisticMove();

      // 清理在途协商状态：服务端 4xx 时 pending 不会建立，界面否则会停在「等待对方同意」
      const action = error instanceof BattleActionRejectedError ? error.action : null;
      if (!action || action === 'undo') {
        if (opt.pendingUndoRef) opt.pendingUndoRef.current = false;
        opt.setUndoPending?.(false);
      }
      if (!action || action === 'draw') {
        if (opt.pendingDrawRef) opt.pendingDrawRef.current = false;
        opt.setDrawPending?.(false);
      }
      opt.handlers?.onActionFailure?.(message);
    },
    [rollbackOptimisticMove],
  );

  const resetSyncBaseline = useCallback(() => {
    seenHistoryLenRef.current = 0;
    if (optionsRef.current.pendingMoveRef) optionsRef.current.pendingMoveRef.current = null;
  }, []);

  useEffect(() => {
    // 卸载即清空乐观保护：避免离开对局后残留快照在下次进入时被回滚
    const ref = optionsRef.current.pendingMoveRef;
    return () => {
      if (ref) ref.current = null;
    };
  }, []);

  return useMemo(
    () => ({
      applyPayload,
      markOptimisticMove,
      rollbackOptimisticMove,
      handleActionRejected,
      resetSyncBaseline,
      seenHistoryLenRef,
    }),
    [
      applyPayload,
      markOptimisticMove,
      rollbackOptimisticMove,
      handleActionRejected,
      resetSyncBaseline,
    ],
  );
}
