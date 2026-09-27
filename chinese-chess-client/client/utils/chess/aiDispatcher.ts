/**
 * 混合 AI 调度器：联网优先调用服务端皮卡鱼（在线），网络不可用/不稳定时回退本地 AI（离线）。
 *
 * 策略：
 * 1. 网络预判：通过 NetInfo 检测连接状态（短 TTL 缓存）；明确离线则直接走本地 AI。
 * 2. 在线尝试：带严格超时（ONLINE_TIMEOUT_MS，超时真 abort）；成功则采用云端走法。
 * 3. 失败分类：区分「服务端忙（429）」/「超时」/「网络故障」。
 *    - 忙 = 服务健康仅排队 → 短延迟退避重试，**不熔断**（熔断等于掐掉唯一能出棋的路径）。
 *    - 超时/网络故障 → 计入连续失败，达到阈值后熔断，期间走本地 AI。
 * 4. 熔断器：熔断期直接走本地；冷却结束先做一次轻量健康探测（GET /api/v1/health）
 *    主动恢复，而不是盲发一次完整走子请求——健康探测毫秒级返回，能立刻自愈。
 * 5. clientId 每次请求唯一：服务端用它做进程内去重且算完才释放，复用玩家 ID 会让
 *    一次超时未完成的请求挡住后续所有重试（429 busy 活锁）。
 */

import NetInfo from '@react-native-community/netinfo';
import { getBestMoveAsync, getHintMoveAsync, type AIMoveResult } from './AIEngine';
import {
  toFenString,
  getValidMoves,
  makeMove,
  buildEngineHistory,
  isFenBoardWidthValid,
  type GameState,
  type PieceState,
} from './GameEngine';
import { RED_SIDE, BLACK_SIDE, type AIDifficulty, type SideTag } from './types';
import {
  fetchOnlineMove,
  OnlineAiBusyError,
  OnlineAiError,
  OnlineAiNetworkError,
  OnlineAiTimeoutError,
  type EngineHistory,
  type OnlineMove,
} from './onlineAI';
import { isMoveBanned } from './RuleEngine';
import { getPlayerId } from '@/utils/playerIdentity';
import { getOnlineServerUrl } from '@/utils/serverConfig';

export type AISource = 'online' | 'offline';

export interface HybridMoveResult extends AIMoveResult {
  source: AISource;
  depth?: number;
  timeMs?: number;
  /** 在线走法来源引擎：'book'=开局库（depth 恒为 0）；'pikafish'=皮卡鱼搜索；离线无此字段 */
  engine?: string;
}

/**
 * 在线 AI 可用性状态（供 UI 展示"重连中"等提示）。
 * - 'online'：最近一次在线请求成功，可放心直连
 * - 'probing'：曾失败但已不在熔断期，正在/即将重新探测
 * - 'circuit'：熔断中（连续超时/网络故障），暂走本地 AI
 * - 'invalid_move'：服务端在线可达、走法也返回了，但被本地合法性/规则守卫拒收。
 *   网络与服务都是好的，只是这一着的用法有异常——必须显式暴露，否则会退化成
 *   "看着一切正常、实际全程本地 AI"且毫无提示的死角。
 */
export type OnlineAiStatus = 'online' | 'probing' | 'circuit' | 'invalid_move';

/** 缓存的客户端标识前缀（持久化玩家 ID），仅用于让不同请求的 clientId 相互可区分 */
let cachedPlayerId: string | null = null;
let requestSeq = 0;

/**
 * 生成**每次请求唯一**的 clientId。
 *
 * 服务端 inflightClients 是进程内 Set，同一 clientId 同时只允许一个在飞；
 * 槽位要等引擎算完（`finally` 里 await 之后）才释放。客户端超时会 abort 但不会让
 * 服务端立刻算完，所以若复用固定 clientId：超时 → 冷却 → 重试 恰好撞上自己上一次的
 * 槽位 → 429 busy → 再次熔断，形成无法自愈的活锁（表现为"一直用本地AI、似乎没有重连"）。
 */
function makeRequestId(): string {
  requestSeq += 1;
  const base = cachedPlayerId || 'anon';
  return `${base}#${Date.now().toString(36)}${requestSeq.toString(36)}`;
}

/** 异步取玩家 ID，仅作 clientId 前缀；失败不阻断在线调用（退化为 anon 前缀） */
async function ensurePlayerIdPrefix(): Promise<void> {
  if (cachedPlayerId) return;
  try {
    cachedPlayerId = await getPlayerId();
  } catch {
    cachedPlayerId = 'anon';
  }
}

/** 在线 AI 单步超时（毫秒）。超时即回退本地，避免对局停滞。
 *
 * 由 6000 下调到 2000：线上实测皮卡鱼 hard 的 p50 为 523ms、max 550ms，6 路并发最慢
 * 819ms，2s 仍有 2~3 倍余量；而 6s 的代价是弱网下每一步都干等 6 秒才落子，
 * 用户体验上是"卡死"。2s 让弱网快速回落，交互不再长时间空转。 */
const ONLINE_TIMEOUT_MS = 2000;
/** 连续失败多少次后触发熔断（仅统计超时/网络故障，服务端忙不计入）。 */
const FAILURE_THRESHOLD = 2;
/** 熔断冷却时长（毫秒）：期间直接走本地，冷却后半开重试在线。 */
const CIRCUIT_COOLDOWN_MS = 30000;
/** 服务端返回 busy 时的退避重试间隔基数（毫秒）与最大重试次数：服务健康，不该熔断。
 *  指数退避 700 / 1400 / 2800ms（BUSY_MAX_RETRY=3，即最多 4 次尝试）。 */
const BUSY_RETRY_DELAY_MS = 700;
const BUSY_MAX_RETRY = 3;
/** 冷却后半开健康探测的超时（毫秒）：只打 /api/v1/health，毫秒级即可判定。 */
const PROBE_TIMEOUT_MS = 3000;
/** NetInfo 状态缓存时长（毫秒）：避免每步都做一次系统网络查询。 */
const NETINFO_TTL_MS = 3000;
/** 对局历史长度上限：服务端 moves 上限 512 且 startFen ≤200 字符，超长请求会被 400 静默丢弃。 */
const MAX_HISTORY_MOVES = 500;
/** 服务端 busy 退避重试期间为 true，供 UI 显示"服务端繁忙，重试中"。 */
let busyRetrying = false;

function setBusyRetrying(value: boolean): void {
  if (busyRetrying === value) return;
  busyRetrying = value;
  notifyStatusChange();
}

let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let everSucceeded = false;
let probeInFlight: Promise<boolean> | null = null;

/** 最近一次「在线走法被本地守卫拒收」的原因；null 表示当前没有该异常。 */
let lastInvalidMoveReason: string | null = null;
/** 长对局提示（moveHistory 超过上限时给出），供 UI 展示"建议求和或重开"。 */
let longGameNotice: string | null = null;
/** 状态变更订阅者：让 UI 在熔断/恢复/拒收时无需等待下一次走子即可刷新角标。 */
type StatusListener = (status: OnlineAiStatus) => void;
const statusListeners = new Set<StatusListener>();
/** 主动重连定时器句柄（熔断后自愈用）；非浏览器环境下为普通计时器。 */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let netInfoCache: { at: number; state: { isConnected: boolean | null; isInternetReachable: boolean | null } | null } | null = null;

/** 读取网络状态（短 TTL 缓存）。检测本身异常时返回 null 表示"未知，仍尝试在线"。 */
async function readNetInfo() {
  const now = Date.now();
  if (netInfoCache && now - netInfoCache.at < NETINFO_TTL_MS) return netInfoCache.state;
  try {
    const state = await NetInfo.fetch();
    const next = { isConnected: state.isConnected, isInternetReachable: state.isInternetReachable };
    netInfoCache = { at: now, state: next };
    return next;
  } catch {
    // 检测失败：不缓存（下次重试），并按"未知"处理
    netInfoCache = { at: now, state: null };
    return null;
  }
}

/** 轻量健康探测：确认服务端可达，用于熔断后半开自愈。 */
async function probeServerHealth(): Promise<boolean> {
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const base = await getOnlineServerUrl();
      const resp = await fetch(`${base}/api/v1/health`, { signal: controller.signal });
      if (!resp.ok) return false;
      const data = await resp.json();
      return data?.status === 'ok';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => {
    probeInFlight = null;
  });
  return probeInFlight;
}

/**
 * 判断本次是否允许尝试在线 AI。
 * 熔断期直接走本地；冷却结束先做一次健康探测，探测通过才放行真正的走子请求。
 */
async function isOnlineAllowed(): Promise<boolean> {
  const now = Date.now();
  if (now < circuitOpenUntil) {
    return false;
  }
  // 半开：曾熔断且冷却刚结束 → 主动探测恢复
  if (everSucceeded === false && consecutiveFailures > 0) {
    const healthy = await probeServerHealth();
    if (!healthy) {
      // 探测未通过则继续熔断（不要每次走子都白等一次探测）
      circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
      return false;
    }
    recordOnlineSuccess();
  }
  const state = await readNetInfo();
  // 明确未连接/不可达 → 不尝试在线；null（未判定/检测失败）时仍尝试，由超时兜底
  if (state) {
    if (state.isConnected === false) return false;
    if (state.isInternetReachable === false) return false;
  }
  return true;
}

function recordOnlineFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    consecutiveFailures = 0;
    scheduleReconnect();
  }
  notifyStatusChange();
}

function recordOnlineSuccess(): void {
  consecutiveFailures = 0;
  everSucceeded = true;
  // 在线恢复正常，若曾熔断则立即解除
  circuitOpenUntil = 0;
  lastInvalidMoveReason = null;
  cancelReconnect();
  notifyStatusChange();
}

/**
 * 主动重连：熔断后**不要干等**下一次走子才去探测。
 *
 * 原实现只在 isOnlineAllowed() 里做半开探测，而 isOnlineAllowed 仅由走子/提示触发；
 * 玩家若在冷却期内结束对局或长时间不走子，界面就会一直停在"重连中"，看上去像
 * "无法重连"。这里在熔断瞬间排一个定时任务：冷却结束+1s 后主动打一次
 * /api/v1/health，探通就立即解除熔断并通知 UI，探不通就顺延一个冷却周期再试。
 */
function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    // 期间已恢复正常（例如玩家又走了一步且成功了）则无需再探
    if (Date.now() < circuitOpenUntil) {
      // 冷却尚未真正结束（例如中途又失败重新计时）→ 顺延
      scheduleReconnect();
      return;
    }
    const healthy = await probeServerHealth();
    if (healthy) {
      circuitOpenUntil = 0;
      consecutiveFailures = 0;
      everSucceeded = true;
    } else {
      // 服务仍不可达：重新进入一个冷却窗口，并继续排下一次探测
      circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
      scheduleReconnect();
    }
    notifyStatusChange();
  }, CIRCUIT_COOLDOWN_MS + 1000);
}

function cancelReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/** 状态变化广播：让 UI 的角标在熔断/恢复/拒收发生时立刻刷新，而不是等下一次走子。 */
function notifyStatusChange(): void {
  const status = getOnlineAiStatus();
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch (err) {
      console.warn('[aiDispatcher] 状态订阅回调异常:', err);
    }
  }
}

/**
 * 订阅在线 AI 状态变化（返回取消订阅函数）。
 * 页面用它即时刷新角标，解决"重连中/在线走法异常"提示滞后到下一次走子才出现的问题。
 */
export function subscribeOnlineAiStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/** 最近一次「在线走法被本地守卫拒收」的原因（无异常时返回 null），供 UI 展示。 */
export function getOnlineAiInvalidReason(): string | null {
  return lastInvalidMoveReason;
}

/** 对局过长提示（null 表示未超限），供 UI 展示"建议求和或重开"。 */
export function getOnlineAiLongGameNotice(): string | null {
  return longGameNotice;
}

/**
 * 引擎返回了可响应但走法不可用（坐标/规则校验失败）。
 * 归为引擎侧逻辑错误：重试无意义，但**不计入熔断**（网络与服务都是好的）。
 */
class OnlineAiInvalidMoveError extends OnlineAiError {
  /** 拒收的具体原因，直接进 lastInvalidMoveReason 供 UI 展示。 */
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * 调用在线 AI 一次，并把云端走法定位/校验到当前局面。
 * 成功返回可用的在线走法；失败按原因抛出，供 runHybrid 决定退避重试还是熔断。
 */
async function requestOnlineMove(
  state: GameState,
  difficulty: AIDifficulty | 'hint',
  priority: number
): Promise<{ piece: PieceState; online: OnlineMove }> {
  const fen = toFenString(state);

  // 携带完整对局历史，使云端引擎在搜索中感知真实重复局面（长将/长捉/不变循环）。
  // ⚠️ 守卫链（任一不过就只发 fen，宁可丢掉重复局面感知也不送出错误的局面）：
  //  a) 行宽异常会让服务端 WASM 越界写内存并打崩 worker 池；
  //  b) 回退不自洽时 buildEngineHistory 直接返回 null。
  // 关键前提：服务端在 moves 非空时**完全忽略 fen**，只按 startFen+moves 重建局面，
  // 任何一个字节不准都会让引擎在"另一个局面"里搜索并返回非法走法。
  let history: EngineHistory | null = null;
  if (!isFenBoardWidthValid(fen)) {
    console.warn('[aiDispatcher] 本地 FEN 行宽异常，仅发送 fen 以免打崩服务端引擎');
  } else {
    history = buildEngineHistory(state);
  }

  await ensurePlayerIdPrefix();
  // clientId 每次尝试唯一：服务端忙是"同 clientId 在飞"导致，唯一化后基本不会命中；
  // 仍命中时重试也必然是新槽位，不会再被自己挡住。
  const online = await fetchOnlineMove(
    fen,
    difficulty,
    ONLINE_TIMEOUT_MS,
    priority,
    makeRequestId(),
    history ?? undefined
  );
  const piece = state.pieces.find(
    (p) => p.alive && p.col === online.fromCol && p.row === online.fromRow
  );
  if (!piece) {
    throw new OnlineAiInvalidMoveError(
      `起点 (${online.fromCol},${online.fromRow}) 无活子（服务端返回 ${online.uci}）`
    );
  }
  if (!isOnlineMoveLegal(state, piece, online.toCol, online.toRow)) {
    throw new OnlineAiInvalidMoveError(
      `走法 ${online.uci} 在当前局面不合法（源 ${piece.id}，落点 (${online.toCol},${online.toRow})）`
    );
  }
  if (!isOnlineMoveRuleSafe(state, piece.id, online.toCol, online.toRow)) {
    throw new OnlineAiInvalidMoveError(`走法 ${online.uci} 触发禁着或长将长捉判负规则`);
  }
  return { piece, online };
}

/**
 * 执行一次「在线优先，失败回退本地」调用。
 * busy 走退避重试；超时/网络故障计入熔断；任何失败都立即回退本地 AI，保证对局不卡。
 */
async function runHybrid(
  state: GameState,
  difficulty: AIDifficulty | 'hint',
  priority: number,
  offlineFallback: () => Promise<AIMoveResult | null>
): Promise<HybridMoveResult | null> {
  // 长对局保护：服务端 moves 上限 512（dist/index.js 的 UCI_RE 校验），再长服务端会 400。
  // 超过上限直接只走本地 AI，并把提示交给 UI（建议求和或重开），
  // 避免每步都白跑一次注定失败的在线请求 + 每步都闪一次"在线走法被拒"。
  if (state.moveHistory.length > MAX_HISTORY_MOVES) {
    const notice = `本局已走 ${state.moveHistory.length} 步，超过 ${MAX_HISTORY_MOVES} 步上限，已切回本地AI`;
    if (longGameNotice !== notice) {
      longGameNotice = notice;
      notifyStatusChange();
    }
    const offline = await offlineFallback();
    return offline ? { ...offline, source: 'offline' } : null;
  }
  // 新一局（回到限步以内）时清掉长对局提示：它是进程级状态，不能跨对局残留
  if (longGameNotice !== null) {
    longGameNotice = null;
    notifyStatusChange();
  }

  if (await isOnlineAllowed()) {
    let error: unknown = null;
    for (let attempt = 0; attempt <= BUSY_MAX_RETRY; attempt++) {
      try {
        const { piece, online } = await requestOnlineMove(state, difficulty, priority);
        recordOnlineSuccess();
        return {
          pieceId: piece.id,
          fromCol: online.fromCol,
          fromRow: online.fromRow,
          toCol: online.toCol,
          toRow: online.toRow,
          score: 0,
          source: 'online',
          depth: online.depth,
          timeMs: online.timeMs,
          engine: online.engine,
        };
      } catch (err) {
        error = err;
        // 服务端忙：服务健康，仅排队 → 指数退避后重试，不熔断。
        // 总等待约 700+1400+2800=4.9s，是"宁可多等几拍也要拿到在线走法"的取舍：
        // 服务端 busy 说明此刻正被别人占用，通常一两拍就空出来了。
        if (err instanceof OnlineAiBusyError && attempt < BUSY_MAX_RETRY) {
          setBusyRetrying(true);
          await new Promise((r) => setTimeout(r, BUSY_RETRY_DELAY_MS * 2 ** attempt));
          continue;
        }
        break;
      }
    }
    setBusyRetrying(false);
    // 失败分类：仅「超时」与「网络故障」计入熔断；
    // 服务端忙（服务健康仅排队）与引擎逻辑错误都不熔断，否则会掐掉唯一能出棋的路径
    if (error instanceof OnlineAiTimeoutError || error instanceof OnlineAiNetworkError) {
      recordOnlineFailure();
    } else if (error instanceof OnlineAiInvalidMoveError) {
      // 网络与服务都健康，但走法被本地守卫拒收 —— 记下原因并在 UI 暴露，
      // 否则就是"状态一切正常、实际全程本地 AI"且无任何提示的死角
      lastInvalidMoveReason = error.reason;
      console.warn('[aiDispatcher] 在线走法未通过本地校验，回退本地 AI:', error.reason);
      notifyStatusChange();
    } else if (error instanceof OnlineAiError) {
      console.warn('[aiDispatcher] 在线 AI 失败但不熔断:', (error as Error).name, (error as Error).message);
    }
  }
  // 回退：本地离线 AI
  const offline = await offlineFallback();
  if (!offline) return null;
  return { ...offline, source: 'offline' };
}

/**
 * 校验云端走法在当前局面下合法：
 * 1. 起点棋子必须属于当前走棋方（防止 FEN 不同步时误用对方棋子）；
 * 2. 落点必须在该棋子的合法走法内（含王安全过滤）。
 * 任一不满足即视为在线失败，回退本地，杜绝非法落子破坏局面。
 */
function isOnlineMoveLegal(state: GameState, piece: PieceState, toCol: number, toRow: number): boolean {
  const pieceIsMover = state.sideTag === RED_SIDE ? piece.id >= 16 : piece.id < 16;
  if (!pieceIsMover) return false;
  return !!getValidMoves(state, piece.id)[toCol]?.[toRow];
}

/**
 * 规则守卫：模拟应用云端走法，若该着法使走子方因「长将/长捉」被判负，则视为不可用。
 *
 * 正常情况下服务端引擎携带对局历史搜索，已会主动规避此类违规着法；此守卫是兜底防线，
 * 覆盖开局库命中（开局库不感知历史）等极端场景，避免 AI 走出立即判负的着法。
 * 走子方因重复局面被判和（不变作和）或获胜（对方违规）属于正常结果，不予拦截。
 * 长将长捉超限期间（方案 10 娱乐向改造）超限着法同样被 AI 择优剔除：超限不判负，
 * 但走进去会陷入僵局（最终由自然限招/互长将互长捉判和收场）。云端开局库不感知超限状态。
 *
 * @returns true=走法可用；false=走子方会因此着法被判负或触发超限僵局，应回退本地
 */
function isOnlineMoveRuleSafe(state: GameState, pieceId: number, toCol: number, toRow: number): boolean {
  // 超限着法剔除（走子方为超限方且该着法在超限列表内）——择着偏好，非落子限制
  if (isMoveBanned(state, pieceId, toCol, toRow)) return false;
  const moverSide: SideTag = state.sideTag;
  try {
    const sim = makeMove(state, pieceId, toCol, toRow);
    if (!sim.isGameOver) return true;
    const reason = sim.gameOverReason;
    if (reason !== 'changjiang' && reason !== 'changzhuo') return true;
    const moverLost =
      (moverSide === RED_SIDE && sim.newState.gameStatus === 'black_win') ||
      (moverSide === BLACK_SIDE && sim.newState.gameStatus === 'red_win');
    return !moverLost;
  } catch {
    // 模拟异常时保守放行（合法性已由 isOnlineMoveLegal 校验）
    return true;
  }
}

/**
 * 获取混合 AI 的最佳走法。
 * 联网且在线 AI 可用 → 返回云端走法（source='online'）；
 * 否则回退本地 AI（source='offline'）。
 */
export async function getHybridBestMove(
  state: GameState,
  difficulty: AIDifficulty
): Promise<HybridMoveResult | null> {
  return runHybrid(state, difficulty, 0, () => getBestMoveAsync(state, difficulty));
}

/**
 * 获取"提示"走法（混合调度，与 AI 走子同一套在线/离线调用逻辑）。
 *
 * 与 AI 走法的差异：
 * - 固定最高强度且完全确定：联网走服务端皮卡鱼 hint（深度 8、纯最佳、确定性，同一局面结果恒定），
 *   离线走 getHintMoveAsync（hard 深度）；
 * - 高优先级：联网请求携带 priority=1，服务端引擎池优先调度，交互式提示更快响应；
 * - 同样具备网络预判 / 超时 / 熔断 / 离线回退能力，弱网不卡手。
 *
 * 联网且在线可用 → 返回云端走法（source='online'）；否则回退本地提示搜索（source='offline'）。
 */
export async function getHybridHintMove(state: GameState): Promise<HybridMoveResult | null> {
  return runHybrid(state, 'hint', 1, () => getHintMoveAsync(state));
}

/**
 * 供 UI 展示当前在线 AI 状态：
 * - 'circuit'：熔断中（连续超时/网络故障），正在走本地 AI，冷却结束会自动探测恢复；
 * - 'probing'：冷却已过，将先做健康探测再决定是否联网；
 * - 'invalid_move'：网络与服务都健康，但最近一次在线走法被本地守卫拒收（引擎与本地局面不同步）；
 * - 'online'：最近一次在线请求成功。
 */
export function getOnlineAiStatus(): OnlineAiStatus {
  if (Date.now() < circuitOpenUntil) return 'circuit';
  if (lastInvalidMoveReason !== null) return 'invalid_move';
  if (!everSucceeded && consecutiveFailures > 0) return 'probing';
  return 'online';
}

/** 供调试/展示：当前是否处于熔断状态。 */
export function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

/** 供调试/展示：当前是否正在等待服务端 busy 退避重试。 */
export function isOnlineAiBusyRetrying(): boolean {
  return busyRetrying;
}
