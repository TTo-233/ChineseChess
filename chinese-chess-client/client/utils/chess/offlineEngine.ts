/**
 * 离线引擎抽象层（OfflineEngine）
 *
 * ============================================================================
 * 【这一层存在的理由】
 *
 * 皮卡鱼在客户端要跑在**三种完全不同的承载**上：
 *   · Web          → Dedicated Worker + WASM
 *   · Android/iOS  → WebView（本期实现）或将来的原生 Expo Module
 * 三者的消息传递、生命周期、取消语义都不同。若让 `aiDispatcher` 直接面对它们，
 * 调度逻辑会被平台细节淹没，且三端行为容易漂移。
 *
 * 所以这里定一个**协议无关**的接口：上层只说"给我这一步棋"，具体怎么算由实现决定。
 * 旧 TS AI 也实现同一接口（legacyTsEngine.ts），因此它天然就是兜底实现 ——
 * 引擎起不来时切换实现即可，不需要改动任何调用点。
 *
 * ============================================================================
 * 【为什么把合法性校验留给上层，而不是在引擎内做完】
 *
 * 皮卡鱼的合法着法生成本就不含"吃将"，而项目规则引擎另有长将长捉禁着等口径。
 * 二者不是包含关系。引擎只负责"给一个它认为最好的着法"，
 * 是否可用由 aiDispatcher 用项目既有守卫（isMoveKingSafe 等）统一裁决。
 */

import type { GameState } from './GameEngine';
import type { AIMoveResult } from './AIEngine';
import { TransportStartError } from './pikafish/engineTransport';

/**
 * 转交引擎的对局历史：让搜索感知本局真实重复局面（长将/长捉/不变循环），
 * 主动规避违规循环。缺省时引擎仅按当前局面搜索。
 *
 * ⚠️ 2026-10：原先这个类型定义在 `onlineAI.ts`（为服务端在线皮卡鱼准备），
 * 但本地引擎的请求体同样用它。服务端去 AI 化删除该文件后，类型迁到这里
 * —— 它现在描述的是**本地**引擎的输入，不是"在线"专用。
 */
export interface EngineHistory {
  startFen: string;
  moves: string[];
}

/** 一次搜索的用途：影响优先级与是否可被抢占 */
export type SearchPurpose =
  /** 轮到 AI 落子：最高优先级，可抢占一切 */
  | 'move'
  /** 用户主动点「提示」：高优先级，但不能打断正在进行的 move */
  | 'hint'
  /** 玩家思考期间的后台预计算：最低优先级，随时可被抢占 */
  | 'ponder';

/** 优先级数值：越大越先调度（与 aiDispatcher 现有的 priority 语义一致） */
export const PURPOSE_PRIORITY: Record<SearchPurpose, number> = {
  move: 10,
  hint: 5,
  ponder: 0,
};

/** 引擎实例能力（由 init 实测得出，不可假定） */
export interface EngineCapabilities {
  /** 引擎横幅，如 `Pikafish dev-20240226-98b20a33 ...` */
  banner: string;
  /** 引擎自报的 UCI 选项名集合（决定能否设置 MultiPV / Skill Level 等） */
  options: string[];
  /** 承载层标识，用于 UI 展示与排障 */
  driver: 'web-worker' | 'webview' | 'legacy';
}

/** 搜索入参 */
export interface OfflineSearchRequest {
  /** 本次请求唯一 id：用于丢弃迟到的结果 */
  requestId: string;
  /** 用途，决定优先级 */
  purpose: SearchPurpose;
  /**
   * 当前局面（权威副本）。
   *
   * 两个实现都要用：
   *   · 本地皮卡鱼：据此生成 FEN / 历史 / 合法根着法白名单
   *   · 兜底 TS AI ：getBestMoveAsync 需要真实 GameState（要读 moveHistory 做反循环、
   *     读 ruleState 判断禁着），只给 FEN 会让它静默走偏
   * 引擎实现**不得修改**它。
   */
  state: GameState;
  /** 当前局面 FEN（棋盘段 + 走棋方） */
  fen: string;
  /**
   * 对局历史：起始局面 + 完整着法。
   *
   * 给了它引擎才能感知真实重复局面（长将/长捉/不变循环）并在搜索中主动规避。
   * 缺省时引擎只按 fen 搜索，重复感知能力会丢失。
   */
  history?: EngineHistory | null;
  /** 难度档位（'hint' 表示交互式提示，纯最佳确定性） */
  tier: 'easy' | 'medium' | 'hard' | 'hint';
  /**
   * 根节点允许着法（UCI）。来自项目规则引擎的合法着法表。
   *
   * 传入后引擎只在这些分支里搜索，从源头减少"给出本地会拒绝的着法"。
   */
  searchmoves?: string[];
  /**
   * 本次搜索的墙钟上限（毫秒），不超过档位本身的 movetimeMs。
   *
   * 用途：后台预计算（ponder）。引擎**同步**且全局只有一个实例——
   * hint 档 8s 的预算会占住引擎，玩家随后走子时正式搜索只能排队并被拒为
   * busy（本步退到兜底 AI），实测表现为"AI 半天不回"。
   * 把 ponder 压到 ~2.5s：既保住"点提示多半秒出"，也把最坏占用压到可接受。
   */
  movetimeCapMs?: number;
  /** 取消信号：触发后应尽快停止搜索并让出引擎 */
  signal?: AbortSignal;
}

/** 搜索结果（已换算为内部坐标，但**未**做合法性校验） */
export interface OfflineSearchResult {
  /** UCI 着法，如 b2e2（供排障与日志） */
  uci: string;
  /** 实际完成深度 */
  depth: number;
  /** 引擎侧耗时（毫秒） */
  timeMs: number;
  /** 内部坐标（uciToInternal 的结果） */
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  /**
   * 这个结果实际由哪个实现算出（由编排器盖章，引擎自己填不了）。
   *
   * 为什么必须有（2026-10 实测）：编排器内部会降级——主引擎不可用时
   * 这一步实际是**兜底 TS AI** 算的，若上层仍按"皮卡鱼"展示，就是虚报棋力来源；
   * ponder 缓存这种结果还会把"TS 算的着法"一路带进"提示命中"路径。
   * undefined 按 'pikafish' 处理（兼容直接调用引擎、不经编排器的测试桩）。
   */
  servedBy?: 'pikafish' | 'legacy';
}

/** 引擎不可用（未初始化、崩溃、资产缺失等） */
export class OfflineEngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineEngineUnavailableError';
  }
}

/** 引擎给出了不可用的着法（无法解析、bestmove (none)、CRITICAL ERROR 等） */
export class OfflineEngineBadMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineEngineBadMoveError';
  }
}

/**
 * 本次搜索失败是否意味着「引擎本身不可用」。
 *
 * ============================================================================
 * 【为什么需要这个判据 · 2026-10 审计 P0-2】
 *
 * 编排器原先把**任何**非取消错误都当作"引擎不可用"并永久降级。但
 * OfflineEngineBadMoveError 往往是**位置相关**的一次性事件：
 *   · bestmove (none)         —— 搜索范围内无合法着法（如残局将死/困毙边缘）
 *   · 畸形局面导致 CRITICAL   —— 引擎拒绝该 FEN 并要求重建
 *   · 历史含送将着法被拒重放  —— 引擎停在送将前的局面
 * 这些都**不代表引擎坏了**，下一局面换个 FEN 可能完全正常。
 *
 * 若因此永久降级，一次偶发局面就会让**整局会话**退回弱 AI 且不可恢复
 * （这正是审计探针 [A] 复现的行为）。
 *
 * 现在只有"承载/初始化层面的失败"才降级；着法层面的失败只影响本次。
 */
export function isEngineUnavailableError(e: unknown): boolean {
  if (e instanceof OfflineEngineUnavailableError) return true;
  // 平台不支持承载 / Worker 构造失败
  if (e instanceof TransportStartError) return true;
  return false;
}

/**
 * 是否是"平台/资源根本不支持"这类**不会自愈**的失败。
 *
 * 与 isEngineUnavailableError 的区别（2026-10 实测教训）：
 *   · TransportStartError        → 无 Worker、WebView 组件缺失：重试也没用
 *   · OfflineEngineUnavailableError（超时/承载异常退出）→ 往往只是"慢"，
 *     冷却后重试可能就好了（例如 WebView 被系统回收后重新挂载）
 * 编排器据此决定"永久放弃"还是"退避重试"。
 */
export function isTransportStartError(e: unknown): boolean {
  return e instanceof TransportStartError;
}

export interface OfflineEngine {
  /** 能力标识，供编排与 UI 展示 */
  readonly driver: EngineCapabilities['driver'];

  /**
   * 初始化引擎（幂等：重复调用共享同一个 Promise）。
   *
   * 实现必须在**不阻塞 UI** 的前提下完成，并对引擎崩溃/资产损坏给出明确失败，
   * 以便上层切换到兜底引擎。
   */
  init(): Promise<EngineCapabilities>;

  /**
   * 计算一步棋。
   *
   * 约定：
   *   · 必须在结果返回前确认自己仍是"最新请求"，迟到的结果自行丢弃并抛 AbortError；
   *   · 被 signal 中止时抛 AbortError（不是返回 null）——上层要区分"取消了"和"没棋可走"；
   *   · 返回的着法**只是建议**，是否合法由上层裁决。
   */
  search(request: OfflineSearchRequest): Promise<OfflineSearchResult>;

  /** 放弃当前搜索（等价于 signal.abort 的主动版本） */
  stop(): void;

  /** 换局：清空置换表与历史启发 */
  newGame(): void;

  /**
   * 引擎是否已就绪（init 成功且实例仍可用）。
   *
   * 编排器用它来同步自己的状态缓存：引擎在**运行期**重建了实例
   * （搜索超时、fatal 错误）时 caps 会被清空，若编排器仍以为自己拿到过
   * 能力，就会跳过重新 init，导致后续每次都失败。
   * 未实现时视为"按 init 结果判断"（兼容旧实现）。
   */
  isReady?(): boolean;

  /** 释放资源（页面卸载、引擎重建时调用） */
  dispose(): void;
}

/** 把搜索结果 + 起点棋子组装成页面消费的结构 */
export function toAIMoveResult(
  state: GameState,
  result: OfflineSearchResult
): AIMoveResult | null {
  const source = state.qiPan[result.fromCol]?.[result.fromRow] ?? -1;
  if (source < 0) return null;
  return {
    pieceId: source,
    fromCol: result.fromCol,
    fromRow: result.fromRow,
    toCol: result.toCol,
    toRow: result.toRow,
    score: 0,
  };
}
