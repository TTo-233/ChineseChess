/**
 * 【第 3 批 / §8 表 #1、#5 + §9 失败响应形状】跨通道动作结算的**唯一**实现。
 *
 * 改造前的两处重复实现（同一个语义写两遍、其中一处后来加固了另一处没有）：
 *   A. `lanGame.ts` 的 `respondAction(res, roomId, result)` —— HTTP 通道；
 *   B. `battleWs.ts` 的 `handleMessage` 尾部 —— WebSocket 通道。
 * B 只在 `status < 400` 广播，被拒动作不回推权威状态（客户端停在乐观更新后的画面）；
 * A 额外维护了被拒回推的按房间限流。现在两边都调 `settleActionOutcome`，口径无法再分叉。
 *
 * 同时把失败响应收敛成**一种**形状（§9「统一失败响应形状」）：
 *   `{ success: false, error: <机器可读码>, message: <可展示文案>, ...附加字段 }`
 * `error` 是稳定的 snake_case 码（客户端按它分支，不解析文案），
 * `message` 是直接展示给用户的文案。
 * 改造前同一语义有三种形状并存：`{ success:false, message }`、`{ error }`（且 error 装的是中文文案）、
 * WS 的 `{ type:'error', message }`——客户端因此要在多处做 `body.message ?? body.error` 的双读兜底
 * （`client/utils/battleProtocol/types.ts` 的 `battleAckMessage`）。
 */

import type { Response } from 'express';

// ============================================================================
// 1. 失败响应的唯一形状
// ============================================================================

/**
 * 失败码（`error` 字段的取值域）。按 HTTP 状态码归类，便于客户端按码分支、便于日志聚合。
 * 新增失败场景一律复用已有码；确实需要新语义时在此登记，**不要**直接把中文塞进 `error`。
 */
export const FAILURE_CODES = [
  'bad_request',      // 400 请求参数或当前状态不接受该操作
  'unauthorized',     // 401 房间密码缺失或错误
  'forbidden',        // 403 身份校验失败（token 无效 / 非房主 / 无权限）
  'not_found',        // 404 房间不存在
  'conflict',         // 409 已被更早的操作消费
  'rate_limited',     // 429 过于频繁
  'internal_error',   // 500 路由抛出未捕获异常（服务端自身故障，具体原因只进服务端日志）
  'server_error',     // 其它 5xx 的兜底码
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

/** 状态码 → 默认失败码：未显式指定 `code` 时按状态码兜底，避免各调用点各写各的。 */
const CODE_BY_STATUS: Record<number, FailureCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

/**
 * 唯一的失败 body 构造器。
 *
 * @param status  HTTP 状态码
 * @param message 可展示文案（客户端优先读它；空串时按状态码生成兜底文案）
 * @param extra   附加业务字段（如 `needPassword`），与 `success/error/message` 平级
 * @param code    失败码；省略时按 status 取默认
 */
export function failBody(
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
  code?: FailureCode
): Record<string, unknown> {
  const fallback = DEFAULT_MESSAGE_BY_STATUS[status] ?? '操作被服务端拒绝';
  return {
    success: false,
    error: code ?? CODE_BY_STATUS[status] ?? (status >= 500 ? 'server_error' : 'bad_request'),
    message: message || fallback,
    ...extra,
  };
}

/** 按状态码生成的兜底文案：调用点漏传 message 时也不会把空串暴露到界面。 */
const DEFAULT_MESSAGE_BY_STATUS: Record<number, string> = {
  400: '请求不被接受',
  401: '身份校验失败',
  403: '你没有权限执行该操作',
  404: '房间已不存在',
  409: '操作已被处理',
  429: '操作过于频繁，请稍后重试',
  500: '服务端故障，请稍后重试',
};

// 对局动作的统一返回结构（供 HTTP 与 WebSocket 两种通道复用同一套核心逻辑）。
// 移动到本模块：动作结果**不再**由 lanGame 定义，跨通道公共层是它的归属地。
export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

/** 动作层拒绝：单一入口，保证所有 `act*` 返回的失败 body 都是 `failBody` 的产物。 */
export function actionFailure(
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
  code?: FailureCode
): ActionResult {
  return { status, body: failBody(status, message, extra, code) };
}

// ============================================================================
// 2. 跨通道的动作结算（改造点：动作执行 → 结果广播 → 4xx 回推）
// ============================================================================

/** 房间广播器：由 battleWs.ts 注入（`registerRoomBroadcaster`），本模块只声明依赖。 */
export type RoomBroadcaster = (room: unknown) => void;

/** 可变注入点：lanGame.ts 在模块加载时把自己的 `rooms` 查找与广播器接到这里。 */
let lookupRoom: (roomId: string) => unknown = () => null;
let broadcaster: RoomBroadcaster = () => {};

/**
 * 由 lanGame.ts 调用一次：把房间查找与广播器接进公共层。
 *
 * 之所以要注入而不是直接 `import { rooms } from './lanGame'`：那会形成
 * lanGame ↔ actionOutcome 的循环依赖（lanGame 要用 failBody，actionOutcome 要用 rooms）。
 * ESM 的循环导入在这两个模块都带顶层副作用（lanGame 有 `setInterval` GC 与 gameTick）时
 * 会在初始化顺序上留下真实的坑，注入是确定性的做法。
 */
export function registerRoomAccess(
  lookup: (roomId: string) => unknown,
  broadcast: RoomBroadcaster
): void {
  lookupRoom = lookup;
  broadcaster = broadcast;
}

/**
 * 被拒动作的权威状态回推限流：按房间计数，窗口 3000ms、上限 8 次。
 *
 * 限流状态挂在 Room 上而不是模块全局：全局计数会被所有房间共用，多房间并发时一个房间的
 * 连续非法请求会把其他房间的配额吃光，于是「别的房间被拒动作不再回推权威状态」——
 * 恰好是这条加固要防的那个故障本身。房间销毁时字段一并消失，无需额外 GC。
 *
 * 只对 4xx 生效——5xx 属于服务端自身异常，不该顺手改写客户端对局画面。
 */
export const REJECTION_SYNC_WINDOW_MS = 3000;
export const REJECTION_SYNC_LIMIT = 8;

/** 房间上承载限流状态的字段（结构化声明，避免公共层依赖 lanGame 的完整 Room 类型）。 */
interface RejectionSyncState {
  lastRejectionSyncAt?: number;
  rejectionSyncCount?: number;
}

/** 判定某次被拒动作是否需要补推权威状态（纯函数式判定，副作用只落在传入的 room 上）。 */
export function shouldSyncRejection(
  roomId: string,
  status: number,
  nowMs: number
): boolean {
  if (status < 400 || status >= 500) return false;
  const room = lookupRoom(roomId) as (RejectionSyncState & { id?: string }) | null | undefined;
  if (!room) return false;
  const lastSyncAt = room.lastRejectionSyncAt || 0;
  if (nowMs - lastSyncAt >= REJECTION_SYNC_WINDOW_MS) {
    // 窗口滑过：配额与锚点一并重置
    room.rejectionSyncCount = 0;
    room.lastRejectionSyncAt = nowMs;
  }
  const count = room.rejectionSyncCount || 0;
  if (count < REJECTION_SYNC_LIMIT) {
    room.rejectionSyncCount = count + 1;
    room.lastRejectionSyncAt = nowMs;
    return true;
  }
  return false;
}

/**
 * 动作执行后的**唯一**结算入口：决定「这次动作要不要广播权威状态」，需要时广播。
 *
 * HTTP 与 WebSocket 两个通道都只调它，两边对「成功广播 / 4xx 限流回推 / 5xx 不推」
 * 的口径从此无法分叉（这正是 §8 表 #1 记的那条不一致）。
 *
 * @returns 是否已广播（调用方可据此省略重复广播；WS 通道不需要，用返回值仅供测试断言）
 */
export function settleActionOutcome(roomId: string, result: ActionResult): boolean {
  const room = lookupRoom(roomId) as (RejectionSyncState & { id?: string }) | null | undefined;
  if (result.status < 400) {
    // 动作成功：本房间的拒绝回推配额立刻恢复
    if (room && room.rejectionSyncCount) room.rejectionSyncCount = 0;
    if (room) broadcaster(room);
    return true;
  }
  if (shouldSyncRejection(roomId, result.status, Date.now())) {
    if (room) broadcaster(room);
    return true;
  }
  return false;
}

/**
 * HTTP 通道的薄封装：结算 + 把 body 原样下发。
 * WS 通道用 `settleActionOutcome` + 自己的 `sendJson(ack)`，因此响应体形状与广播口径同源。
 */
export function respondAction(res: Response, roomId: string, result: ActionResult): void {
  settleActionOutcome(roomId, result);
  res.status(result.status).json(result.body);
}
