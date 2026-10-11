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
  movetimeMs: number;
  /** 从候选里随机挑（削弱手段之一，仅入门档） */
  randomPick: boolean;
}

const TIERS: Record<JieqiTier, JieqiTierConfig> = {
  // 入门：深度低 + 高随机性。随机性是「削弱」的主要手段，
  // 因为引擎只看到公开信息，本就没有「少给信息」这个削弱空间（AI 不看牌）。
  easy: { multiPV: 2, depth: 3, movetimeMs: 3000, randomPick: true },
  medium: { multiPV: 1, depth: 6, movetimeMs: 6000, randomPick: false },
  hard: { multiPV: 1, depth: 10, movetimeMs: 12000, randomPick: false },
  // 提示：必须**确定性**——两次提示同一局面须给同一着法。
  // 揭棋的随机性来自「被吃暗子身份声明」，由调用方用确定性种子保证。
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
