/**
 * 皮卡鱼档位（客户端）单测
 *
 * 档位的真正风险在**两端漂移**（联网 vs 断网棋力不一致且无报错），
 * 那由 chinese-chess-server/scripts/verify-pikafish-difficulty-parity.mjs 跨仓库校验。
 * 本测试负责客户端侧的**语义护栏**：档位形状、fallback 行为、确定性标记。
 */

import {
  getPikafishTier,
  getPikafishTierForDifficulty,
  isDeterministicTier,
  PIKAFISH_FALLBACK_TIER,
  type PikafishTier,
} from '../pikafishDifficulty';

const TIERS: PikafishTier[] = ['easy', 'medium', 'hard', 'hint'];

describe('皮卡鱼难度档位', () => {
  it('四个档位齐备，且字段完整', () => {
    for (const t of TIERS) {
      const c = getPikafishTier(t);
      expect(typeof c.multiPV).toBe('number');
      expect(c.multiPV).toBeGreaterThanOrEqual(1);
      expect(typeof c.depth).toBe('number');
      expect(c.depth).toBeGreaterThanOrEqual(1);
      expect(typeof c.movetimeMs).toBe('number');
      expect(c.movetimeMs).toBeGreaterThan(0);
      expect(typeof c.randomPick).toBe('boolean');
      expect(typeof c.label).toBe('string');
      expect(typeof c.desc).toBe('string');
    }
  });

  it('入门档：MultiPV 2 + 随机挑选（这是"能被击败"的关键）', () => {
    const c = getPikafishTier('easy');
    expect(c.multiPV).toBe(2);
    expect(c.randomPick).toBe(true);
  });

  it('进阶/大师/提示：MultiPV 1 纯最佳', () => {
    for (const t of ['medium', 'hard', 'hint'] as const) {
      expect(getPikafishTier(t).multiPV).toBe(1);
      expect(getPikafishTier(t).randomPick).toBe(false);
    }
  });

  it('棋力递进：easy ≤ medium < hard（按 depth）', () => {
    const easy = getPikafishTier('easy').depth;
    const medium = getPikafishTier('medium').depth;
    const hard = getPikafishTier('hard').depth;
    expect(easy).toBeLessThan(medium);
    expect(medium).toBeLessThan(hard);
  });

  it('easy 档的 movetime 必须远大于 depth 4 的实际耗时', () => {
    // 否则慢设备上会被墙钟截断到 depth 2~3，"入门"反而比原 TS AI 还弱
    const easy = getPikafishTier('easy');
    expect(easy.movetimeMs).toBeGreaterThanOrEqual(3000);
  });

  it('hint 档为确定性（提示必须可复现）', () => {
    expect(isDeterministicTier('hint')).toBe(true);
    expect(isDeterministicTier('easy')).toBe(false);
  });

  it('未知档位回落到 medium（绝不因参数问题让 AI 无法出棋）', () => {
    expect(PIKAFISH_FALLBACK_TIER).toBe('medium');
    const bad = getPikafishTier('nope' as PikafishTier);
    expect(bad.depth).toBe(getPikafishTier('medium').depth);
    expect(bad.multiPV).toBe(getPikafishTier('medium').multiPV);
  });

  it('按产品难度取档与直接取档一致', () => {
    expect(getPikafishTierForDifficulty('easy')).toEqual(getPikafishTier('easy'));
    expect(getPikafishTierForDifficulty('hard')).toEqual(getPikafishTier('hard'));
  });

  it('返回的是副本：外部改动不得污染全局定义', () => {
    const a = getPikafishTier('hard');
    a.depth = 999;
    expect(getPikafishTier('hard').depth).not.toBe(999);
  });
});
