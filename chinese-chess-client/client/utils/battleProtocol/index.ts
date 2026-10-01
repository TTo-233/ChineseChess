/**
 * 在线对局协议：动作发送与失败语义
 *
 * 见 ./types.ts 顶部说明（为何要收口协议层）。
 *
 * 本模块只做一件事：把「发送一个动作并拿到服务端裁决」这件事的**失败语义**标准化，
 * 让页面不必再区分「帧没发出去」和「服务端拒绝了」——这两者的后续处理完全相反：
 *
 * - `BattleActionNotSentError`：连接不可用，帧根本没发出去 → 调用方应走 HTTP 兜底；
 * - `BattleActionRejectedError`：服务端已明确裁决失败（4xx）→ **绝不能**回退 HTTP
 *   （那会绕过裁决），应回退本地乐观更新并提示原因；
 * - `BattleActionTimeoutError`：帧发出但等不到回执（服务端无响应/半开连接）→
 *   结果未知，按失败处理（回退本地乐观更新）并提示，同样不回退 HTTP。
 */
import type { BattleActionType, BattleMove } from './types';

export * from './types';

/**
 * 动作回执等待上限。
 *
 * 服务端各动作处理器是纯内存操作（无 AI 调用），实测响应在 600ms 量级（aiDispatcher
 * 记录的线上 p50 523ms / max 550ms 是 AI 接口的口径）。取 5s 是为了容忍弱网下的往返，
 * 同时远小于走子乐观保护的 8s 窗口——超时后本地乐观更新必须回退，否则棋子会长期
 * 停在一个服务端从未接受的位置。
 */
export const ACTION_ACK_TIMEOUT_MS = 5000;

/** 连接不可用，帧未发出：调用方应回退 HTTP 兜底 */
export class BattleActionNotSentError extends Error {
  constructor(readonly action: BattleActionType) {
    super(`WebSocket 未连接，${action} 未发出`);
    this.name = 'BattleActionNotSentError';
  }
}

/** 服务端明确拒绝（status >= 400）：不得回退 HTTP，应回退本地乐观更新并提示 */
export class BattleActionRejectedError extends Error {
  constructor(
    readonly action: BattleActionType,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BattleActionRejectedError';
  }
}

/** 回执超时：结果未知，按失败处理（回退本地乐观更新） */
export class BattleActionTimeoutError extends Error {
  constructor(readonly action: BattleActionType) {
    super('服务端长时间未响应，请检查网络后重试');
    this.name = 'BattleActionTimeoutError';
  }
}

/**
 * 发送动作的最小能力契约（BattleSocket 实现之）。
 *
 * 刻意不直接依赖 BattleSocket 类：便于在测试中以极简替身注入，
 * 也让本模块不必引入 serverConfig 等运行时依赖。
 */
export interface BattleActionTransport {
  request(type: BattleActionType, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** 动作类型 → 负载形状映射（与 types.ts 的 BattleActionPayloads 保持一致） */
export interface BattleActionPayloadMap {
  move: { move: BattleMove };
  surrender: Record<string, never>;
  undo: { proposedState: unknown };
  undoResponse: { agreed: boolean };
  draw: Record<string, never>;
  drawResponse: { agreed: boolean };
  emoji: { emoji: string; id: string };
}

/**
 * 发送一个动作并等待服务端裁决。
 *
 * 失败一律以 Error 抛出（见上方三个错误类），**成功路径只表示服务端接受了该动作**；
 * 局面变更仍由服务端随后的 state 广播送达（`status < 400` 时服务端会广播，见
 * types.ts 中 BattleAckFrame 的说明）。
 */
export async function emitBattleAction<K extends keyof BattleActionPayloadMap>(
  transport: BattleActionTransport | null | undefined,
  type: K,
  payload: BattleActionPayloadMap[K],
): Promise<Record<string, unknown>> {
  if (!transport) throw new BattleActionNotSentError(type);
  return transport.request(type, payload as unknown as Record<string, unknown>);
}

/** 是否属于「帧未发出」类失败（调用方据此决定是否走 HTTP 兜底） */
export function isActionNotSent(error: unknown): error is BattleActionNotSentError {
  return error instanceof BattleActionNotSentError;
}
