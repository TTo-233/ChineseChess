/**
 * 在线对局（联机）WebSocket 协议类型定义
 *
 * 背景：此前客户端对服务端负载的描述是**分散的手写类型断言**——
 * lanBattle 在 applyServerState 内联一份、spectate 在 applySnapshot 内联另一份，
 * 两份写法已分叉（观战侧缺乐观保护与 returnedToRoom）。而动作发送侧用的是
 * 裸字符串 `send(type: string, payload)`，既无类型约束也无拼写校验，
 * 服务端 `ready`/`side`/`start`/`rematch` 等帧的类型更是只在注释里存在。
 *
 * 本模块把「服务端 → 客户端的负载形状」与「客户端 → 服务端的动作负载形状」
 * 收敛为单一真源，供 battleSocket、useBattleStateSync、lanBattle、spectate 共用。
 *
 * 与服务端源码的对应关系（【I-1】原先这里写的是 `dist/index.js` 的行号并自称
 * "dist 无源码，行号即真源"，但服务端源码早已在 `src/`，且 dist 每次构建内容都会变，
 * 行号既拿不到可编辑的源、也会过期）：
 * - 增量载荷构造：buildGameStatePayload（`chinese-chess-server/src/routes/lanGame.ts:480`）
 * - 全量载荷构造：buildFullGameStatePayload（welcome / HTTP /gameState / 悔棋后补推走这条）
 * - 帧分发：handleMessage（`chinese-chess-server/src/routes/battleWs.ts:211`）
 */

import type { GameState } from '@/utils/chess/GameEngine';
import type { MoveRecord } from '@/utils/chess/types';

/** 对局阶段（服务端 room.phase；'reveal' 为客户端本地展示态） */
export type BattlePhase = 'waiting' | 'reveal' | 'playing' | 'ended';

/**
 * 结算原因（服务端 room.endReason）。
 *
 * 服务端实际只会写入 checkmate / resign / draw / disconnect / leave，
 * 但客户端（lanBattle）的结算 UI 还留有余时判负的 'timeout' 分支，故一并纳入，
 * 使该类型可直接用于页面 state，无需在调用点收窄。
 */
export type BattleEndReason =
  | 'checkmate'
  | 'resign'
  | 'draw'
  | 'disconnect'
  | 'timeout'
  | 'leave';

/** 房间内玩家（服务端下发形状） */
export interface BattlePlayer {
  id: string;
  name: string;
  /** null 表示尚未选边 */
  side: string | null;
  connected: boolean;
}

/** 走法（客户端 → 服务端的新协议动作） */
export interface BattleMove {
  pieceId: number;
  toCol: number;
  toRow: number;
}

/** 悔棋请求（服务端 pendingUndo） */
export interface BattlePendingUndo {
  playerId: string;
  requestTime: number;
  proposedState?: GameState;
}

/** 悔棋处理结果（服务端 undoResult） */
export interface BattleUndoResult {
  playerId: string;
  agreed: boolean;
  reason: string;
}

/** 求和请求（服务端 pendingDraw） */
export interface BattlePendingDraw {
  playerId: string;
  requestTime: number;
}

/** 求和处理结果（服务端 drawResult） */
export interface BattleDrawResult {
  playerId: string;
  agreed: boolean;
  reason: string;
}

/** 表情消息（服务端 emojiMessages） */
export interface BattleEmojiMessage {
  id: string;
  playerId: string;
  emoji: string;
}

/** 房间对战设置（服务端 room.settings 的子集） */
export interface BattleSettings {
  turnTimeLimit?: number;
  baseTimeSeconds?: number;
  incrementSeconds?: number;
  byoyomiSeconds?: number;
  /** 红方让出的棋子 id 列表 */
  handicap?: number[];
}

/** 局时钟面（服务端权威毫秒快照；null 表示本房间未启用局时） */
export interface BattleClocks {
  red: number;
  black: number;
}

/**
 * 服务端对局状态负载（welcome / state / GET /rooms/:id/gameState 共用同一形状）
 *
 * 注意：`GET /rooms/:id/gameState` 直接返回本负载本体，**没有 `{ success }` 包装**；
 * 房间被重置为 waiting 时负载里**没有 gameState**，因此所有与局面无关的阶段判断
 * （结算、重赛跟随、表情、协商、断线）都必须放在 gameState 之外处理。
 */
export interface GameStatePayload {
  // ---- 局面与阶段 ----
  gameState?: GameState | null;
  /**
   * 【P4】服务端已走手数。
   *
   * 增量载荷不再下发完整 `gameState.moveHistory`（30 步局面实测 2381 B，占载荷 31%），
   * 改由本字段 + `lastMove` 承载「走了多少手」与「最新一手」。
   * 任何需要完整棋谱的路径（首次进入 / 重连 / 悔棋后）仍会下发含 moveHistory 的全量载荷，
   * 此时 `gameState.moveHistory` 可用——但**不要依赖它**，统一读本字段。
   */
  moveCount?: number;
  /**
   * 【P4】最新一手着法（增量载荷的唯一着法来源；无着法时为 null）。
   * 走子动画、着子音效、最后一步高亮都只用到这一条记录。
   */
  lastMove?: MoveRecord | null;
  phase?: BattlePhase | string;
  gameStartTime?: number | null;
  /** 对局纪元：重赛后自增，客户端据此拒绝「上一局的旧快照」把本端拉回对局中 */
  matchId?: number;
  /** 选边公示锚点（服务端时钟域） */
  sideReveal?: { time?: number; red?: string; black?: string } | null;
  /** 开局锚点（服务端时钟域），与 gameStartTime 配合用于倒数校正 */
  gameStartAt?: number | null;
  /** 服务端当前时刻，供客户端做时钟偏移校正 */
  serverNow?: number;

  // ---- 结算 ----
  winner?: string | null;
  surrenderBy?: string | null;
  endReason?: BattleEndReason | string | null;

  // ---- 时钟与设置 ----
  settings?: BattleSettings;
  clocks?: BattleClocks | null;
  /** 悔棋/求和协商暂停锚点（服务端时钟域），非 null 时本地插值冻结 */
  clockPausedAt?: number | null;
  lastMoveTime?: number | null;

  // ---- 断线 ----
  disconnectedPlayerId?: string | null;
  disconnectTime?: number | null;

  // ---- 协商 ----
  pendingUndo?: BattlePendingUndo | null;
  undoResult?: BattleUndoResult | null;
  pendingDraw?: BattlePendingDraw | null;
  drawResult?: BattleDrawResult | null;
  /** 各玩家本局悔棋被对方连续拒绝次数（≥2 封禁悔棋入口） */
  undoRefusals?: Record<string, number>;
  /** 各玩家本局求和被对方连续拒绝次数（≥2 封禁求和入口） */
  drawRefusals?: Record<string, number>;

  // ---- 其他 ----
  players?: BattlePlayer[];
  /** 结算后各玩家「已返回房间」记录（playerId → 返回时刻，服务端时钟） */
  returnedToRoom?: Record<string, number>;
  spectatorCount?: number;
  emojiMessages?: BattleEmojiMessage[];
}

/**
 * 客户端 → 服务端的动作类型。
 *
 * 只列出**客户端实际会经 WebSocket 发送**的动作。服务端 WS 分发器还支持
 * `ready` / `side` / `start` / `rematch`（`chinese-chess-server/src/routes/battleWs.ts:239-262`），
 * 但客户端这些流程一律走 HTTP 接口，故不在此收口。
 */
export type BattleActionType =
  | 'move'
  | 'surrender'
  | 'undo'
  | 'undoResponse'
  | 'draw'
  | 'drawResponse'
  | 'emoji';

/**
 * 动作类型 → 负载形状映射（判别联合的数据来源）。
 *
 * `move` 走新协议（仅发着法，服务端权威裁决）；`undo` 需携带目标局面
 * （见 lanBattle 的 handleUndo：回退对方一步 + 我方一步）；其余动作为空负载或简单参数。
 */
export interface BattleActionPayloads {
  move: { move: BattleMove };
  surrender: Record<string, never>;
  undo: { proposedState: GameState };
  undoResponse: { agreed: boolean };
  draw: Record<string, never>;
  drawResponse: { agreed: boolean };
  emoji: { emoji: string; id: string };
}

/**
 * 动作判别联合：`emitBattleAction` 与页面侧 dispatch 的入参类型。
 *
 * A 取 `BattleActionType & keyof BattleActionPayloads`，使调用方既能获得
 * 字面量收窄（`'move'` → `{ move: BattleMove }`），又不会漏掉映射表中的键。
 */
export type BattleAction = {
  [K in keyof BattleActionPayloads]: { type: K; payload: BattleActionPayloads[K] };
}[keyof BattleActionPayloads];

/**
 * 动作回执帧（服务端 `{ type: 'ack', reqId, status, body }`）。
 *
 * 服务端在 `status < 400` 时广播 state；4xx 被拒动作**也会**补推一次权威状态，
 * 但受按房间计数的限流约束（同一房间 3 秒内最多 8 次，由
 * `chinese-chess-server/src/routes/actionOutcome.ts` 的 `shouldSyncRejection` /
 * `settleActionOutcome` 统一裁决，HTTP 与 WS 两个通道共用同一份实现），
 * 超限的拒绝不再推送。
 * 因此**本回执仍是唯一的可靠失败信号**，不能只依赖 state 推送：不消费它，界面就会
 * 静默卡住（例：悔棋被 400 拒绝后按钮仍停在「等待对方同意」）。
 */
export interface BattleAckFrame {
  reqId?: string;
  status: number;
  body: Record<string, unknown>;
}

/**
 * 从回执 body 中提取可展示给用户的失败原因。
 *
 * 失败 body 现在全端只一种形状（第 3 批统一，服务端由 `failBody` 单点构造）：
 * `{ success: false, error: <机器码>, message: <中文文案> }`。
 * 其中 `error` 是给程序分支用的机器码（`'bad_request'`、`'forbidden'`、`'not_found'`…），
 * **不是**给人看的文案，展示一律读 `message`。
 * 回退到按状态码生成的通用文案，是为了兜住 message 缺失/空串的异常情况，
 * 避免把空字符串或机器码直接暴露到界面。
 */
export function battleAckMessage(status: number, body: Record<string, unknown>): string {
  const raw = body.message;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (status === 404) return '房间已不存在';
  if (status === 403) return '你没有权限执行该操作';
  if (status === 429) return '操作过于频繁，请稍后重试';
  return '操作被服务端拒绝';
}
