/**
 * 在线 AI（服务端皮卡鱼 Pikafish）调用客户端。
 *
 * 服务端接口：
 *   文件：chinese-chess-server/src/routes/ai.ts
 *   接口：POST /api/v1/ai/move
 *   Body：{ fen: string, difficulty: 'easy' | 'medium' | 'hard' | 'hint', priority?: number,
 *           clientId?: string, startFen?: string, moves?: string[] }
 *     - priority 可选，服务端调度优先级（越大越先执行）；交互式"提示"传 1，普通走子默认 0。
 *     - difficulty='hint' 为交互式"提示"专用：深度 8 纯最佳确定性搜索，同一局面结果恒定。
 *     - startFen + moves 可选：对局起始局面 + 完整 UCI 着法历史，引擎据此感知重复局面规则。
 *   返回：{ success, engine, uci, move: {fromCol,fromRow,toCol,toRow}, depth, timeMs }
 *
 * 说明：服务端已将皮卡鱼 UCI 走法换算为应用内部坐标（col=文件序号，row=9-行号），
 * 客户端拿到 move 后可直接按 (fromCol, fromRow) 定位棋子。
 *
 * clientId 约定（重要）：服务端用它做进程内去重（同一 clientId 同时只允许一个在飞，
 * 重复则返回 429 busy），且要等引擎算完才释放。因此调用方必须为**每个请求**传入唯一值，
 * 绝不能复用玩家 ID——否则一次超时未完成的请求会挡住后续所有重试，形成无法自愈的活锁。
 */

import { getOnlineServerUrl } from '@/utils/serverConfig';
import type { AIDifficulty } from './types';

export interface OnlineMove {
  uci: string;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  depth: number;
  timeMs: number;
  /** 走法来源引擎：'book'=开局库（depth 恒为 0）；'pikafish'=皮卡鱼搜索 */
  engine?: string;
}

/**
 * 对局历史（可选上报）：起始局面 + 起始之后的完整 UCI 着法序列。
 * 服务端转交皮卡鱼引擎，使其感知本局真实重复局面（长将/长捉/不变循环），
 * 搜索中主动规避违规循环。缺省时引擎仅按当前 FEN 搜索。
 */
export interface EngineHistory {
  startFen: string;
  moves: string[];
}

/**
 * 在线 AI 失败原因分类（供调度器区别对待，决定是否熔断、是否重试）。
 *
 * 关键：服务端「忙」（429 busy）与「网络故障」必须分开。
 * 忙说明服务是活的、只是排队中，对它熔断等于把唯一能出棋的路径也掐掉。
 */
export class OnlineAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnlineAiError';
  }
}

/** 服务端返回 429：同一 clientId 已有请求在计算中（服务健康，仅繁忙） */
export class OnlineAiBusyError extends OnlineAiError {
  constructor(message: string) {
    super(message);
    this.name = 'OnlineAiBusyError';
  }
}

/** 本地超时（已 abort 请求） */
export class OnlineAiTimeoutError extends OnlineAiError {
  constructor(message: string) {
    super(message);
    this.name = 'OnlineAiTimeoutError';
  }
}

/**
 * 外部主动取消（调用方自己 abort，与"服务端慢"无关）。
 *
 * 必须与 OnlineAiTimeoutError 分开：取消是客户端的自主决策（换页、悔棋、局面已变），
 * 服务端可能完全健康。若按超时处理就会计入熔断计数，把一次正常的取消
 * 误判成"服务变慢"，进而在网络本来健康时白白熔断 30s、一直走本地 AI。
 */
export class OnlineAiCancelledError extends OnlineAiError {
  constructor(message: string) {
    super(message);
    this.name = 'OnlineAiCancelledError';
  }
}

/** 网络层失败：DNS/断网/TLS/连接重置（fetch 自身抛出） */
export class OnlineAiNetworkError extends OnlineAiError {
  constructor(message: string) {
    super(message);
    this.name = 'OnlineAiNetworkError';
  }
}

/** abort 归因用的标记：传给 controller.abort() 便于排查是谁触发的中止。 */
const ABORT_REASON_TIMEOUT = Symbol('online-ai-timeout');
const ABORT_REASON_CANCELLED = Symbol('online-ai-cancelled');

/**
 * 请求服务端皮卡鱼计算一步棋。
 *
 * 超时控制使用 AbortController（而非 Promise.race）：超时后真正 abort 掉底层 fetch，
 * 及时断开与服务的连接，不再让"已放弃的请求"继续占用网络与服务端队列。
 *
 * 重要（客户端侧无法单方面解决、必须配合服务端）：
 * 服务端用 clientId 做进程内去重，且在引擎算完后（await 之后）才释放。
 * 客户端 abort 只会断开 HTTP 连接，服务端的去重槽位仍会一直持有到本次计算结束，
 * 因此"超时即重试"若沿用同一个 clientId 会被自己的上一次请求挡住（429 busy）。
 * 本模块的约定：调用方必须为每个请求传入唯一的 clientId（见 aiDispatcher 的 makeRequestId）。
 *
 * difficulty 取值：
 * - 'easy' | 'medium' | 'hard'：AI 对弈难度；
 * - 'hint'：交互式「提示」专用——服务端深度 8、MultiPV 1、纯最佳确定性搜索，
 *   同一局面永远返回同一着法（服务端搜索前清置换表，杜绝随机/漂移）。
 *
 * history 可选：提供完整对局历史时，引擎能识别真实重复局面并规避长将/长捉违规。
 *
 * externalSignal 可选：调用方自己的取消信号（如换页、悔棋、局面已变）。
 * 传入后本函数会同时监听它并主动 abort 底层 fetch；由此产生的中止归为
 * OnlineAiCancelledError，**不计入熔断**；只有本函数自己的计时器触发才算超时。
 */
export async function fetchOnlineMove(
  fen: string,
  difficulty: AIDifficulty | 'hint',
  timeoutMs: number,
  priority?: number,
  clientId?: string,
  history?: EngineHistory,
  externalSignal?: AbortSignal
): Promise<OnlineMove> {
  // 定时器在函数入口即启动：地址解析（读 AsyncStorage）也算进总预算，
  // 否则地址读取卡住时本次调用会永远悬挂。
  const controller = new AbortController();
  let cancelledExternally = false;
  const timer = setTimeout(() => {
    controller.abort(ABORT_REASON_TIMEOUT);
  }, timeoutMs);
  // 外部取消：先于计时器发生时归因 cancelled（不计入超时/熔断）
  const onExternalAbort = () => {
    cancelledExternally = true;
    controller.abort(ABORT_REASON_CANCELLED);
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      throw new OnlineAiCancelledError('在线 AI 请求已取消');
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const base = await getOnlineServerUrl();
    const response = await fetch(`${base}/api/v1/ai/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        fen,
        difficulty,
        ...(priority ? { priority } : {}),
        ...(clientId ? { clientId } : {}),
        ...(history ? { startFen: history.startFen, moves: history.moves } : {}),
      }),
    });
    const data = await response.json();
    if (!data || data.success !== true || !data.move) {
      // 429 busy = 服务端"该 clientId 已有请求在算"，属服务健康但繁忙，与网络故障区别对待
      if (response.status === 429) {
        throw new OnlineAiBusyError((data && data.message) || '在线 AI 忙');
      }
      throw new OnlineAiError((data && data.message) || '在线 AI 返回异常');
    }
    return {
      uci: data.uci,
      fromCol: data.move.fromCol,
      fromRow: data.move.fromRow,
      toCol: data.move.toCol,
      toRow: data.move.toRow,
      depth: data.depth,
      timeMs: data.timeMs,
      engine: data.engine,
    };
  } catch (err) {
    // AbortError 本身不携带"是谁取消的"，用 abortCause 归因：
    // 外部取消 → 不熔断（服务端可能完全健康）；计时器超时 → 计入熔断。
    if (err instanceof Error && err.name === 'AbortError') {
      if (cancelledExternally) {
        throw new OnlineAiCancelledError('在线 AI 请求已取消');
      }
      throw new OnlineAiTimeoutError(`在线 AI 超时（${timeoutMs}ms）`);
    }
    if (err instanceof OnlineAiError) {
      throw err;
    }
    // fetch 自身失败（DNS/断网/TLS/连接被重置）→ 网络故障
    throw new OnlineAiNetworkError(err instanceof Error ? err.message : String(err));
  } finally {
    // 无论成功/失败/超时都清理定时器与监听，避免残留计时器持有事件循环
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}
