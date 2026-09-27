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
 */
export type OnlineAiStatus = 'online' | 'probing' | 'circuit';

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

/** 在线 AI 单步超时（毫秒）。超时即回退本地，避免对局停滞。 */
const ONLINE_TIMEOUT_MS = 6000;
/** 连续失败多少次后触发熔断（仅统计超时/网络故障，服务端忙不计入）。 */
const FAILURE_THRESHOLD = 2;
/** 熔断冷却时长（毫秒）：期间直接走本地，冷却后半开重试在线。 */
const CIRCUIT_COOLDOWN_MS = 30000;
/** 服务端返回 busy 时的退避重试间隔（毫秒）与最大重试次数：服务健康，不该熔断。 */
const BUSY_RETRY_DELAY_MS = 700;
const BUSY_MAX_RETRY = 2;
/** 冷却后半开健康探测的超时（毫秒）：只打 /api/v1/health，毫秒级即可判定。 */
const PROBE_TIMEOUT_MS = 3000;
/** NetInfo 状态缓存时长（毫秒）：避免每步都做一次系统网络查询。 */
const NETINFO_TTL_MS = 3000;

let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let everSucceeded = false;
let probeInFlight: Promise<boolean> | null = null;

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
  }
}

function recordOnlineSuccess(): void {
  consecutiveFailures = 0;
  everSucceeded = true;
  // 在线恢复正常，若曾熔断则立即解除
  circuitOpenUntil = 0;
}

/**
 * 引擎返回了可响应但走法不可用（坐标/规则校验失败）。
 * 归为引擎侧逻辑错误：重试无意义，但**不计入熔断**（网络与服务都是好的）。
 */
class OnlineAiInvalidMoveError extends OnlineAiError {}

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
  // 携带完整对局历史，使云端引擎在搜索中感知真实重复局面（长将/长捉/不变循环）
  const history: EngineHistory = buildEngineHistory(state);
  await ensurePlayerIdPrefix();
  // clientId 每次尝试唯一：服务端忙是"同 clientId 在飞"导致，唯一化后基本不会命中；
  // 仍命中时重试也必然是新槽位，不会再被自己挡住。
  const online = await fetchOnlineMove(
    fen,
    difficulty,
    ONLINE_TIMEOUT_MS,
    priority,
    makeRequestId(),
    history
  );
  const piece = state.pieces.find(
    (p) => p.alive && p.col === online.fromCol && p.row === online.fromRow
  );
  if (
    piece &&
    isOnlineMoveLegal(state, piece, online.toCol, online.toRow) &&
    isOnlineMoveRuleSafe(state, piece.id, online.toCol, online.toRow)
  ) {
    return { piece, online };
  }
  // 坐标异常/非法/违规着法属引擎侧逻辑错误，重试无意义
  throw new OnlineAiInvalidMoveError('在线走法未通过本地校验');
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
        // 服务端忙：服务健康，仅排队 → 退避后重试，不熔断
        if (err instanceof OnlineAiBusyError && attempt < BUSY_MAX_RETRY) {
          await new Promise(r => setTimeout(r, BUSY_RETRY_DELAY_MS));
          continue;
        }
        break;
      }
    }
    // 失败分类：仅「超时」与「网络故障」计入熔断；
    // 服务端忙（服务健康仅排队）与引擎逻辑错误都不熔断，否则会掐掉唯一能出棋的路径
    if (error instanceof OnlineAiTimeoutError || error instanceof OnlineAiNetworkError) {
      recordOnlineFailure();
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
 * - 'online'：最近一次在线请求成功。
 */
export function getOnlineAiStatus(): OnlineAiStatus {
  if (Date.now() < circuitOpenUntil) return 'circuit';
  if (!everSucceeded && consecutiveFailures > 0) return 'probing';
  return 'online';
}

/** 供调试/展示：当前是否处于熔断状态。 */
export function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}
