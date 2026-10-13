/**
 * 揭棋难度档位 —— 客户端唯一来源
 *
 * ============================================================================
 * 【与象棋档位的关系】
 *
 * 象棋档位见 `pikafishTier.ts`（easy d4/5s、medium d8/8s、hard d12/15s）。
 * 揭棋**单列一份**，原因有二：
 *   1. 揭棋搜索树更大（每层含暗子身份维度），同等深度更慢，需要整体下调；
 *   2. 档位一改 UI 文案就会撒谎（见 pikafishDifficulty.ts 的说明），
 *      故两者必须各自独立、互不影响。
 *
 * ============================================================================
 * 【数值来源】
 *
 * 起始值按「同等墙钟下深度下调」给出，**必须**由自对弈实测回调
 * （方案 §8.3）。实测数据见 engine-source/jieqi/README.md：
 * classical 评估在 Node 下约 1.7M nps，depth 6 / 3000ms 可稳定达成。
 */

export type JieqiTier = 'easy' | 'medium' | 'hard' | 'hint';

export interface JieqiTierConfig {
  multiPV: number;
  depth: number;
  /**
   * **宿主侧墙钟上限**（毫秒），用于给 `runJieqiSession` 的超时请预算。
   *
   * 【2026-10 审计 D3】这个值**不再发给引擎**。
   * 此前 aiDispatcher 发的是 `go depth N movetime M`，但实测 `go depth 4 movetime 3000`
   * 在 ~90ms 就跑完（depth 先耗尽），`movetime` 从不生效 ⇒ 三个档位的
   * `movetimeMs` 全是死参数，「大师档思考更久」并未发生，档位文案对用户失真。
   *
   * 改为「只发 `go depth N`」后：
   *   · 棋力上限由 depth 唯一决定 ⇒ 档位语义与实际行为一致；
   *   · 墙钟由 depth 自然决定（实测各档 0.1–2s 量级，手机可接受）；
   *   · **提示档的确定性有了机制保障**（审计 D7）：若把 movetime 发下去，
   *     墙钟随机器负载浮动 → 深度浮动 → 同一局面两次提示可能给出不同着法，
   *     直接违反「提示须确定性」的契约。只发 depth 则结果确定。
   *
   * 保留该字段仅用于超时预算（它必须 ≥ 该档实际耗时，否则会被宿主先砍掉）。
   */
  movetimeMs: number;
  /** 从候选里随机挑（削弱手段之一，仅入门档） */
  randomPick: boolean;
}

const TIERS: Record<JieqiTier, JieqiTierConfig> = {
  // 入门：深度低 + 高随机性。随机性是「削弱」的主要手段，
  // 因为引擎只看到公开信息，本就没有「少给信息」这个削弱空间（AI 不看牌）。
  // ⚠️ randomPick 曾是**死配置**（审计 D5）：aiDispatcher 只 parseBestmove 恒取 PV1，
  //    multiPV 2 收集的候选被丢弃。现已改为真正走 chooseUci(info, true)。
  easy: { multiPV: 2, depth: 3, movetimeMs: 3000, randomPick: true },
  medium: { multiPV: 1, depth: 6, movetimeMs: 6000, randomPick: false },
  hard: { multiPV: 1, depth: 10, movetimeMs: 12000, randomPick: false },
  // 提示：必须**确定性**——两次提示同一局面须给同一着法。
  // 揭棋的随机性来自「被吃暗子身份声明」，由调用方用确定性种子保证；
  // 引擎侧则靠「只发 depth、不发 movetime」保证（见 JieqiTierConfig.movetimeMs 注释）。
  hint: { multiPV: 1, depth: 8, movetimeMs: 8000, randomPick: false },
};

export function getJieqiTier(tier: JieqiTier): JieqiTierConfig {
  const c = TIERS[tier];
  return c ? { ...c } : { ...TIERS.medium };
}

/** UI 文案（与象棋档位文案一致，便于用户理解） */
const TIER_COPY: Record<JieqiTier, { label: string; desc: string }> = {
  easy: { label: '入门', desc: '小试牛刀' },
  medium: { label: '进阶', desc: '炉火纯青' },
  hard: { label: '大师', desc: '登堂入室' },
  hint: { label: '提示', desc: '最优解' },
};

export function getJieqiTierCopy(
  tier: JieqiTier
): JieqiTierConfig & { label: string; desc: string } {
  return { ...getJieqiTier(tier), ...TIER_COPY[tier] };
}
