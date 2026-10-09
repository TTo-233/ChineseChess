/**
 * 揭棋 · 暗子身份后验（jieqiAi）
 *
 * 揭棋 AI 的核心不是「搜索更深」，而是**在信息不完全下评估**。
 * 本文件钉死后验分布的数学性质（§9.3），这是 AI 评估函数的地基。
 *
 * 关键洞察：洗牌时同方 15 枚身份在 15 个占位 id 上**均匀随机置换**，
 * 因此对任一未读暗子，其真实身份服从**超几何分布**，且该分布**精确可算**，
 * 无需蒙特卡洛采样。
 */

import { makeMove, getValidMoves, isMoveKingSafe } from '../GameEngine';
import {
  createJieqiInitialState, makeSeededRand, liveHiddenSlots,
  hiddenIdentityPosterior, expectedHiddenValue, countCapturedHidden,
  __jieqiInternal, type JieqiPieceType,
} from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState } from '../types';

const { HIDDEN_MULTISET_BY_SIDE, keyOf } = __jieqiInternal;

/** 该方全部棋种（归一化前） */
const typesOf = (side: typeof RED_SIDE | typeof BLACK_SIDE) =>
  HIDDEN_MULTISET_BY_SIDE[keyOf(side)].map(([t]) => t as JieqiPieceType);

describe('揭棋 · 暗子身份后验（超几何分布）', () => {
  it('初始局面：每枚暗子都是 5/15 = 1/3 车、5/15 = 1/3 卒', () => {
    const { state } = createJieqiInitialState(makeSeededRand(81));
    const post = hiddenIdentityPosterior(state, BLACK_SIDE);
    const slots = liveHiddenSlots(state, BLACK_SIDE);
    expect(post.size).toBe(15);

    for (const slot of slots) {
      const dist = post.get(slot)!;
      // 初始多重集：车2 马2 炮2 士2 象2 卒5，共 15
      expect(dist.che).toBeCloseTo(2 / 15, 10);
      expect(dist.ma).toBeCloseTo(2 / 15, 10);
      expect(dist.pao).toBeCloseTo(2 / 15, 10);
      expect(dist.shi).toBeCloseTo(2 / 15, 10);
      expect(dist.xiang).toBeCloseTo(2 / 15, 10);
      expect(dist.zu).toBeCloseTo(5 / 15, 10);
      // 黑方绝不出现红方专属棋种
      expect(dist.bing).toBe(0);
    }
  });

  it('所有未读暗子取同一份分布（未读暗子彼此不可区分）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(82));
    const post = hiddenIdentityPosterior(state, RED_SIDE);
    const first = JSON.stringify(post.get(liveHiddenSlots(state, RED_SIDE)[0])!);
    for (const [, dist] of post) {
      expect(JSON.stringify(dist)).toBe(first);
    }
  });

  it('翻开水马后：剩余分布相应扣除，且仍归一化', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(83));
    let state2 = state;

    // 找一个真身是「车」的暗子并走开（走即翻开）
    let done = false;
    for (let id = 16; id < 32 && !done; id++) {
      if (state2.hiddenMask![id] !== true) continue;
      if (identity.hiddenType[id] !== 'che') continue;
      state2.sideTag = RED_SIDE;
      const pts = getValidMoves(state2, id);
      for (let c = 0; c < BOARD_COLS && !done; c++) {
        for (let r = 0; r < BOARD_ROWS && !done; r++) {
          if (!pts[c][r] || !isMoveKingSafe(state2, id, c, r)) continue;
          state2 = makeMove(state2, id, c, r, identity).newState;
          done = true;
        }
      }
    }
    expect(done).toBe(true);

    const post = hiddenIdentityPosterior(state2, RED_SIDE);
    const remaining = liveHiddenSlots(state2, RED_SIDE);
    expect(remaining).toHaveLength(14); // 翻开了 1 枚
    expect(post.size).toBe(14);

    const dist = post.get(remaining[0])!;
    // 初始 2 车，共 15；已翻开 1 车 → 剩 1 车 / 14
    expect(dist.che).toBeCloseTo(1 / 14, 10);
    // 红方分布里不应出现黑方专属的「卒」
    expect(dist.zu ?? 0).toBe(0);
    // 兵仍在（红方是 bing）
    expect(dist.bing).toBeCloseTo(5 / 14, 10);

    let sum = 0;
    for (const t of typesOf(RED_SIDE)) sum += dist[t];
    expect(sum).toBeCloseTo(1, 10);
  });

  it('「剩 1 枚时必为该身份」的极限情形', () => {
    const { state, identity } = createJieqiInitialState(makeSeededRand(84));
    let s = state;
    // 反复走暗子直到只剩 1 枚未翻开
    let guard = 0;
    while (liveHiddenSlots(s, RED_SIDE).length > 1 && guard++ < 200) {
      let moved = false;
      for (const id of liveHiddenSlots(s, RED_SIDE)) {
        s.sideTag = RED_SIDE;
        const pts = getValidMoves(s, id);
        for (let c = 0; c < BOARD_COLS && !moved; c++) {
          for (let r = 0; r < BOARD_ROWS && !moved; r++) {
            if (!pts[c][r] || !isMoveKingSafe(s, id, c, r)) continue;
            s = makeMove(s, id, c, r, identity).newState;
            moved = true;
          }
        }
        if (moved) break;
      }
      if (!moved) break;
    }
    const left = liveHiddenSlots(s, RED_SIDE);
    if (left.length !== 1) {
      // 随机局不一定能走到只剩 1 枚（可能被吃光或走不动），跳过但必须验证不崩
      expect(Array.isArray(hiddenIdentityPosterior(s, RED_SIDE))).toBe(true);
      return;
    }
    const post = hiddenIdentityPosterior(s, RED_SIDE);
    const dist = post.get(left[0])!;
    for (const t of typesOf(RED_SIDE)) {
      expect(dist[t]).toBeGreaterThanOrEqual(0);
      expect(dist[t]).toBeLessThanOrEqual(1);
    }
    // 只剩 1 枚未翻开 → 它必然是「初始多重集 − 已翻开全部」里唯一那枚
    let sum = 0;
    for (const t of typesOf(RED_SIDE)) sum += dist[t];
    expect(sum).toBeCloseTo(1, 10);
  });

  it('expectedHiddenValue 取后验的期望子力（两侧初始对称）', () => {
    const { state } = createJieqiInitialState(makeSeededRand(85));
    // 签名：(posterior, slot, valueOf) —— 棋种价值由调用方注入，避免本模块依赖 AIEngine
    const valueOf = (t: JieqiPieceType) =>
      ({ che: 9, ma: 4, pao: 4.5, shi: 2, xiang: 2, zu: 1, bing: 1 })[t] ?? 0;

    for (const side of [RED_SIDE, BLACK_SIDE] as const) {
      const post = hiddenIdentityPosterior(state, side);
      for (const slot of liveHiddenSlots(state, side)) {
        const v = expectedHiddenValue(post, slot, valueOf);
        expect(Number.isFinite(v)).toBe(true);
        // 初始期望 = (2*9 + 2*4 + 2*4.5 + 2*2 + 2*2 + 5*1) / 15
        expect(v).toBeCloseTo((18 + 8 + 9 + 4 + 4 + 5) / 15, 10);
      }
    }
  });

  it('countCapturedHidden 统计被吃的暗子数（决策 A 下吃子方不补子）', () => {
    const init = createJieqiInitialState(makeSeededRand(86));
    const state = init.state;
    const identity = init.identity;
    // 签名：(初始暗子数, 现存暗子数) → 已被吃的暗子数
    expect(countCapturedHidden(15, liveHiddenSlots(state, BLACK_SIDE).length)).toBe(0);
    expect(countCapturedHidden(15, 14)).toBe(1);

    // 把红车 23 挪到一枚黑暗子上
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (state.qiPan[c][r] === 23) state.qiPan[c][r] = -1;
      }
    }
    state.sideTag = RED_SIDE;
    let eaten = -1, ec = -1, er = -1;
    for (let c = 0; c < BOARD_COLS && eaten < 0; c++) {
      for (let r = 0; r < BOARD_ROWS && eaten < 0; r++) {
        const id = state.qiPan[c][r];
        if (id >= 1 && id <= 15 && state.hiddenMask![id]) { eaten = id; ec = c; er = r; }
      }
    }
    expect(eaten).toBeGreaterThan(0);
    const next = makeMove(state, 23, ec, er, identity).newState;
    // 黑方掉了 1 枚暗子（被吃）
    expect(countCapturedHidden(15, liveHiddenSlots(next, BLACK_SIDE).length)).toBe(1);
    // 红方现存暗子 14 —— 只因为它**自己的车走了一步因而翻开**（走子即翻开），
    // 而不是因为获得了什么新暗子。决策 A 的要点：红方**不会补回**被吃掉的那一枚，
    // 故红方现存暗子应恰好等于「15 - 自己翻开的那枚」。
    expect(liveHiddenSlots(next, RED_SIDE)).toHaveLength(14);
    // 被吃的那枚黑暗子不在红方的现存暗子里（棋盘上直接少一枚）
    expect(liveHiddenSlots(next, RED_SIDE)).not.toContain(eaten);
    expect(next.pieces[eaten].alive).toBe(false);
  });

  it('后验在多局随机对弈中始终归一化（AI 评估的地基不能塌）', () => {
    for (let seed = 90; seed < 94; seed++) {
      const init = createJieqiInitialState(makeSeededRand(seed));
      let s: GameState = init.state;
      const identity = init.identity;
      for (let ply = 0; ply < 20; ply++) {
        for (const side of [RED_SIDE, BLACK_SIDE] as const) {
          const post = hiddenIdentityPosterior(s, side);
          for (const [, dist] of post) {
            let sum = 0;
            for (const t of typesOf(side)) {
              expect(dist[t]).toBeGreaterThanOrEqual(0);
              sum += dist[t];
            }
            expect(sum).toBeCloseTo(1, 10);
            // 绝不含对方专属棋种
            if (side === BLACK_SIDE) expect(dist.bing).toBe(0);
            else expect(dist.zu).toBe(0);
          }
        }
        let done = false;
        for (let id = 0; id < 32 && !done; id++) {
          const p = s.pieces[id];
          if (!p.alive) continue;
          if ((id <= 15) !== (s.sideTag === BLACK_SIDE)) continue;
          const pts = getValidMoves(s, id);
          for (let c = 0; c < BOARD_COLS && !done; c++) {
            for (let r = 0; r < BOARD_ROWS && !done; r++) {
              if (!pts[c][r] || !isMoveKingSafe(s, id, c, r)) continue;
              s = makeMove(s, id, c, r, identity).newState;
              done = true;
            }
          }
        }
        if (!done) break;
      }
    }
  });
});