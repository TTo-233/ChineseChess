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
import { applyServerNow, serverElapsedMs, serverNow } from '@/utils/serverClock';
import type { MoveRecord } from '@/utils/chess/types';

/**
 * 【P5】慢链路下的乐观保护窗口下限（取代原先写死的 8000ms）。
 *
 * 实测本站线路（上海电信 → Cloudflare SEA 节点 → 回源隧道）着法往返 p50 457 ms、p90 1763 ms，
 * 对手着法可见 p50 735 ms、p90 1733 ms；8 秒的固定窗口在 p90 抖动下会在**服务端已收到、
 * 广播在路上**时被误判为「上传失败」，从而把局面拉回旧快照——比多等几秒更糟。
 * 因此窗口按实测 RTT 放大，并硬性保底 12 秒。
 */
const OPTIMISTIC_SYNC_TIMEOUT_MIN_MS = 12000;
/** 【P5】RTT 放大倍数：窗口 = RTT × 该倍数，并夹在 [下限, 上限] 之间 */
const OPTIMISTIC_SYNC_RTT_FACTOR = 6;
const OPTIMISTIC_SYNC_TIMEOUT_MAX_MS = 30000;
/** 页面未提供 RTT 采样时的占位（等价「链路未知」，直接用下限窗口） */
const NO_RTT = (): number => 0;
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
    /**
     * 【P4】本帧的最新一手（增量载荷里 moveHistory 已不再下发）。
     * 走子动画、着子音效与「最后一步」高亮都只用到这一条记录。
     */
    lastMove: MoveRecord | null;
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
  /**
   * 对方发起的悔棋请求的回退手数（1 或 2），仅在 setUndoRequestFromOpponent(true) 时非 0。
   * 【悔棋深度】服务端在请求时锁定 pendingUndo.depth，这里原样透出供弹窗措辞；
   * 无请求时为 0。缺省 0 由屏幕侧按「退 2 手」兜底显示。
   */
  setOpponentUndoDepth?: (depth: 0 | 1 | 2) => void;
  setDrawRequestFromOpponent?: (pending: boolean) => void;
  setOpponentDisconnected?: (disconnected: boolean) => void;
  setDisconnectCountdown?: (seconds: number) => void;

  handlers?: BattleStateSyncHandlers;

  /**
   * 【P5】当前链路的实测 RTT（毫秒，由 battleSocket 的 `rttMs` 提供）。
   * 用于把「乐观保护窗口」与「回执超时」按线路标定，而不是按 20–80ms 的理想链路写死。
   * 不传时按 0 处理（等价于使用 OPTIMISTIC_SYNC_TIMEOUT_MIN_MS 下限）。
   */
  rttMs?: () => number;
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

/**
 * 【P4】读取服务端已走手数。
 *
 * 增量载荷以顶层 `moveCount` 为准；全量载荷（welcome / HTTP /gameState / 悔棋后补推）
 * 两者等价。老服务端没有顶层字段时回落到 moveHistory.length，保证向前兼容。
 */
function readMoveCount(data: GameStatePayload): number {
  const n = data.moveCount;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return n;
  return data.gameState?.moveHistory?.length ?? 0;
}

/**
 * 【P5】按实测 RTT 标定乐观保护窗口。
 *
 * 窗口需要覆盖「着法已到达服务端 → 广播在网络上飞回来」这一整段，
 * 因此按 RTT 的数倍取值，并夹在 [12s, 30s]：12s 足以覆盖本站线路 p90 1733ms 的
 * 多倍抖动，而 30s 又不至于让真正的上传失败长时间停在旧画面上。
 */
function optimisticTimeoutMs(rttMs: () => number): number {
  let rtt = 0;
  try {
    rtt = rttMs() || 0;
  } catch {
    rtt = 0;
  }
  if (!Number.isFinite(rtt) || rtt <= 0) return OPTIMISTIC_SYNC_TIMEOUT_MIN_MS;
  const scaled = Math.round(rtt * OPTIMISTIC_SYNC_RTT_FACTOR);
  return Math.min(
    OPTIMISTIC_SYNC_TIMEOUT_MAX_MS,
    Math.max(OPTIMISTIC_SYNC_TIMEOUT_MIN_MS, scaled),
  );
}

/**
 * 【P4】把最新一手补回本地棋谱，使 moveHistory 在增量载荷下依旧完整。
 *
 * 背景：`recomputeRuleState`（`utils/chess/RuleEngine.ts`）与 `undoInPlace`
 * 都需要**自起始局面起完整**的 moveHistory 才会重放。服务端增量载荷不再下发全量历史，
 * 若客户端直接丢弃，本地悔棋预演与规则重算就会静默出错。
 *
 * 参数 `prev` 是本端上一次应用的局面（含完整历史）。
 * 规则（按服务端给出的 moveCount 对齐）：
 * - 载荷自带完整历史（长度就等于 moveCount）→ 直接用服务端的，权威；
 * - 本地历史比 moveCount 短 → 缺的那几手用 lastMove 补齐（只补最新一手）；
 * - 本地历史比 moveCount 长（悔棋截断）→ 截到 moveCount，信任服务端。
 * - 无需改动时返回原引用，避免无谓的重渲染。
 */
function mergeHistory(
  state: GameState,
  moveCount: number,
  lastMove: MoveRecord | null | undefined,
  prev: GameState | null,
): GameState {
  const incoming = state.moveHistory ?? [];
  // 服务端已下发完整历史（welcome / HTTP /gameState / 悔棋后补推）→ 权威，直接采用
  if (incoming.length >= moveCount) {
    return incoming.length === moveCount ? state : { ...state, moveHistory: incoming.slice(0, moveCount) };
  }
  const base = prev?.moveHistory ?? [];
  if (base.length === moveCount) return { ...state, moveHistory: base };
  if (base.length < moveCount && lastMove) {
    // 只可能缺最新一手（本端乐观着法先落地时长度已相等，走上面的分支）
    const tail = base[base.length - 1];
    const merged = tail === lastMove ? base : [...base, lastMove];
    return { ...state, moveHistory: merged.slice(0, moveCount) };
  }
  // 兜底：本地无历史且载荷也无从补齐 → 至少不要把 moveHistory 留成 null
  return { ...state, moveHistory: base.slice(0, moveCount) };
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
  // 【P4】本端上一次应用的局面（携带完整本地 moveHistory）。
  // 增量载荷的 gameState 不含 moveHistory，需要与它合并才能维持可重放的完整棋谱。
  const prevStateRef = useRef<GameState | null>(null);
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
    // 第 3 批：偏移量的写入/读取集中到 @/utils/serverClock，
    // 避免各处手写 `Date.now() + offset` 时漏掉某一条路径（§8 表 #7）
    applyServerNow(opt.serverTimeOffsetRef, data.serverNow);

    // ---- 房间设置同步 ----
    const settings = asObject<BattleSettings>(data.settings);
    if (settings) {
      // 单回合限时由 room 轮询与对局负载双向同步（两者都写同一镜像 ref）
      if (typeof settings.turnTimeLimit === 'number') {
        // 【C-53】此前只写镜像 ref、从不调 setTurnTimeLimit，声明的 setter 是死参数：
        // 对局页之所以还能显示，是因为它的 room 轮询那条路径（lanBattle:676/:1308）
        // 调了 setter；观战页只调 setter 不传 ref → turnTimeLimit 永远停在初始 0，
        // 「限时步时」的房间里观众从头到尾看不到倒计时。两个写入通道都补齐。
        if (opt.turnTimeLimitRef) opt.turnTimeLimitRef.current = settings.turnTimeLimit;
        opt.setTurnTimeLimit?.(settings.turnTimeLimit);
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
          lastMoveTime: typeof data.lastMoveTime === 'number' ? data.lastMoveTime : serverNow(opt.serverTimeOffsetRef),
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
        moveCount: data.moveCount ?? data.gameState?.moveHistory?.length,
        // 第 3 批 / §8 #7：gameStartTime 是服务端时间戳，必须用校正后的服务端时间求差
        duration: serverElapsedMs(opt.serverTimeOffsetRef, data.gameStartTime),
      });
    }

    // ---- 局面块（可能因乐观保护被延迟） ----
    const newState = data.gameState ?? undefined;
    if (newState) {
      // 【P4】增量载荷不再带完整 moveHistory（30 步局面实测 2381 B，占载荷 31%），
      // 着法数统一读顶层 moveCount；全量载荷（welcome/重连/悔棋后）两个来源等价。
      const historyLen = readMoveCount(data);
      const pendingMove = opt.pendingMoveRef?.current;
      let applyBoard = true;

      if (pendingMove) {
        if (historyLen >= pendingMove.historyLen) {
          // 服务端已包含本端着法（或更多）→ 解除保护，恢复正常同步
          opt.pendingMoveRef!.current = null;
        } else if (Date.now() - pendingMove.at < optimisticTimeoutMs(opt.rttMs ?? NO_RTT)) {
          // 仍是走子前的旧局面（上报尚在途）→ 只延迟本帧的局面覆盖，控制信息继续处理
          applyBoard = false;
        } else {
          // 长时间未见本端着法 → 判定上报失败，放弃保护，按服务端局面恢复
          opt.pendingMoveRef!.current = null;
        }
      }

      if (applyBoard) {
        const prevHistoryLen = seenHistoryLenRef.current;
        // 【P4】增量载荷的 gameState 里**完全没有** moveHistory，
        // 必须与本地已有棋谱合并，否则每帧都会把历史清空（undoInPlace /
        // recomputeRuleState 这类「按 moveHistory 重放」的逻辑会随之失效）。
        const mergedState = mergeHistory(newState, historyLen, data.lastMove, prevStateRef.current);
        prevStateRef.current = mergedState;
        opt.setGameState(mergedState);
        if (historyLen !== prevHistoryLen) seenHistoryLenRef.current = historyLen;

        h?.onBoardApplied?.({
          state: newState,
          historyLen,
          prevHistoryLen,
          isNewMove: historyLen > prevHistoryLen,
          // 【P4】最新一手直接来自载荷，页面不必再去索引 moveHistory
          lastMove: data.lastMove ?? null,
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
    const opponentUndo = !!(pendingUndo && pendingUndo.playerId !== opt.selfId);
    opt.setUndoRequestFromOpponent?.(opponentUndo);
    // 【悔棋深度】把服务端锁定的回退手数透给响应方，弹窗才能说清「同意后撤几步」。
    // 缺省按 2（旧服务端不下发该字段）处理；非对方发起的请求一律清 0。
    opt.setOpponentUndoDepth?.(opponentUndo ? (pendingUndo?.depth ?? 2) : 0);

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
        // §4.4：disconnectTime 是服务端时间戳（与 lastMoveTime、sideReveal.time 同源），
        // 必须用校正后的服务端时间求差。直接用本机 Date.now() 时，
        // 设备时钟偏快会算出巨大的 elapsed → 倒计时直接 0，用户看到「对方已断线」+
        // 归零闪一下；同时时钟偏慢又会算出负数 → Math.max(0, ...) 把它拉回满值，
        // 倒计时长时间不归零。这两种表现都是「服务端其实还在等满 60s」。
        // 第 3 批起这条路径走 serverElapsedMs（§8 表 #7）
        const elapsed = Math.floor(serverElapsedMs(opt.serverTimeOffsetRef, data.disconnectTime) / 1000);
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
    // 【P4】回滚快照同样携带完整棋谱，本地历史基线要跟着回退
    prevStateRef.current = pending.snapshot;
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
    // 【P4】重开一局：本地棋谱一并作废，否则会与新局的着法序列串在一起
    prevStateRef.current = null;
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
