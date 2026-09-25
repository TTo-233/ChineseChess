/**
 * 在线 AI（服务端皮卡鱼 Pikafish）调用客户端。
 *
 * 服务端接口：
 *   文件：server/src/routes/ai.ts
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
 * 请求服务端皮卡鱼计算一步棋。
 * 使用 Promise.race 实现超时控制（兼容 RN / Web 的 fetch，避免 AbortController 差异）。
 *
 * difficulty 取值：
 * - 'easy' | 'medium' | 'hard'：AI 对弈难度；
 * - 'hint'：交互式「提示」专用——服务端深度 8、MultiPV 1、纯最佳确定性搜索，
 *   同一局面永远返回同一着法（服务端搜索前清置换表，杜绝随机/漂移）。
 *
 * history 可选：提供完整对局历史时，引擎能识别真实重复局面并规避长将/长捉违规。
 */
export async function fetchOnlineMove(
  fen: string,
  difficulty: AIDifficulty | 'hint',
  timeoutMs: number,
  priority?: number,
  clientId?: string,
  history?: EngineHistory
): Promise<OnlineMove> {
  const request = (async (): Promise<OnlineMove> => {
    /**
     * 服务端文件：server/src/routes/ai.ts
     * 接口：POST /api/v1/ai/move
     * Body 参数：fen: string, difficulty: 'easy'|'medium'|'hard'|'hint', priority?: number,
     *           clientId?: string, startFen?: string, moves?: string[]
     * 服务器地址取大厅"服务器设置"中的自定义地址（未设置时用默认地址），与在线对局保持一致。
     */
    const base = await getOnlineServerUrl();
    const response = await fetch(`${base}/api/v1/ai/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      throw new Error((data && data.message) || '在线 AI 返回异常');
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
  })();

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error('ONLINE_AI_TIMEOUT')), timeoutMs);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    // 无论成功/失败/超时都清理定时器，避免残留计时器持有事件循环
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}
