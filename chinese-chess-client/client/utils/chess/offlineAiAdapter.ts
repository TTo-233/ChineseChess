/**
 * 离线 AI 适配层：把「项目局面 + 档位」翻译成一次引擎搜索，并把结果送进既有守卫链。
 *
 * ============================================================================
 * 【为什么不直接让 aiDispatcher 调引擎】
 *
 * 引擎给出的只是一个 UCI 着法，而它**不能被直接采信**：
 *   · 皮卡鱼的合法着法生成本就不含"吃将"，历史里若有送将着法，它会**拒绝重放**，
 *     于是停在送将前的局面并返回**对方的着法**（历史上真实发生过）；
 *   · 项目另有长将长捉禁着（规则二），引擎并不知道这些状态。
 * 这些判据在线走法上已经有一套（aiDispatcher 的 assertOnlineMoveSide / isMoveKingSafe /
 * isMoveBanned），离线必须走**同一套**，否则会出现"联网不出事、断网出事"的割裂。
 *
 * 本模块因此是"在线/离线共用守卫"的那一层：把引擎结果与在线结果收敛到同一条出口。
 */

import { toFenString, buildEngineHistory, isFenBoardWidthValid, type GameState } from './GameEngine';
import { isMoveBanned } from './RuleEngine';
import { getValidMoves, isMoveKingSafe, makeMove } from './GameEngine';
import { RED_SIDE, BLACK_SIDE, type SideTag, type AIDifficulty } from './types';
import { internalToUci } from './pikafishUci';
import { getOfflineEngine } from './pikafish';
import { toAIMoveResult, OfflineEngineBadMoveError } from './offlineEngine';
import type { AIMoveSearchOutcome, AIMovePurpose } from './offlineAiTypes';
import type { AIMoveResult } from './AIEngine';

/** 本地引擎是否已真正就绪（供 ponder 门控使用） */
export function isLocalEngineReady(): boolean {
  try {
    return getOfflineEngine().getStatus().source === 'pikafish';
  } catch {
    return false;
  }
}

/** 本地引擎是否可用（含启动中，即不为 legacy） */
export function localEngineUsable(): boolean {
  try {
    return getOfflineEngine().getStatus().source !== 'legacy';
  } catch {
    return false;
  }
}

/** 引擎给出的着法未通过本地守卫 */
export class OfflineMoveRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'OfflineMoveRejectedError';
    this.reason = reason;
  }
}

/** 请求被取消（不算失败，调用方应静默丢弃） */
export class OfflineSearchAbortedError extends Error {
  constructor(message = '本地引擎搜索已取消') {
    super(message);
    this.name = 'OfflineSearchAbortedError';
  }
}

let requestSeq = 0;
const nextRequestId = (): string => `local-${Date.now().toString(36)}-${(requestSeq += 1).toString(36)}`;

/**
 * 取当前走棋方的**全部合法根着法**（UCI），作为引擎的 searchmoves 白名单。
 *
 * 为什么必须给白名单：引擎默认会考虑它认为合法的全部着法，其中可能包含
 * 「本项目规则会拒绝」的着法（禁着、以及任何规则口径差异）。给白名单等于
 * 让引擎只在允许的分支里搜索，从源头减少无效结果，而不是事后丢弃。
 *
 * 代价：根节点枚举要走一遍全部己方棋子的走法生成。正常局面约 40 个落点，
 * 相比一次 depth≥4 的搜索可忽略。
 */
function collectLegalRootMoves(state: GameState): string[] {
  const out: string[] = [];
  const moverIsRed = state.sideTag === RED_SIDE;
  for (let pieceId = 0; pieceId < 32; pieceId++) {
    const isRed = pieceId >= 16;
    if (isRed !== moverIsRed) continue;
    const piece = state.pieces[pieceId];
    if (!piece || !piece.alive) continue;
    const points = getValidMoves(state, pieceId);
    for (let col = 0; col < 9; col++) {
      for (let row = 0; row < 10; row++) {
        if (!points[col]?.[row]) continue;
        // 白名单只收"本地规则放行"的着法：不含送将、不在禁着列表内
        if (!isMoveKingSafe(state, pieceId, col, row)) continue;
        if (isMoveBanned(state, pieceId, col, row)) continue;
        const uci = internalToUci({ fromCol: piece.col, fromRow: piece.row, toCol: col, toRow: row });
        if (uci) out.push(uci);
      }
    }
  }
  return out;
}

/**
 * 模拟该着法后的规则后果，走子方是否会因此被判负。
 *
 * 与在线路径的 isOnlineMoveRuleSafe 同口径：因重复局面被判和/判对方胜属正常结果，
 * 不拦截；只有"走子方自己因长将长捉被判负"才丢弃。
 */
function isRuleSafeAfterMove(state: GameState, pieceId: number, toCol: number, toRow: number): boolean {
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
    // 模拟异常保守放行（合法性已由 getValidMoves 校验）
    return true;
  }
}

/**
 * 请求本地 AI 走一步。
 *
 * @param state     当前局面（不会被修改）
 * @param tier      难度档位；'hint' 为交互式提示（纯最佳确定性）
 * @param purpose   用途，决定优先级（move > hint > ponder）
 * @param signal    取消信号
 * @param movetimeCapMs 墙钟上限（ponder 用，见 OfflineSearchRequest.movetimeCapMs）
 */
export async function requestOfflineMove(
  state: GameState,
  tier: AIDifficulty | 'hint',
  purpose: AIMovePurpose,
  signal?: AbortSignal,
  movetimeCapMs?: number
): Promise<AIMoveSearchOutcome> {
  const startedAt = Date.now();
  const fen = toFenString(state);

  // 行宽异常会让 WASM 越界写内存（历史上打崩过整个 worker 池）。
  // 畸形局面直接放弃本地引擎，交给兜底 TS AI——它不会越界。
  if (!isFenBoardWidthValid(fen)) {
    throw new OfflineMoveRejectedError('本局面 FEN 行宽异常，已跳过本地引擎');
  }

  const engine = getOfflineEngine();
  const searchmoves = collectLegalRootMoves(state);
  if (searchmoves.length === 0) {
    // 无合法着法（将死/困毙/非法局面）：不该走到这里，交给上层处理终局
    throw new OfflineMoveRejectedError('当前局面没有合法着法');
  }

  // 第一次带历史（让引擎感知重复局面）；失败后重试**不带历史**。
  //
  // 背景（2026-10 审计 P1-3）：历史里含送将着法时皮卡鱼会拒绝重放，
  // 停在送将前的局面；而"着法被守卫拒收"现在**不再触发降级**（P0-2 修复），
  // 于是这一步会真的走不动。重试一次纯 fen 搜索可绕开整个历史重放问题，
  // 代价仅是本次搜索看不到重复局面感知 —— 换来的是"这一步总能走"。
  const attempts: Array<{ history: ReturnType<typeof buildEngineHistory> }> = [
    { history: buildEngineHistory(state) },
    { history: null },
  ];

  let lastError: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    const isRetry = i > 0;
    if (isRetry) {
      console.warn('[offlineAiAdapter] 带历史搜索未给出可用着法，重试纯 FEN 搜索');
    }
    if (signal?.aborted) throw new OfflineSearchAbortedError();

    let result;
    try {
      result = await engine.search({
        requestId: nextRequestId(),
        purpose,
        state,
        fen,
        history: attempts[i].history,
        tier,
        searchmoves,
        movetimeCapMs,
        signal,
      });
    } catch (err) {
      // 取消与"引擎不可用"直接上抛（前者要静默、后者由编排器降级）；
      // 只有"着法不可用"才值得换一种方式再试。
      if (err instanceof OfflineSearchAbortedError || isAbortLike(err)) throw err;
      if (!isBadMoveLike(err)) throw err;
      lastError = err;
      continue;
    }

    if (signal?.aborted) throw new OfflineSearchAbortedError();

    const candidate = toAIMoveResult(state, result);
    if (!candidate) {
      lastError = new OfflineMoveRejectedError(`引擎着法 ${result.uci} 的起点无活子`);
      continue;
    }

    // —— 与在线走法完全一致的三重守卫 ——
    // 1) 走法形状合法（起点必须是己方活子）
    const points = getValidMoves(state, candidate.pieceId);
    if (!points[candidate.toCol]?.[candidate.toRow]) {
      lastError = new OfflineMoveRejectedError(`走法 ${result.uci} 不在合法落点内`);
      continue;
    }
    // 2) 不送将
    if (!isMoveKingSafe(state, candidate.pieceId, candidate.toCol, candidate.toRow)) {
      lastError = new OfflineMoveRejectedError(
        `走法 ${result.uci} 会让己方将/帅继续被攻击（送将）`
      );
      continue;
    }
    // 3) 不触发禁着/长将长捉判负
    if (!isRuleSafeAfterMove(state, candidate.pieceId, candidate.toCol, candidate.toRow)) {
      lastError = new OfflineMoveRejectedError(`走法 ${result.uci} 触发禁着或长将长捉判负规则`);
      continue;
    }

    return {
      ...candidate,
      // 引擎标识：反映的是"最终真正算这一步的实现"，必须读编排器盖的章 ——
      // 硬编码 'pikafish' 会把编排器内部降级（引擎启动中/永久不可用）时
      // 由 TS 兜底算出的着法虚报成皮卡鱼（2026-10 审计 P1）。
      // servedBy 缺失按 'pikafish' 处理（兼容不经编排器的测试桩，见 offlineEngine 说明）。
      engine: result.servedBy === 'legacy' ? 'legacy' : 'pikafish',
      depth: result.depth,
      timeMs: result.timeMs || Date.now() - startedAt,
      purpose,
    };
  }

  // 两次都失败：抛最后一次的原因（不降级，由调用方回退兜底 AI）
  throw lastError instanceof Error
    ? lastError
    : new OfflineMoveRejectedError('本地引擎未给出可用着法');
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** 是否是"着法不可用"（值得换方式重试），而非"引擎不可用"（该上抛给编排器降级） */
function isBadMoveLike(err: unknown): boolean {
  return err instanceof OfflineEngineBadMoveError;
}


/* -------------------------------------------------------------------------- */
/* 生命周期                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 换局：通知编排器清空跨局状态与排队中的预计算。
 *
 * 必要性：引擎每次搜索都会带 `ucinewgame`（清置换表），但**编排器队列**里
 * 可能还挂着上一局排队中的请求。不清的话，它会在新局面上完成并被当作
 * 本局的着法（局面指纹虽由调用方守卫兜住，但白白浪费一次搜索预算，
 * 且旧局面的 result 深度/评估对新局面无意义）。
 */
export function notifyOfflineNewGame(): void {
  cancelOfflinePonder();
  try {
    getOfflineEngine().newGame();
  } catch {
    /* 忽略 */
  }
}

/**
 * 中止当前本地搜索。
 *
 * 与 abortSearch（TS AI）配对使用：悔棋/重开/翻转/离场时必须同时中止两个引擎，
 * 否则本地皮卡鱼会继续占着唯一的引擎实例（它是同步阻塞的），
 * 让重置后的新搜索排队——表现为"悔棋后要干等几秒才动"。
 *
 * ⚠️ 已知限制：WASM 搜索在引擎线程内是**同步**的，stop 消息要等本次搜索
 *    结束才会被处理，因此无法真正"中途打断"。但上层会**丢弃**迟到结果
 *    （代数票据），用户感知上仍是即时的。
 */
export function cancelOfflineSearch(): void {
  try {
    getOfflineEngine().stop();
  } catch {
    /* 忽略 */
  }
}

/* -------------------------------------------------------------------------- */
/* 后台预计算（ponder）                                                        */
/* -------------------------------------------------------------------------- */

/**
 * ponder 的墙钟上限。hint 档是 8s，但引擎同步且全局仅一个实例——
 * 占满 8s 会把随后排队的正式走子挤到 busy 兜底。2.5s 让"点提示"仍能
 * 大概率命中，又把最坏占用压到玩家基本无感（详见 OfflineSearchRequest.movetimeCapMs）。
 */
const PONDER_MOVETIME_CAP_MS = 2500;

interface PonderEntry {
  hash: number;
  historyLen: number;
  sideTag: boolean;
  done: boolean;
  /**
   * 结果用 AIMoveSearchOutcome（而非 AIMoveResult）：必须保留 engine 字段，
   * 否则"这一步到底是谁算的"会在 ponder 缓存这一跳丢失 —— 命中提示时只能
   * 回退去查引擎的**当前**状态，从而把 TS 兜底着法误标成皮卡鱼（2026-10 审计 P1）。
   */
  result: AIMoveSearchOutcome | null;
  promise: Promise<AIMoveSearchOutcome | null>;
  controller: AbortController;
}

let ponderEntry: PonderEntry | null = null;

/** 局面指纹匹配：防止过期预计算结果被误用到新局面上 */
function ponderMatches(entry: PonderEntry, state: GameState): boolean {
  return (
    entry.hash === state.zobristHash &&
    entry.historyLen === state.moveHistory.length &&
    entry.sideTag === state.sideTag
  );
}

/**
 * 启动后台预计算（玩家思考期间跑提示搜索，点击「提示」时命中缓存）。
 *
 * ============================================================================
 * 【为什么不再用 AIEngine.precomputeHint】
 *
 * 那条链路是为**旧 TS AI** 设计的，它跑在 JS 主线程：一次 hard 搜索要 2500ms
 * 且占满主线程（实测 99.2% 占空比）。接入本地皮卡鱼后有两处不再合适：
 *   1. 提示已改由本地皮卡鱼出，旧 TS 的结果**根本不会被消费**，纯属白烧 CPU；
 *   2. 引擎在 Worker/WebView 里，主线程不再被占，不需要再等"闲时窗口"
 *      （那层保护本就是为不让预计算抢主线程才加的）。
 *
 * 现在预计算直接走本地皮卡鱼，优先级最低（purpose='ponder'），
 * 随时可被正式的 AI 走子或用户点提示抢占。
 */
export function precomputeOfflineHint(state: GameState): void {
  if (state.gameStatus !== 'playing') return;
  // ⚠️ 2026-10 实测：引擎启动中（starting）时别落 TS AI——那会在主线程占满
  // ponder cap，还缓存一个"标着皮卡鱼其实是 TS"的结果。本地引擎已就绪
  //（pikafish）才值得跑 ponder。
  if (!isLocalEngineReady()) {
    cancelOfflinePonder();
    return;
  }
  if (ponderEntry && ponderMatches(ponderEntry, state)) return; // 已在算/已完成
  cancelOfflinePonder();

  const controller = new AbortController();
  const entry: PonderEntry = {
    hash: state.zobristHash,
    historyLen: state.moveHistory.length,
    sideTag: state.sideTag,
    done: false,
    result: null,
    promise: Promise.resolve(null),
    controller,
  };
  ponderEntry = entry;

  entry.promise = (async () => {
    // 让走棋动画/音效/UI 先完成渲染再启动（沿用既有 250ms 让步）
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    if (ponderEntry !== entry) return null;
    try {
      const outcome = await requestOfflineMove(
        state,
        'hint',
        'ponder',
        controller.signal,
        PONDER_MOVETIME_CAP_MS
      );
      // 搜索期间被取消或局面已变 → 结果不入缓存
      if (ponderEntry === entry) {
        entry.done = true;
        entry.result = outcome;
      }
      return outcome;
    } catch {
      // 取消 / 引擎不可用：静默丢弃，点提示时再现场算
      return null;
    }
  })();
}

/** 取消后台预计算（玩家走棋/悔棋/重开/离场前调用） */
export function cancelOfflinePonder(): void {
  if (ponderEntry && !ponderEntry.done) {
    ponderEntry.controller.abort();
    try {
      getOfflineEngine().stop();
    } catch {
      /* 忽略 */
    }
  }
  ponderEntry = null;
}

/**
 * 取后台预计算的提示结果。
 *
 * - 命中且已完成 → 立即返回（零等待）
 * - 命中但仍在算 → 返回其 promise（比重新发起一次搜索更快）
 * - 未命中 → null，由调用方现场搜索
 */
export function takeOfflinePonder(state: GameState): Promise<AIMoveSearchOutcome | null> | null {
  if (ponderEntry && ponderMatches(ponderEntry, state)) {
    if (ponderEntry.done) {
      const r = ponderEntry.result;
      ponderEntry = null;
      return Promise.resolve(r);
    }
    return ponderEntry.promise;
  }
  return null;
}

/** 预热本地引擎（App 启动时调用） */
export function warmupOfflineEngine(): void {
  // 延到下一宏任务，避免与首屏渲染抢同一帧
  setTimeout(() => {
    try {
      void getOfflineEngine().warmup();
    } catch {
      /* 忽略：预热失败只影响首步速度 */
    }
  }, 0);
}

/**
 * 立即重试启动本地引擎（忽略退避冷却）。
 *
 * 用于"引擎大概率刚刚恢复"的时机：从后台回到前台（移动端 WebView 可能已被
 * 系统回收并重新挂载）、或用户手动重开。不这么做的话要等满退避（最长 30s）
 * 才会自动重试，用户会看到一段"基础AI"。
 */
export function retryOfflineEngineNow(): void {
  try {
    getOfflineEngine().retryNow();
  } catch {
    /* 忽略 */
  }
}

