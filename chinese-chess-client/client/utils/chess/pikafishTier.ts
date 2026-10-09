/**
 * 皮卡鱼难度档位 —— **客户端唯一来源**。
 *
 * 历史沿革（2026-10 服务端去 AI 化）：本文件曾是「两端同源」体系的一部分 ——
 * 档位经 ruleEngine.bundle.ts 打包进 ruleEngine.cjs，供服务端 services/pikafish.ts
 * 读取，并由 verify-pikafish-difficulty-parity.mjs 逐字段校验两端一致。
 * 服务端不再承载 AI 后，那些消费者与校验脚本都已删除；「两端档位会不会漂移」
 * 这个问题随之消失。现在档位只在客户端使用：
 *
 *   · utils/chess/pikafishDifficulty.ts —— 转出 + UI 文案
 *   · utils/chess/pikafish/*           —— 翻译成实际下发给引擎的 UCI 参数
 *
 * 因此**改档位只需改本文件**，不必重新打包任何共享产物、也不必重启服务端。
 */

/** 难度档位（比产品难度多一个 hint，供交互式「提示」使用） */
export type PikaTier = 'easy' | 'medium' | 'hard' | 'hint';

/** 单个档位的引擎参数 */
export interface PikaTierConfig {
  multiPV: number;
  depth: number;
  movetimeMs: number;
  randomPick: boolean;
}

const TIERS: Record<PikaTier, PikaTierConfig> = {
  easy: { multiPV: 2, depth: 4, movetimeMs: 5000, randomPick: true },
  medium: { multiPV: 1, depth: 8, movetimeMs: 8000, randomPick: false },
  hard: { multiPV: 1, depth: 12, movetimeMs: 15000, randomPick: false },
  hint: { multiPV: 1, depth: 8, movetimeMs: 8000, randomPick: false },
};

/** 档位配置（只读拷贝，防止调用方意外改写全局定义） */
export function getPikaTier(tier: PikaTier): PikaTierConfig {
  const c = TIERS[tier];
  return c ? { ...c } : { ...TIERS.medium };
}

/**
 * 全部档位（只读遍历用，例如难度文案一致性测试）。
 *
 * 注：过去它的主要用途是给「两端档位一致性校验脚本」遍历比对；
 * 服务端去 AI 化后该校验脚本已删除，本导出保留给测试与未来的批量展示场景。
 */
export function allPikaTiers(): Array<[PikaTier, PikaTierConfig]> {
  return (Object.keys(TIERS) as PikaTier[]).map((k) => [k, { ...TIERS[k] }]);
}
