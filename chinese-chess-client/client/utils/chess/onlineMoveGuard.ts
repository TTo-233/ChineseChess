/**
 * 在线 AI 着法的**入口守卫**（纯函数，无任何存储/网络依赖）。
 *
 * 单独成模块的原因：aiDispatcher 依赖链里有 AsyncStorage / NetInfo 等原生模块
 * （经 onlineAI → serverConfig、playerIdentity），Jest 下无法直接加载，导致这里的
 * 纯判据没法被单测覆盖。把守卫抽出来之后：
 *   · 单测只 import 本模块 + GameEngine，零原生依赖；
 *   · aiDispatcher 从本模块取用，调用点与语义不变。
 *
 * ============================================================================
 * 【为什么需要"归属方与回合"这一关 · 2026-09 实测】
 *
 * 服务端在请求带 moves 时**完全忽略 fen**，只按 startFen+moves 重建局面。若历史里含
 * 一步送将，Pikafish 会**拒绝重放**该步，棋盘于是停在送将**之前**的局面——那一手
 * 轮到的是对方，引擎就返回**对方的着法**（实测：请求红方着法，返回 (4,4)->(4,5)
 * 这种黑方起点的着法）。
 *
 * 而这种着法有时恰好能通过 getValidMoves（起点上真有活子、落点也符合该子走法），
 * 会被当成合法在线着法直接采纳。因此采纳前必须确认：
 *   a) 起点上有**存活**棋子（否则"起点无活子"，服务端返回了别处的着法）；
 *   b) 该棋子属于**当前走棋方**（state.sideTag），而不是对方。
 * 不满足就抛错，由 runHybrid 回退本地 AI 并在 UI 暴露原因——绝不把非法着法落进盘面。
 */

import type { GameState, PieceState } from './GameEngine';
import { RED_SIDE } from './types';

/**
 * 在线着法未通过本地守卫（坐标/归属方/回合/规则）。
 *
 * 语义上等价于 aiDispatcher 的 `OnlineAiInvalidMoveError`，但**不继承**它：本模块
 * 不能反向依赖 aiDispatcher（那会把原生模块依赖重新引进来）。aiDispatcher 在入口处
 * 单独做一次 `instanceof` 转换，把本类折叠成自己的错误类型。
 */
export class OnlineMoveGuardError extends Error {
  /** 拒收的具体原因，会进 aiDispatcher 的 lastInvalidMoveReason 供 UI 展示。 */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'OnlineMoveGuardError';
    this.reason = reason;
  }
}

/**
 * 校验在线着法的起点子是否存在、存活、且属于当前走棋方；通过则返回该棋子。
 *
 * @throws OnlineMoveGuardError 起点无活子，或起点棋子不属于当前走棋方
 */
export function assertOnlineMoveSide(
  state: GameState,
  move: { uci: string; fromCol: number; fromRow: number }
): PieceState {
  const source = state.qiPan[move.fromCol]?.[move.fromRow] ?? -1;
  const piece = source >= 0 ? state.pieces[source] : undefined;
  if (!piece || !piece.alive) {
    throw new OnlineMoveGuardError(
      `起点 (${move.fromCol},${move.fromRow}) 无活子（服务端返回 ${move.uci}）`
    );
  }
  const pieceIsMover = state.sideTag === RED_SIDE ? piece.id >= 16 : piece.id < 16;
  if (!pieceIsMover) {
    throw new OnlineMoveGuardError(
      `走法 ${move.uci} 的起点 ${piece.id} 不属于当前走棋方（服务端着法归属方/回合错误）`
    );
  }
  return piece;
}
