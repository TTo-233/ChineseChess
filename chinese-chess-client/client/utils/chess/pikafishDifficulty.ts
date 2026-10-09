/**
 * 皮卡鱼难度档位（客户端本地引擎）
 *
 * ============================================================================
 * 【唯一来源就在客户端自己】
 *
 * 引擎参数（multiPV / depth / movetimeMs / randomPick）定义在 pikafishTier.ts。
 *
 * 变迁（2026-10 服务端去 AI 化）：此前服务端也有在线皮卡鱼，档位必须两端一致，
 * 所以把定义塞进 ruleEngine.bundle.ts（两端同源包）并由专门的校验脚本比对。
 * 服务端不再承载 AI 后，在线/离线两套引擎的差异问题**本身已不存在** ——
 * 现在只有客户端这一份引擎，档位也就回归客户端自持，不再需要跨端同步与校验。
 *
 * ============================================================================
 * 【各字段含义（对应 UCI 协议）】
 *
 * - multiPV：同时输出多少条候选。easy 档取 2 并在候选中随机挑，
 *   这是"让玩家能赢"的关键；medium/hard/hint 固定 1，走纯最佳。
 * - depth：迭代加深目标层数。写 depth 而非仅 movetime，让同一难度在任何设备上
 *   都是同一个搜索强度（不受设备快慢影响棋力）。
 * - movetimeMs：**墙钟兜底上限**。仅在极慢设备上截断，正常由 depth 收敛；
 *   它保证"再慢也不卡住 UI"，与旧 TS AI 的硬性时间中断职责相同。
 * - randomPick：是否从候选中随机挑（仅 easy）。
 *
 * ⚠️ easy 档的 movetimeMs 必须显著大于 depth 4 的实际耗时，否则慢设备上会被
 *    截断到 depth 2~3，棋力掉到"比原来还弱"，入门档反而变成送分。
 */

import type { AIDifficulty } from './types';
import { getPikaTier, type PikaTier as PikafishTier, type PikaTierConfig } from './pikafishTier';

export type { PikafishTier, PikaTierConfig };

/** 档位配置 + UI 文案 */
export type PikafishTierWithCopy = PikaTierConfig & { label: string; desc: string };

/** UI 文案（只在客户端渲染，不参与两端一致性校验） */
const TIER_COPY: Record<PikafishTier, { label: string; desc: string }> = {
  easy: { label: '入门', desc: '小试牛刀' },
  medium: { label: '进阶', desc: '炉火纯青' },
  hard: { label: '大师', desc: '登堂入室' },
  hint: { label: '提示', desc: '最优解' },
};

/** 兜底档位：任何非法输入都落到 medium，绝不因参数问题让 AI 无法出棋 */
export const PIKAFISH_FALLBACK_TIER: PikafishTier = 'medium';

/**
 * 残局闯关使用的 AI 档位。
 *
 * 单独导出为常量，让两处**共用同一来源**，避免改一处后不一致：
 *   · game 屏：真正传给本地皮卡鱼引擎的档位（决定棋力）
 *   · home 屏：入口卡片上的「XX难度」文案
 * 历史上这两处各写各的（game 里 `isEndgame ? 'hard'`、home 里硬编码"大师难度"），
 * 档位一改文案就会撒谎。
 *
 * 类型用 AIDifficulty（不含 'hint'）：'hint' 是交互式提示专用档，
 * 不是可选的对手强度。
 */
export const ENDGAME_AI_TIER: AIDifficulty = 'medium';

/** 取档位配置（含 UI 文案）；未知档位回落到 medium */
export function getPikafishTier(tier: PikafishTier): PikafishTierWithCopy {
  const copy = TIER_COPY[tier] ?? TIER_COPY.medium;
  return { ...getPikaTier(tier), ...copy };
}

/** 取档位配置（按产品难度；用于 AI 走子，不含 hint） */
export function getPikafishTierForDifficulty(difficulty: AIDifficulty): PikafishTierWithCopy {
  return getPikafishTier(difficulty);
}

/**
 * 是否属于「纯最佳确定性」档（hint）。
 *
 * 确定性不只是 randomPick=false：还要求每次搜索前 `ucinewgame`（清置换表），
 * 否则上一局面残留的置换表/历史启发会改变走法排序与剪枝路径，
 * 出现"同一局面两次提示给出不同着法"。
 * （ucinewgame 由 pikafishLocalEngine 在每次搜索命令序列里固定带上。）
 */
export function isDeterministicTier(tier: PikafishTier): boolean {
  const cfg = getPikaTier(tier);
  return cfg.multiPV === 1 && !cfg.randomPick;
}
