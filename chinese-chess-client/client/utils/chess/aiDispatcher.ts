/**
 * 混合 AI 调度器：联网优先调用服务端皮卡鱼（在线），网络不可用/不稳定时回退本地 AI（离线）。
 *
 * 策略：
 * 1. 网络预判：通过 NetInfo 检测连接状态；明确离线则直接走本地 AI，避免无效请求。
 * 2. 在线尝试：带严格超时（ONLINE_TIMEOUT_MS）；成功则采用云端走法。
 * 3. 失败回退：在线失败/超时立即回退本地 AI，保证对局不卡死。
 * 4. 熔断器：连续失败达到阈值后短暂"熔断"，期间直接走本地 AI，
 *    冷却期（半开）后再尝试在线，避免弱网下每步都白白等待超时。
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
import { fetchOnlineMove } from './onlineAI';
import { isMoveBanned } from './RuleEngine';
import { getPlayerId } from '@/utils/playerIdentity';

export type AISource = 'online' | 'offline';

export interface HybridMoveResult extends AIMoveResult {
  source: AISource;
  depth?: number;
  timeMs?: number;
  /** 在线走法来源引擎：'book'=开局库（depth 恒为 0）；'pikafish'=皮卡鱼搜索；离线无此字段 */
  engine?: string;
}

/** 缓存的客户端标识（持久化玩家 ID），用于服务端每用户限流 */
let cachedClientId: string | null = null;
async function getClientId(): Promise<string | undefined> {
  if (cachedClientId) return cachedClientId;
  try {
    cachedClientId = await getPlayerId();
    return cachedClientId;
  } catch {
    return undefined;
  }
}

/** 在线 AI 单步超时（毫秒）。超时即回退本地，避免对局停滞。 */
const ONLINE_TIMEOUT_MS = 6000;
/** 连续失败多少次后触发熔断。 */
const FAILURE_THRESHOLD = 2;
/** 熔断冷却时长（毫秒）：期间直接走本地，冷却后半开重试在线。 */
const CIRCUIT_COOLDOWN_MS = 30000;

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

/** 检测当前是否允许尝试在线 AI。 */
async function isOnlineAllowed(): Promise<boolean> {
  // 熔断期内直接走本地
  if (Date.now() < circuitOpenUntil) {
    return false;
  }
  try {
    const state = await NetInfo.fetch();
    // 明确未连接 → 不尝试在线；isInternetReachable 为 null（未判定）时仍尝试，由超时兜底
    if (state.isConnected === false) {
      return false;
    }
    if (state.isInternetReachable === false) {
      return false;
    }
    return true;
  } catch {
    // 网络检测本身失败时，仍尝试在线（由超时与熔断兜底）
    return true;
  }
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
  // 在线恢复正常，若曾熔断则立即解除
  circuitOpenUntil = 0;
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
 * 长将长捉禁着期间（方案 10.3）禁对着法同样拦截，云端开局库不感知禁着状态。
 *
 * @returns true=走法可用；false=走子方会因此着法被判负或违反禁着，应回退本地
 */
function isOnlineMoveRuleSafe(state: GameState, pieceId: number, toCol: number, toRow: number): boolean {
  // 禁着拦截（走子方为被禁方且该着法在禁着列表内）
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
  const onlineAllowed = await isOnlineAllowed();

  if (onlineAllowed) {
    try {
      const fen = toFenString(state);
      const clientId = await getClientId();
      // 携带完整对局历史，使云端引擎在搜索中感知真实重复局面（长将/长捉/不变循环）
      const history = buildEngineHistory(state);
      const online = await fetchOnlineMove(fen, difficulty, ONLINE_TIMEOUT_MS, 0, clientId, history);
      // 按云端返回的内部坐标定位棋子
      const piece = state.pieces.find(
        (p) => p.alive && p.col === online.fromCol && p.row === online.fromRow
      );
      if (
        piece &&
        isOnlineMoveLegal(state, piece, online.toCol, online.toRow) &&
        isOnlineMoveRuleSafe(state, piece.id, online.toCol, online.toRow)
      ) {
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
      }
      // 坐标异常、走法非法或违规着法（长将/长捉判负），按失败处理回退本地
      recordOnlineFailure();
    } catch {
      recordOnlineFailure();
    }
  }

  // 回退：本地离线 AI（难度与代码保持不变）
  const offline = await getBestMoveAsync(state, difficulty);
  if (!offline) {
    return null;
  }
  return { ...offline, source: 'offline' };
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
  const onlineAllowed = await isOnlineAllowed();

  if (onlineAllowed) {
    try {
      const fen = toFenString(state);
      const clientId = await getClientId();
      // 携带完整对局历史，使云端引擎在搜索中感知真实重复局面（长将/长捉/不变循环）
      const history = buildEngineHistory(state);
      // 提示=当前局面最佳着法：hint 难度（服务端皮卡鱼深度 8、MultiPV 1、纯最佳确定性，
      // 同一局面恒定返回同一着法）+ 高优先级插队
      const online = await fetchOnlineMove(fen, 'hint', ONLINE_TIMEOUT_MS, 1, clientId, history);
      const piece = state.pieces.find(
        (p) => p.alive && p.col === online.fromCol && p.row === online.fromRow
      );
      if (
        piece &&
        isOnlineMoveLegal(state, piece, online.toCol, online.toRow) &&
        isOnlineMoveRuleSafe(state, piece.id, online.toCol, online.toRow)
      ) {
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
      }
      // 坐标异常、走法非法或违规着法（长将/长捉判负），按失败处理回退本地
      recordOnlineFailure();
    } catch {
      recordOnlineFailure();
    }
  }

  // 回退：本地提示搜索（hard 深度、确定性，优先命中后台预计算缓存）
  const offline = await getHintMoveAsync(state);
  if (!offline) {
    return null;
  }
  return { ...offline, source: 'offline' };
}

/** 供调试/展示：当前是否处于熔断状态。 */
export function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}
