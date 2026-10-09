/**
 * 旧 TS AI 的 OfflineEngine 包装（**兜底实现**）
 *
 * 迁移期保留两个理由，缺一不可：
 *   1. 本地皮卡鱼需要加载 6MB 引擎 + 实例化 WASM（首次冷启动有明显耗时），
 *      引擎未就绪时 AI 仍要能出棋，否则开局就走不动；
 *   2. 资产缺失 / 引擎崩溃 / 平台不支持承载时，必须有退路，
 *      否则对局会永久卡在「AI 回合」——玩家点不动棋子，也没有下一步。
 *
 * 它同时是**同档次位**的第二实现：难度语义由 AIEngine 既有配置给出，
 * 与皮卡鱼档位各自独立（见 pikafishDifficulty.ts 的说明）。
 */

import {
  getBestMoveAsync,
  getHintMoveAsync,
  type AIMoveResult,
} from '../AIEngine';
import {
  OfflineEngineUnavailableError,
  type EngineCapabilities,
  type OfflineEngine,
  type OfflineSearchRequest,
  type OfflineSearchResult,
} from '../offlineEngine';

export class LegacyTsEngine implements OfflineEngine {
  readonly driver: EngineCapabilities['driver'] = 'legacy';

  async init(): Promise<EngineCapabilities> {
    return {
      banner: 'legacy-ts-alpha-beta',
      options: [],
      driver: 'legacy',
    };
  }

  async search(request: OfflineSearchRequest): Promise<OfflineSearchResult> {
    if (request.signal?.aborted) throw abortError();

    // ⚠️ 必须用**真实 GameState**（request.state），不能用 FEN 重建：
    //    getBestMoveAsync 会读 moveHistory 做反循环判断、读 ruleState 判断禁着，
    //    传入残缺对象会静默走偏（这是本包装存在的意义：兜底也要给出正确着法）。
    const state = request.state;
    if (!state) {
      throw new OfflineEngineUnavailableError('兜底 AI 需要真实 GameState');
    }

    /**
     * 用途 → TS 搜索入口的映射。
     *
     * ⚠️ ponder 必须走 getHintMoveAsync（2026-10 审计 P1-9）：
     * getBestMoveAsync 带 `pureBest=false`，会启用**根节点多样化随机与反循环惩罚**。
     * 那对"AI 走子"是对的（要能赢玩家），但对预计算提示是错的——提示必须确定，
     * 否则会出现"后台算出一个着法、点提示又给出另一个"的观感问题，
     * 而且 TS AI 的 getHintMoveAsync 会复用正在跑的 ponder 条目。
     */
    const isHintLike = request.purpose === 'hint' || request.purpose === 'ponder';

    const result: AIMoveResult | null = isHintLike
      ? await getHintMoveAsync(state)
      : await getBestMoveAsync(state, request.tier === 'hint' ? 'hard' : request.tier);

    if (request.signal?.aborted) throw abortError();
    if (!result) {
      throw new OfflineEngineUnavailableError('兜底 AI 未能给出着法');
    }
    return {
      // ⚠️ uci 留空是**已知的信息缺口**（2026-10 审计 P1-10）：兜底 TS 搜索
      //    不产出 UCI，用内部坐标直接返回。若上层要显示"引擎给出的着法"，
      //    应在适配层用 internalToUci 补齐，而不是在这里编一个。
      uci: '',
      depth: 0,
      timeMs: 0,
      fromCol: result.fromCol,
      fromRow: result.fromRow,
      toCol: result.toCol,
      toRow: result.toRow,
    };
  }

  stop(): void {
    // TS AI 的取消由 AIEngine.abortSearch 处理（其搜索会话会自行退出），
    // 这里不重复实现。
  }

  newGame(): void {
    /* 兜底实现无跨局状态 */
  }

  dispose(): void {
    /* 无需释放 */
  }
}

/**
 * 兜底实现需要真实 GameState 的原因见上（search 内注释）。
 * state 由编排器从调用链透传，引擎实现不得修改它。
 */

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
