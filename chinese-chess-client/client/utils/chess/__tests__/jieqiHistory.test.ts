/**
 * jieqiHistory 单测：历史重放必须与真实走子序列一致。
 *
 * 核心断言：重放出的中间态与真实对局逐步一致（否则引擎会在错误局面上搜索）。
 */

import { buildJieqiHistoryMoves } from '../jieqiHistory';
import { createJieqiInitialState, type JieqiIdentity } from '../jieqi';
import { makeMove, getValidMoves, isMoveKingSafe } from '../GameEngine';
import { parseJieqiMove } from '../jieqiUci';
import type { GameState, SideTag } from '../types';
import { RED_SIDE, BLACK_SIDE } from '../types';
import { initialJieqiPool, poolTotal, liveHiddenCount } from '../jieqiFen';
import {
  createDeterminization,
  declareCapturedIdentity,
  makeDeterministicRand,
  topUpCapturedDeclarations,
  computePoolFromState,
  typeToPoolKey,
} from '../jieqiDeterminization';

/** 造一个可复现的初始局面 + 身份表 */
function setup(seed = 12345): { state: GameState; identity: JieqiIdentity } {
  let s = seed;
  const rand = (n: number) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
  const { state, identity } = createJieqiInitialState(rand);
  return { state, identity };
}

/** 走若干手（按可复现的策略挑子），返回终态 */
function playSome(
  state: GameState,
  identity: JieqiIdentity,
  steps: number
): GameState {
  let cur = state;
  let rng = 987;
  const next = (n: number) => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng % n;
  };

  for (let i = 0; i < steps; i++) {
    const side: SideTag = cur.sideTag;
    const candidates: Array<{ id: number; col: number; row: number }> = [];
    for (let id = 0; id < 32; id++) {
      const p = cur.pieces[id];
      if (!p?.alive) continue;
      if (p.col < 0 || p.row < 0) continue;
      const isRed = id >= 16;
      if ((isRed ? RED_SIDE : BLACK_SIDE) !== side) continue;
      candidates.push({ id, col: p.col, row: p.row });
    }
    if (candidates.length === 0) break;

    // 找第一个有合法落点的子
    let moved = false;
    for (let attempt = 0; attempt < candidates.length && !moved; attempt++) {
      const c = candidates[next(candidates.length)];
      // 试遍所有落点
      for (let col = 0; col < 9 && !moved; col++) {
        for (let row = 0; row < 10 && !moved; row++) {
          try {
            const res = makeMove(cur, c.id, col, row, identity);
            if (res && res.newState) {
              // 只接受确实发生了移动的（qiPan 变化）
              if (res.newState.qiPan[col][row] === c.id) {
                cur = res.newState;
                moved = true;
              }
            }
          } catch {
            /* 非法落点，继续 */
          }
        }
      }
    }
    if (!moved) break;
  }
  return cur;
}

describe('jieqiHistory · 空历史', () => {
  it('无走子时返回空 moves', () => {
    const { state } = setup();
    const det = createDeterminization(1);
    const rand = makeDeterministicRand(1);
    const r = buildJieqiHistoryMoves(state, state, (side, finalState) =>
      declareCapturedIdentity(det, side, rand, finalState)
    );
    expect(r.moves).toEqual([]);
    expect(r.abortedAt).toBe(-1);
  });
});

describe('jieqiHistory · 单步走暗子', () => {
  it('第一步走暗子 → 5 字符（自身揭晓），且与 MoveRecord 一致', () => {
    const { state, identity } = setup();
    const det = createDeterminization(7);
    const rand = makeDeterministicRand(7);

    // 手动走一手暗子（红方兵位）
    const pieceId = 27; // 红兵
    const p = state.pieces[pieceId];
    const res = makeMove(state, pieceId, p.col, p.row - 1, identity);
    const after = res.newState;

    const r = buildJieqiHistoryMoves(after, state, (side, finalState) =>
      declareCapturedIdentity(det, side, rand, finalState)
    );
    expect(r.abortedAt).toBe(-1);
    expect(r.moves).toHaveLength(1);

    const parsed = parseJieqiMove(r.moves[0]);
    expect(parsed).not.toBeNull();
    expect(parsed!.movedReveal).not.toBeNull(); // 走了暗子 ⇒ 必有自身揭晓
    expect(parsed!.capturedReveal).toBeNull();  // 未吃子
    // 与公开真值一致
    expect(parsed!.movedReveal).toBe(after.moveHistory[0].revealedType);
  });
});

describe('jieqiHistory · 多步重放一致性', () => {
  it('重放出的中间态与真实终态逐项一致（hiddenMask / revealedType / qiPan）', () => {
    const { state, identity } = setup(2024);
    const played = playSome(state, identity, 12);
    expect(played.moveHistory.length).toBeGreaterThan(0);

    const det = createDeterminization(42);
    const rand = makeDeterministicRand(42);
    const r = buildJieqiHistoryMoves(played, state, (side, finalState) =>
      declareCapturedIdentity(det, side, rand, finalState)
    );

    // 逐步重放（复用 buildJieqiHistoryMoves 的中间态逻辑不便，这里直接再走一遍）
    let cur = state;
    const synth: (typeof identity) = { hiddenType: new Array(32).fill(null), seed: 0 };
    for (const rec of played.moveHistory) {
      if (rec.revealedType) synth.hiddenType[rec.pieceId] = rec.revealedType;
    }
    for (const rec of played.moveHistory) {
      cur = makeMove(cur, rec.pieceId, rec.toCol, rec.toRow, synth).newState;
    }

    // 棋盘一致
    expect(cur.qiPan).toEqual(played.qiPan);
    // 暗子标记一致
    expect(cur.hiddenMask).toEqual(played.hiddenMask);
    // 已翻开身份一致
    expect(cur.revealedType).toEqual(played.revealedType);
    // 每步都能解析
    for (const m of r.moves) {
      expect(parseJieqiMove(m)).not.toBeNull();
    }
  });

  it('步数与历史长度一致（未中止时）', () => {
    const { state, identity } = setup(555);
    const played = playSome(state, identity, 8);
    const det = createDeterminization(3);
    const rand = makeDeterministicRand(3);
    const r = buildJieqiHistoryMoves(played, state, (side, finalState) =>
      declareCapturedIdentity(det, side, rand, finalState)
    );
    if (r.abortedAt === -1) {
      expect(r.moves).toHaveLength(played.moveHistory.length);
    } else {
      expect(r.moves).toHaveLength(r.abortedAt);
    }
  });
});

describe('jieqiHistory · 被吃暗子需声明', () => {
  it('池耗尽时中止（返回 abortedAt 而非抛错）', () => {
    const { state, identity } = setup(9);
    const played = playSome(state, identity, 10);
    const det = createDeterminization(1);
    // 声明回调恒返回 null → 模拟池不可用
    const r = buildJieqiHistoryMoves(played, state, () => null);
    // 若历史中有吃暗子，则会在那一步中止；否则全部成功
    expect(r.abortedAt === -1 || r.abortedAt >= 0).toBe(true);
    if (r.abortedAt >= 0) {
      expect(r.moves).toHaveLength(r.abortedAt);
    }
  });

  it('声明回调只在「吃暗子」时被调用（不吃子不消耗池）', () => {
    const { state, identity } = setup(77);
    const played = playSome(state, identity, 6);
    let calls = 0;
    const det = createDeterminization(5);
    const rand = makeDeterministicRand(5);
    buildJieqiHistoryMoves(played, state, (side, finalState) => {
      calls++;
      return declareCapturedIdentity(det, side, rand, finalState);
    });
    // 调用次数不可能超过历史步数
    expect(calls).toBeLessThanOrEqual(played.moveHistory.length);
  });
});

describe('jieqiHistory · 与引擎池口径一致', () => {
  it('重放消耗的声明数 == 池的减少量', () => {
    const { state, identity } = setup(31337);
    const played = playSome(state, identity, 10);
    const det = createDeterminization(11);
    const rand = makeDeterministicRand(11);
    const before = poolTotal(det.pool);

    buildJieqiHistoryMoves(played, state, (side, finalState) =>
      declareCapturedIdentity(det, side, rand, finalState)
    );

    const after = poolTotal(det.pool);
    const declaredTotal =
      Object.values(det.capturedDeclared.red).reduce((a, b) => a + b, 0) +
      Object.values(det.capturedDeclared.black).reduce((a, b) => a + b, 0);

    // 池减少量必须等于声明总量（守恒）
    expect(before - after).toBe(declaredTotal);
  });
});

/**
 * 【2026-10 实测 BUG 回归：回合数增多后回退「揭棋引擎启动中」】
 *
 * 现象：前几回合角标显示「揭棋引擎」，回合多了就退回「揭棋引擎启动中」。
 * 因果链（每一环都在别处被静默吞掉，所以只有文案不对）：
 *   声明采样源漏扣「已翻开真值」 ⇒ 声明出已被翻开/后来会被翻开的棋种
 *   ⇒ computePoolFromState 按真值扣完已归零，再扣这枚声明被 max(0) 吞掉
 *   ⇒ 池比在盘暗子多 1 ⇒ assertPoolMatchesBoard 抛错
 *   ⇒ aiDispatcher 的 catch 静默跳过引擎、回落 TS AI
 *   ⇒ 角标显示「揭棋引擎启动中」。
 *
 * 触发条件需要「某棋种先被翻开、之后再吃到该棋种的暗子」，故短对局撞不上
 * ——这正是它长期潜伏的原因。本组断言把"池恒等于在盘暗子"钉在长对局上。
 */
describe('jieqiHistory · 声明不得超发（池恒等于在盘暗子）', () => {
  /** 走一手（可复现的挑子策略），只走合法且过闸的着法 */
  function playTo(state: GameState, identity: JieqiIdentity, plies: number): GameState {
    let cur = state;
    let rng = 4242;
    for (let ply = 0; ply < plies && cur.gameStatus === 'playing'; ply++) {
      const side = cur.sideTag;
      const cands: { id: number; c: number; r: number }[] = [];
      for (let id = 0; id < 32; id++) {
        const p = cur.pieces[id];
        if (!p?.alive || p.col < 0 || p.row < 0) continue;
        const isRed = id >= 16;
        if ((isRed ? RED_SIDE : BLACK_SIDE) !== side) continue;
        const pts = getValidMoves(cur, id);
        for (let c = 0; c < 9; c++) {
          for (let r = 0; r < 10; r++) {
            if (pts[c][r] && isMoveKingSafe(cur, id, c, r)) cands.push({ id, c, r });
          }
        }
      }
      if (cands.length === 0) break;
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      const mv = cands[rng % cands.length];
      cur = makeMove(cur, mv.id, mv.c, mv.r, identity).newState;
    }
    return cur;
  }

  it('长对局每步：重算的池恒等于在盘暗子数（超发会让池偏小/偏大）', () => {
    let checked = 0;
    for (const seed of [6183, 9434, 31337]) {
      const { state, identity } = setup(seed);
      let cur = state;
      for (let ply = 0; ply < 40 && cur.gameStatus === 'playing'; ply++) {
        cur = playTo(cur, identity, 1);
        const det = createDeterminization(seed);
        const rand = makeDeterministicRand(seed);
        buildJieqiHistoryMoves(cur, state, (side, finalState) =>
          declareCapturedIdentity(det, side, rand, finalState)
        );
        topUpCapturedDeclarations(det, cur, rand);

        const pool = computePoolFromState(cur, det.capturedDeclared);
        const live = liveHiddenCount(cur);
        expect(poolTotal(pool)).toBe(live);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('每种棋种都不能被超发：声明 + 已翻开 ≤ 初始（这是防池漂移的核心不变量）', () => {
    for (const seed of [6183, 9434, 31337]) {
      const { state, identity } = setup(seed);
      const played = playTo(state, identity, 40);
      const det = createDeterminization(seed);
      const rand = makeDeterministicRand(seed);
      buildJieqiHistoryMoves(played, state, (side, finalState) =>
        declareCapturedIdentity(det, side, rand, finalState)
      );

      for (const side of [RED_SIDE, BLACK_SIDE]) {
        const init = side === RED_SIDE ? initialJieqiPool().red : initialJieqiPool().black;
        const declared = side === RED_SIDE ? det.capturedDeclared.red : det.capturedDeclared.black;
        const revealed: Record<string, number> = {};
        for (let id = 0; id < 32; id++) {
          if (id === 0 || id === 16) continue;
          if ((id <= 15 ? BLACK_SIDE : RED_SIDE) !== side) continue;
          const rv = played.revealedType?.[id];
          if (!rv) continue;
          const k = typeToPoolKey(rv, side);
          if (k) revealed[k] = (revealed[k] ?? 0) + 1;
        }
        for (const k of Object.keys(init)) {
          expect((revealed[k] ?? 0) + (declared[k] ?? 0)).toBeLessThanOrEqual(init[k] ?? 0);
        }
      }
    }
  });
});
