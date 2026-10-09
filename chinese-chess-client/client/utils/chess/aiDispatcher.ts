/**
 * AI 调度器：**纯本地**（本地皮卡鱼 → 旧 TS AI 兜底），不发起任何网络请求。
 *
 * ============================================================================
 * 【2026-10 服务端去 AI 化：在线分支已整体移除】
 *
 * 此前这里是「混合调度」：本地皮卡鱼优先，本地不可用才回退服务端在线皮卡鱼
 * （/api/v1/ai/move），并带一整套配套机制——NetInfo 预判、2s 超时、busy 指数退避、
 * 熔断与半开自愈、主动重连定时器，以及给 UI 订阅的在线状态角标。
 *
 * 服务端 AI 已移除后，那条回退路径**只剩代价、没有收益**：
 *   · 端点不存在 → 每步都要白跑一次注定 404 的请求，再吃一次超时；
 *   · 连续失败打开熔断后，"重连中"角标会常驻——这正是 2026-10 用户实测反馈的
 *     那个误导性提示的同一条路径，删掉服务端反而更容易复发；
 *   · 棋力并不会变强（难度档位本就同源，在线唯一的独有优势只有开局库）。
 *
 * 因此这里删除 onlineAI / onlineMoveGuard 与全部熔断重连状态机，语义收敛为：
 * **本地皮卡鱼 → 旧 TS AI 两层兜底，永远不联网**。
 *
 * 保留的只有一样东西：引擎来源标签（'pikafish-local' / 'pikafish-starting' / 'legacy'），
 * UI 靠它如实显示"这一步是谁算的"。
 * ============================================================================
 * 【离线侧是"本地皮卡鱼"，不再是纯 TS 搜索】
 *
 * 本地实现是**本地皮卡鱼**（utils/chess/pikafish/）：Web 走 Worker+WASM，
 * Android/iOS 走屏幕外 WebView，引擎与二进制随包内置，因此**完全断网可用**。
 * 难度档位定义在 utils/chess/pikafishTier.ts（唯一来源，客户端自持）。
 *
 * 旧 TS AI（AIEngine.ts）是**最后的兜底**：仅在本地皮卡鱼不可用时启用
 * （资产缺失/承载不支持/引擎崩溃）。详见 utils/chess/pikafish/offlineOrchestrator.ts。
 */

import { getBestMoveAsync, getHintMoveAsync, type AIMoveResult } from './AIEngine';
import {
  requestOfflineMove,
  takeOfflinePonder,
  OfflineSearchAbortedError,
} from './offlineAiAdapter';
import { getOfflineEngine } from './pikafish';
import { isMoveKingSafe, type GameState } from './GameEngine';
import type { AIDifficulty } from './types';

export interface HybridMoveResult extends AIMoveResult {
  /**
   * 走法来源引擎：
   *   · 'pikafish-local'=**客户端本地皮卡鱼**、'pikafish-starting'=引擎仍在启动
   *     （这一步暂由兜底 AI 算出，会自动升级）、'legacy'=旧 TS AI 兜底
   * 带 engine 是为了区分"真引擎"与"兜底"——两者棋力差一个量级，
   * UI 必须能让用户看出当前用的是哪一档（否则升级后毫无感知）。
   */
  engine?: string;
  depth?: number;
  timeMs?: number;
}


/**
 * 统一出口过滤：着法在交给界面落子前，必须确认它不会送将。
 *
 * 本地 AI 与本地提示的搜索本就逐层用 isSideInCheck 过滤（见 AIEngine），正常不会
 * 产出送将着法；这里仍做一道出口断言，因为送将的后果不是"下得差一点"，而是
 * **盘面进入非法状态且无法靠对方补救**（皮卡鱼不吃将，对局会永久僵在非法局面）。
 * 判据与落子闸门（screens/game、screens/lanBattle）共用同一个 isMoveKingSafe，
 * 三处口径一致。
 */
function rejectMoverUnsafe(state: GameState, move: AIMoveResult | null): AIMoveResult | null {
  if (!move) return null;
  if (isMoveKingSafe(state, move.pieceId, move.toCol, move.toRow)) return move;
  return null;
}

/**
 * 离线执行：优先本地皮卡鱼，失败再退到旧 TS AI。
 *
 * 为什么要**两层**：本地皮卡鱼需要加载 6MB 引擎 + 实例化 WASM（冷启动有耗时），
 * 且在极少数环境（资产缺失、CSP 拦 Worker、WebView 起不来）根本不可用。
 * 若直接依赖它，一次失败就会让对局卡在「AI 回合」——玩家点不动棋子、也没有下一步。
 * 旧 TS AI 永远可用（纯 JS，无外部资产），因此它必须留在最后一层。
 *
 * 取消（AbortError / OfflineSearchAbortedError）**不**降级：
 * 那意味着"用户悔棋/重开/离场了"，此时应静默丢弃，而不是让兜底 AI 白算一步。
 */
async function runOffline(
  state: GameState,
  tier: AIDifficulty | 'hint',
  purpose: 'move' | 'hint'
): Promise<{ move: AIMoveResult; engine: string; depth: number; timeMs: number } | null> {
  const startedAt = Date.now();

  /**
   * 揭棋：皮卡鱼**只懂象棋**，喂给它揭棋 FEN 只会得到垃圾着法或直接报错，
   * 所以揭棋必须在入口就短路到本地 TS 引擎（它已支持揭棋，见 AIEngine 揭棋分支）。
   *
   * ⚠️ 这道闸必须在 `requestOfflineMove` **之前**：引擎不认揭棋，
   * 让它先跑一遍只会浪费一整个时间预算（hard 档 2.5s）再回落，
   * 表现为「揭棋 AI 每步都慢半拍」。
   *
   * 不走 runOffline 的 catch 兜底：那是给「引擎不可用」用的降级路径，
   * 揭棋是**永久性**的能力缺失，走降级路径会让 engine 标签显示成
   * 「皮卡鱼启动中」，虚报棋力来源（与 resolveOfflineEngineLabel 的注释同源问题）。
   */
  if (state.variant === 'jieqi') {
    const jieqiTier = tier === 'hint' ? 'hard' : tier;
    const move = tier === 'hint'
      ? await getHintMoveAsync(state)
      : await getBestMoveAsync(state, jieqiTier);
    const safe = rejectMoverUnsafe(state, move);
    if (!safe) return null;
    // 标签固定 'legacy'：现有 UI 只有三种标签，'legacy' 在 UI 上表示
    // 「本地基础 AI」，对揭棋而言是准确的（首版无揭棋专用引擎）。
    return { move: safe, engine: 'legacy', depth: 0, timeMs: Date.now() - startedAt };
  }

  try {
    const outcome = await requestOfflineMove(state, tier, purpose);
    // requestOfflineMove 已过三重守卫；这里再确认一次送将（与在线路径同构的出口断言）
    if (!rejectMoverUnsafe(state, outcome)) return null;
    return {
      move: outcome,
      // 引擎标签由「编排器对**这一步**盖的章」决定（outcome.engine），
      // 而不是事后查全局状态（2026-10 审计 P1 竞态修复）：
      // 事后查状态在"引擎恰好在兜底搜索期间启动完成"时，会把 TS 兜底算出的着法
      // 标成"皮卡鱼（绿灯）"。getStatus() 现在只用来区分兜底的两种**性质**——
      // 引擎还在启动/重试（会自动升级）vs 已判永久不可用（本局一直兜底）。
      engine: resolveOfflineEngineLabel(outcome.engine),
      depth: outcome.depth,
      timeMs: outcome.timeMs || Date.now() - startedAt,
    };
  } catch (err) {
    if (err instanceof OfflineSearchAbortedError || isAbortLike(err)) {
      // 取消：调用方应丢弃，不产生任何着法
      return null;
    }
    console.warn('[aiDispatcher] 本地皮卡鱼未给出可用着法，回退兜底 TS AI:', describeError(err));
  }

  // 兜底：旧 TS AI（提示走 hard 预算；产品难度各档有自身预算）
  const fallbackTier = tier === 'hint' ? 'hard' : tier;
  const fallback = tier === 'hint' ? await getHintMoveAsync(state) : await getBestMoveAsync(state, fallbackTier);
  if (!fallback) return null;
  const safe = rejectMoverUnsafe(state, fallback);
  if (!safe) return null;
  return { move: safe, engine: 'legacy', depth: 0, timeMs: Date.now() - startedAt };
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * 把「这一步由谁算出」＋「引擎当前状态」翻译成 UI 标签。
 *
 * 输入 `servedBy` 是编排器为**本次搜索**盖的章（'pikafish' | 'legacy'），
 * 是"谁算的"的唯一权威来源；`getStatus()` 只用来在**兜底**情形下区分性质。
 *
 * · 'pikafish-local'    —— 这一步确实由本地皮卡鱼算出（绿灯）
 * · 'pikafish-starting' —— 这一步是兜底，且引擎仍在启动/冷却重试（会自动升级）
 * · 'legacy'            —— 这一步是兜底，且引擎已判永久不可用（本局一直兜底）
 *
 * 为什么不能只查 getStatus()（2026-10 审计 P1 竞态）：
 * 兜底 TS 搜索可能持续 0.5~2.5s，期间引擎可能刚好启动完成，于是搜索**结束后**
 * 查到的状态是 'pikafish'，而这一步实际是 TS 算的 —— 界面就会给兜底着法点绿灯、
 * 显示"皮卡鱼（难度）"，虚报棋力来源一个量级。按盖章判定则不受时序影响。
 */
function resolveOfflineEngineLabel(
  servedBy?: 'pikafish' | 'legacy'
): 'pikafish-local' | 'pikafish-starting' | 'legacy' {
  // 这一步由真引擎算出：与当前状态无关，恒为"皮卡鱼已就绪"
  if (servedBy !== 'legacy') return 'pikafish-local';
  // 兜底：用状态区分"会自动升级"与"已永久降级"
  try {
    const s = getOfflineEngine().getStatus().source;
    return s === 'pikafish' || s === 'starting' ? 'pikafish-starting' : 'legacy';
  } catch {
    return 'legacy';
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * 获取 AI 的最佳走法（纯本地，永不联网）。
 *
 * 2026-10 服务端去 AI 化后，原先的 `getHybridBestMove`（混合：本地优先 + 在线兜底）
 * 与 `getHybridBestMoveLocal`（残局专用、显式纯本地）**语义已完全相同** ——
 * 两者都只会走本地皮卡鱼 → 旧 TS AI。因此这里合并为一个入口，
 * 避免调用方再按"要不要联网"做无意义的区分。
 *
 * 返回的 `engine` 标明这一步究竟是谁算的：
 * 'pikafish-local' / 'pikafish-starting' / 'legacy'。
 */
export async function getBestMoveOffline(
  state: GameState,
  difficulty: AIDifficulty
): Promise<HybridMoveResult | null> {
  const offline = await runOffline(state, difficulty, 'move');
  if (!offline) return null;
  return {
    ...offline.move,
    engine: offline.engine,
    depth: offline.depth,
    timeMs: offline.timeMs,
  };
}

/**
 * 获取"提示"走法（纯本地，永不联网）。
 *
 * 固定最高强度且完全确定：走**本地皮卡鱼 hint 档**（multiPV=1、depth=8、纯最佳，
 * 同一局面结果恒定），搜索前清置换表。
 *
 * 先取后台预计算：玩家思考期间已经在算（或已算完），复用比重新搜索更快，
 * 且完全离线也有效。预计算失败/被拒再落到现场搜索。
 */
export async function getHintMoveOffline(state: GameState): Promise<HybridMoveResult | null> {
  const pondered = takeOfflinePonder(state);
  if (pondered) {
    const p = await pondered;
    if (p && rejectMoverUnsafe(state, p)) {
      // 标签用预计算结果自带的 engine（编排器在算那一步时盖的章），
      // 而不是此刻重查状态：预计算可能在引擎降级/升级**之后**才完成，
      // 重查状态会把"谁算的"搞错（2026-10 审计 P1）。
      return { ...p, engine: resolveOfflineEngineLabel(p.engine) };
    }
    // 预计算失败/被拒 → 落到下面的现场搜索
  }
  const offline = await runOffline(state, 'hint', 'hint');
  if (!offline) return null;
  return { ...offline.move, engine: offline.engine, depth: offline.depth, timeMs: offline.timeMs };
}
