/**
 * 回归测试：暗子池必须随局面演化（翻开/被吃都要扣池）
 *
 * 背景（2026-10 用户实测 bug）：
 *   池只在开局建一次、之后从不更新，导致走一步后
 *     「池=30，在盘暗子=29」⇒ assertPoolMatchesBoard 抛错
 *     ⇒ 引擎被静默跳过、回落 TS AI
 *     ⇒ 角标一直显示「揭棋引擎启动中」
 *   首步恰好 30=30 所以成功，第二步才暴露 —— 典型的状态演化遗漏。
 */

import { computePoolFromState, createDeterminization, declareCapturedIdentity, makeDeterministicRand } from '../jieqiDeterminization';
import { initialJieqiPool, poolTotal, liveHiddenCount, assertPoolMatchesBoard, toJieqiFen } from '../jieqiFen';
import { createJieqiInitialState, type JieqiIdentity } from '../jieqi';
import { makeMove } from '../GameEngine';
import type { GameState } from '../types';

function setup(seed = 12345): { state: GameState; identity: JieqiIdentity } {
  let s = seed;
  const rand = (n: number) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
  return createJieqiInitialState(rand);
}

/** 走一手红兵（a3a4 = row6 -> row5），会翻开一枚暗子 */
function moveOneHidden(state: GameState, identity: JieqiIdentity): GameState {
  // 找一个仍在盘的红方暗子，往前/旁走一格
  for (let id = 16; id < 32; id++) {
    const p = state.pieces[id];
    if (!p?.alive || state.hiddenMask?.[id] !== true) continue;
    for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const c = p.col + dc;
      const r = p.row + dr;
      if (c < 0 || c > 8 || r < 0 || r > 9) continue;
      try {
        const res = makeMove(state, id, c, r, identity);
        if (res?.newState?.qiPan[c][r] === id) return res.newState;
      } catch { /* 非法，继续 */ }
    }
  }
  throw new Error('找不到可走的暗子');
}

describe('暗子池必须随局面演化', () => {
  it('开局：池 30 == 在盘暗子 30', () => {
    const { state } = setup();
    const pool = computePoolFromState(state);
    expect(poolTotal(pool)).toBe(30);
    expect(liveHiddenCount(state)).toBe(30);
    expect(() => assertPoolMatchesBoard(state, pool)).not.toThrow();
  });

  it('走一步翻开暗子后：池必须减 1（**这是曾经的 bug**）', () => {
    const { state, identity } = setup();
    const after = moveOneHidden(state, identity);

    // 在盘暗子少了 1
    expect(liveHiddenCount(after)).toBe(29);

    // 关键断言：重算的池也必须是 29，而不是开局那份 30
    const pool = computePoolFromState(after);
    expect(poolTotal(pool)).toBe(29);

    // 自洽性：这正是 aiDispatcher 之前会抛错的地方
    expect(() => assertPoolMatchesBoard(after, pool)).not.toThrow();
  });

  it('连走多步：每步池都等于在盘暗子数', () => {
    const { state, identity } = setup(777);
    let cur = state;
    for (let i = 0; i < 8; i++) {
      try {
        cur = moveOneHidden(cur, identity);
      } catch {
        break; // 没有可走的暗子了
      }
      const pool = computePoolFromState(cur);
      expect(poolTotal(pool)).toBe(liveHiddenCount(cur));
    }
    expect(cur.moveHistory.length).toBeGreaterThan(0);
  });

  it('翻开扣除的是**真实棋种**（不是随便扣）', () => {
    const { state, identity } = setup(42);
    const after = moveOneHidden(state, identity);
    const rec = after.moveHistory[0];
    expect(rec.revealedType).toBeTruthy();

    const before = computePoolFromState(state);
    const now = computePoolFromState(after);

    // 被翻开的那一方的对应棋种计数应恰好 -1
    const isRed = rec.pieceId >= 16;
    const key = { che: 'R', ma: 'N', pao: 'C', shi: 'A', xiang: 'B', zu: 'p', bing: 'P' }[rec.revealedType!]!;
    const k = isRed ? key : key.toLowerCase();
    const side = isRed ? 'red' : 'black';
    expect((now as never)[side][k]).toBe((before as never)[side][k] - 1);
  });

  it('凭空声明被吃会让池小于在盘暗子数（说明声明必须与真实被吃对应）', () => {
    const { state, identity } = setup(99);
    const after = moveOneHidden(state, identity);

    // 人为声明 2 枚被吃，但盘面上并没有真的少 2 枚暗子
    const det = createDeterminization(1);
    const rand = makeDeterministicRand(1);
    declareCapturedIdentity(det, false, rand);
    declareCapturedIdentity(det, false, rand);

    const pool = computePoolFromState(after, det.capturedDeclared);
    // 池 = 在盘暗子(29) − 凭空声明(2) = 27
    // ⇒ 这正说明「声明」与「真实被吃」必须一一对应，
    //   否则池会偏小、assertPoolMatchesBoard 会拦下（这正是它存在的意义）。
    expect(poolTotal(pool)).toBe(liveHiddenCount(after) - 2);
    expect(() => assertPoolMatchesBoard(after, pool)).toThrow();
  });

  it('真实吃暗子后：池与盘面仍自洽（声明由历史重放产生）', () => {
    const { state, identity } = setup(31337);
    // 让红方去吃黑方一枚暗子：先找一个能吃到黑子的红子
    let cur = state;
    let captured = false;
    for (let id = 16; id < 32 && !captured; id++) {
      const p = cur.pieces[id];
      if (!p?.alive) continue;
      for (let c = 0; c < 9 && !captured; c++) {
        for (let r = 0; r < 10 && !captured; r++) {
          const target = cur.qiPan[c][r];
          if (target < 0 || target >= 16) continue; // 只吃黑子
          if (cur.hiddenMask?.[target] !== true) continue; // 只吃暗子
          try {
            const res = makeMove(cur, id, c, r, identity);
            if (res?.newState?.qiPan[c][r] === id) {
              cur = res.newState;
              captured = true;
            }
          } catch { /* 非法 */ }
        }
      }
    }
    if (!captured) return; // 该局面没有可吃的暗子，跳过

    // 走完这手后，在盘暗子应减少 2（自己翻开 1 + 被吃 1）
    const live = liveHiddenCount(cur);
    // 池（仅扣已翻开，不扣被吃）会多出 1 ⇒ 需要声明补齐
    const poolNoDecl = computePoolFromState(cur);
    expect(poolTotal(poolNoDecl)).toBe(live + 1);

    // 用声明补齐后自洽
    const det = createDeterminization(7);
    const rand = makeDeterministicRand(7);
    declareCapturedIdentity(det, false, rand); // 声明 1 枚被吃
    const pool = computePoolFromState(cur, det.capturedDeclared);
    expect(poolTotal(pool)).toBe(live);
    expect(() => assertPoolMatchesBoard(cur, pool)).not.toThrow();
  });

  it('池与盘面自洽时，FEN 可正常编码（端到端不抛错）', () => {
    const { state, identity } = setup(2024);
    const after = moveOneHidden(state, identity);
    const pool = computePoolFromState(after);
    expect(() => toJieqiFen(after, pool)).not.toThrow();
    const fen = toJieqiFen(after, pool);
    // 第 3 段池非空
    const seg3 = fen.split(' ')[2];
    expect(seg3.length).toBeGreaterThan(0);
    expect(/x/i.test(seg3)).toBe(false);
  });

  it('初始池与重算池在开局时逐项相等', () => {
    const { state } = setup(5);
    const a = initialJieqiPool();
    const b = computePoolFromState(state);
    expect(b).toEqual(a);
  });
});
